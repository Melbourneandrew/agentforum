// Actual COMPLETE built Worker/Static Assets and versioned native LOCAL D1.
// No provider, no production readiness, no source-pairing authorization change.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { Agent, request as httpsRequest } from "node:https";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { Effect, Either, Option, Schema } from "effect";
import { expect, it } from "vitest";
import { Identity, failure } from "./model.js";
import { decodeConfig, prepareTarget } from "./release-config.js";
import {
  captureArchive,
  materializeArchive,
  verifyMaterializedArchive,
} from "./release-archive.js";
import {
  observeArchivePair,
  stopAfterAcknowledgedMigration,
} from "./release-qualification.js";
import { localControls } from "./control-local.js";
import {
  bootstrapControl,
  NativeControlMigrations,
} from "./control-bootstrap.js";
import {
  ControlDatabase,
  makeControlCoordinator,
  readControl,
} from "./release-control.js";
import { ReleaseCoordinator, ReleasePorts } from "./release-model.js";
import { inspectInstalled, physicalStates } from "./remote-state.js";
import { release } from "./release.js";
import {
  RegistrationResult,
  PostResult,
  PostPageResult,
} from "../../apps/forum/src/api/contracts.js";
const exec = promisify(execFile);
it("complete archived Worker retains data on exact newer native schema; real control ACK stop precedes activation and retry", async () => {
  const root = process.cwd(),
    state = await mkdtemp(join(tmpdir(), "wo34-complete-archive-"));
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: state,
    XDG_CONFIG_HOME: state,
    CI: "true",
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
    WRANGLER_SEND_METRICS: "false",
    WRANGLER_LOG_PATH: join(state, "wrangler.log"),
    WRANGLER_RESOURCES_PROVISION: "false",
  };
  const wrangler = resolve("apps/forum/node_modules/wrangler/bin/wrangler.js");
  const run = async (args: string[]) =>
    (
      await exec(
        process.execPath,
        [wrangler, ...args, "--env-file", "/dev/null"],
        { cwd: root, env, timeout: 60000, maxBuffer: 8 * 1024 * 1024 },
      )
    ).stdout;
  let child: ChildProcess | undefined, tls: Agent | undefined;
  const running = (value: ChildProcess) =>
    value.exitCode === null && value.signalCode === null;
  const stop = async () => {
    const active = child;
    if (!active || !running(active)) {
      child = undefined;
      return;
    }
    const exited = once(active, "exit");
    active.kill("SIGTERM");
    await Promise.race([exited, delay(3000)]);
    if (running(active)) active.kill("SIGKILL");
    await exited;
    child = undefined;
  };
  try {
    // Exactly one fresh complete build for this new qualification, never a cached
    // infrastructure result or the small origin-only fixture.
    await exec("pnpm", ["build", "--force"], {
      cwd: root,
      env,
      timeout: 180000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const sourceRevision = (
      await exec("git", ["rev-parse", "HEAD"], { cwd: root, env })
    ).stdout.trim();
    const identity = Schema.decodeUnknownSync(Identity)({
      version: 1,
      accountId: "a".repeat(32),
      workerName: "archive-local-forum",
      databaseName: "archive-local-db",
      databaseId: "11111111-1111-1111-1111-111111111111",
      defaultOrigin: "https://archive-local-forum.fixture.workers.dev",
    });
    const builtConfig = join(root, "apps/forum/dist/server/wrangler.json");
    const raw = await Effect.runPromise(
      decodeConfig(await readFile(builtConfig, "utf8")),
    );
    const original = await Effect.runPromise(
      prepareTarget({
        raw,
        builtConfig,
        output: join(state, "original.json"),
        identity,
        sourceRevision,
        authorizeTarget: true,
      }),
    );
    const migrationSources = await Promise.all(
      original.artifact.migrations.map(async (migration) => ({
        path: `apps/forum/migrations/${migration.name}`,
        bytes: await readFile(
          join(root, "apps/forum/migrations", migration.name),
        ),
      })),
    );
    const statesA = await Effect.runPromise(physicalStates(migrationSources));
    const completeA = statesA.at(-1);
    if (!completeA) throw new Error("Missing native state");
    const preparedOriginal = {
      ...original,
      artifact: {
        ...original.artifact,
        schemaDigest: completeA.physicalDigest,
      },
    };
    const archive = await Effect.runPromise(
      captureArchive({
        repository: root,
        prepared: preparedOriginal,
        directory: join(state, "archive"),
      }),
    );
    const prepared = await Effect.runPromise(
      materializeArchive({
        archive,
        output: join(state, "target.json"),
        approvedApplicationSource: sourceRevision,
      }),
    );
    await writeFile(
      prepared.artifact.configPath,
      JSON.stringify(prepared.target),
      { mode: 0o600 },
    );
    expect(prepared.artifact.artifactDigest).not.toBe(
      original.artifact.artifactDigest,
    );
    const controls = await localControls({ prepared, root, state, run });
    await Effect.runPromise(
      bootstrapControl().pipe(
        Effect.provideService(ControlDatabase, controls.database),
        Effect.provideService(NativeControlMigrations, controls.bootstrap),
      ),
    );
    const persist = join(state, "d1"),
      nativeConfig = [
        "--config",
        prepared.artifact.configPath,
        "--persist-to",
        persist,
      ];
    const certificate = join(state, "certificate.pem"),
      key = join(state, "key.pem");
    await exec(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        key,
        "-out",
        certificate,
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=IP:127.0.0.1,DNS:localhost",
      ],
      { env, timeout: 10000 },
    );
    tls = new Agent({ ca: await readFile(certificate) });
    const socket = createServer();
    socket.listen(0, "127.0.0.1");
    await once(socket, "listening");
    const address = socket.address();
    if (!address || typeof address === "string")
      throw new Error("Missing port");
    const port = address.port;
    await new Promise<void>((success, reject) =>
      socket.close((error) => {
        if (error) reject(error);
        else success();
      }),
    );
    const base = `https://127.0.0.1:${String(port)}`;
    const request = async (path: string, init?: RequestInit) => {
      const incoming = new Request(`${base}${path}`, init),
        url = new URL(incoming.url);
      if (url.origin !== base) throw new Error("Nonlocal fixture transport");
      const body =
        incoming.method === "GET" || incoming.method === "HEAD"
          ? undefined
          : Buffer.from(await incoming.arrayBuffer());
      return new Promise<Response>((success, reject) => {
        const outgoing = httpsRequest(
          url,
          {
            method: incoming.method,
            headers: Object.fromEntries(incoming.headers),
            agent: tls,
            signal: AbortSignal.timeout(10000),
          },
          (response) => {
            const chunks: Buffer[] = [];
            let bytes = 0;
            response.on("data", (chunk: Buffer) => {
              bytes += chunk.length;
              if (bytes > 1024 * 1024)
                outgoing.destroy(new Error("Local response limit"));
              else chunks.push(chunk);
            });
            response.on("error", reject);
            response.on("end", () => {
              const headers = new Headers();
              for (const [name, value] of Object.entries(response.headers)) {
                if (typeof value === "string") headers.set(name, value);
                else if (Array.isArray(value))
                  for (const item of value) headers.append(name, item);
              }
              success(
                new Response(Buffer.concat(chunks), {
                  status: response.statusCode ?? 500,
                  headers,
                }),
              );
            });
          },
        );
        outgoing.on("error", reject);
        outgoing.end(body);
      });
    };
    const start = async () => {
      await Effect.runPromise(
        verifyMaterializedArchive(archive, prepared.artifact),
      );
      child = spawn(
        process.execPath,
        [
          wrangler,
          "dev",
          "--local",
          "--no-bundle",
          ...nativeConfig,
          "--ip",
          "127.0.0.1",
          "--port",
          String(port),
          "--inspector-port",
          "0",
          "--local-protocol",
          "https",
          "--local-upstream",
          `127.0.0.1:${String(port)}`,
          "--upstream-protocol",
          "https",
          "--var",
          `CANONICAL_ORIGIN:${base}`,
          "--https-cert-path",
          certificate,
          "--https-key-path",
          key,
          "--env-file",
          "/dev/null",
        ],
        { cwd: root, env, stdio: "ignore" },
      );
      for (let attempt = 0; attempt < 100; attempt++) {
        if (!running(child)) throw new Error("Local Worker exited");
        const response = await request("/v1/search?payload=%7B%7D").catch(
          () => undefined,
        );
        if (response?.status === 200) {
          await response.body?.cancel();
          return;
        }
        await response?.body?.cancel();
        await delay(100);
      }
      throw new Error("Local Worker unavailable");
    };
    let activations = 0,
      stopped = 0;
    const ports: typeof ReleasePorts.Service = {
      build: () => Effect.succeed(prepared.artifact),
      verify: () => verifyMaterializedArchive(archive, prepared.artifact),
      installed: () =>
        inspectInstalled(prepared.artifact, statesA, controls.database),
      migrate: (artifact, token) =>
        Effect.tryPromise({
          try: () =>
            run([
              "d1",
              "migrations",
              "apply",
              "DB",
              "--local",
              ...nativeConfig,
            ]),
          catch: () =>
            failure("initialization", "local-native-migration-unknown"),
        }).pipe(
          Effect.zipRight(
            inspectInstalled(artifact, statesA, controls.database),
          ),
          Effect.map((installed) => {
            expect(installed.schemaDigest).toBe(completeA.physicalDigest);
            return {
              ...token,
              identity,
              sourceRevision,
              artifactDigest: artifact.artifactDigest,
              operationRef: "native:local:tracked-migrations",
              outcome: "succeeded" as const,
            };
          }),
        ),
      activate: (artifact, token) =>
        Effect.tryPromise({
          try: async () => {
            await start();
            activations++;
            return {
              activation: {
                sourceRevision,
                artifactDigest: artifact.artifactDigest,
                version: "local-workerd-not-provider-version",
              },
              receipt: {
                ...token,
                identity,
                sourceRevision,
                artifactDigest: artifact.artifactDigest,
                operationRef: "native:local:worker-started",
                outcome: "succeeded" as const,
              },
            };
          },
          catch: () => failure("deployment", "local-worker-start-unknown"),
        }),
      readiness: () =>
        Effect.fail(
          failure(
            "readiness",
            "local-qualification-not-installation-readiness",
          ),
        ),
    };
    const execute = async (
      selected: typeof ReleasePorts.Service,
      ownerId: string,
      executorRef: string,
    ) => {
      const coordinator = await Effect.runPromise(
        makeControlCoordinator({
          artifact: prepared.artifact,
          ownerId,
          executorRef,
        }).pipe(Effect.provideService(ControlDatabase, controls.database)),
      );
      return Effect.runPromise(
        Effect.either(
          release({ identity, sourceRevision, operation: "update" }).pipe(
            Effect.provideService(ReleasePorts, selected),
            Effect.provideService(ReleaseCoordinator, coordinator),
            Effect.provideService(ControlDatabase, controls.database),
          ),
        ),
      );
    };
    const executorRef = "local:archive:acknowledged-stop";
    const stoppedPorts = stopAfterAcknowledgedMigration({
      ports,
      database: controls.database,
      executorRef,
      stopped: Effect.sync(() => {
        stopped++;
        expect(activations).toBe(0);
      }),
    });
    const failed = await execute(
      stoppedPorts,
      "33333333-3333-3333-3333-333333333333",
      executorRef,
    );
    expect(Either.isLeft(failed) && failed.left.code).toBe(
      "initialized-schema-unverified",
    );
    expect(stopped).toBe(1);
    expect(activations).toBe(0);
    const closed = await Effect.runPromise(readControl(controls.database));
    expect(Option.isSome(closed) && closed.value.phase).toBe("idle");
    expect(
      (
        await Effect.runPromise(
          inspectInstalled(prepared.artifact, statesA, controls.database),
        )
      ).schemaDigest,
    ).toBe(completeA.physicalDigest);
    const retry = await execute(
      ports,
      "44444444-4444-4444-4444-444444444444",
      "local:archive:retry",
    );
    expect(Either.isLeft(retry) && retry.left.stage).toBe("readiness");
    expect(activations).toBe(1);
    const call = (
      operation: string,
      input: unknown,
      method = "POST",
      apiKey = "",
    ) => {
      const payload = JSON.stringify(input);
      return request(
        `/v1/${operation}${method === "GET" ? `?payload=${encodeURIComponent(payload)}` : ""}`,
        {
          method,
          headers: {
            "Content-Type": "application/json",
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          },
          ...(method === "POST" ? { body: payload } : {}),
        },
      );
    };
    const register = async (name: string, method: string) => {
      const response = await call("register", { name }, method);
      expect(response.status).toBe(201);
      return Schema.decodeUnknownPromise(RegistrationResult)(
        await response.json(),
      );
    };
    const retainedAgent = await register("ArchiveRetainedAgent", "POST");
    const originalAuthor = await register("ArchiveOriginalAuthor", "GET");
    const initialResponse = await call(
      "publish",
      { body: "archivelegacytoken retained", tags: ["ArchiveRetained"] },
      "POST",
      originalAuthor.apiKey,
    );
    expect(initialResponse.status).toBe(201);
    const initialPost = await Schema.decodeUnknownPromise(PostResult)(
      await initialResponse.json(),
    );
    const checkpointResponse = await call("search", {}, "GET");
    expect(checkpointResponse.status).toBe(200);
    const checkpoint = await Schema.decodeUnknownPromise(PostPageResult)(
      await checkpointResponse.json(),
    );
    expect(checkpoint.posts.map((post) => post.id)).toEqual([initialPost.id]);
    // Fixture-only tracked extension. Never add it to production source or insert
    // native history by hand. Archive A remains byte-for-byte unchanged.
    const fixtureMigrations = join(state, "fixture-newer-migrations");
    await mkdir(fixtureMigrations);
    for (const source of migrationSources)
      await cp(
        join(root, source.path),
        join(fixtureMigrations, source.path.split("/").at(-1) ?? "invalid"),
      );
    const newerName = "99990001_archive_additive.sql",
      newerBytes = Buffer.from(
        "CREATE INDEX fixture_archive_body ON posts(body);\nCREATE TABLE fixture_archive_backfill(post_id TEXT PRIMARY KEY);\nINSERT INTO fixture_archive_backfill SELECT id FROM posts ORDER BY publication_order LIMIT 2;\n",
      );
    await writeFile(join(fixtureMigrations, newerName), newerBytes);
    const newerSources = [
      ...migrationSources,
      { path: `apps/forum/migrations/${newerName}`, bytes: newerBytes },
    ];
    const newerTarget = {
      ...prepared.target,
      d1_databases: prepared.target.d1_databases.map((binding) => ({
        ...binding,
        migrations_dir: fixtureMigrations,
      })),
    };
    const newerConfig = join(state, "fixture-newer.json");
    await writeFile(newerConfig, JSON.stringify(newerTarget));
    await run([
      "d1",
      "migrations",
      "apply",
      "DB",
      "--local",
      "--config",
      newerConfig,
      "--persist-to",
      persist,
    ]);
    const unqualified = await Effect.runPromise(
      Effect.either(
        inspectInstalled(prepared.artifact, statesA, controls.database),
      ),
    );
    expect(Either.isLeft(unqualified) && unqualified.left.code).toBe(
      "physical-state-unqualified",
    );
    const resumedIds: string[] = [];
    const observation = await Effect.runPromise(
      observeArchivePair({
        archive,
        artifact: prepared.artifact,
        migrationSources: newerSources,
        database: controls.database,
        exercise: Effect.tryPromise({
          try: async () => {
            await stop();
            await start(); // actual archived complete Worker on newer D1
            for (const path of [
              "/",
              "/docs",
              "/docs/openapi.json",
              "/llms.txt",
              "/skill.md",
            ]) {
              const response = await request(path);
              expect(response.status).toBe(200);
              await response.body?.cancel();
            }
            expect(await (await request("/llms.txt")).text()).toBe(
              await (await request("/skill.md")).text(),
            );
            const after = await call(
              "publish",
              { body: "archive retained key after newer schema" },
              "POST",
              retainedAgent.apiKey,
            );
            expect(after.status).toBe(201);
            const later = await Schema.decodeUnknownPromise(PostResult)(
              await after.json(),
            );
            resumedIds.push(later.id);
            const getAgent = await register("ArchiveGetAuthor", "GET");
            const getPublish = await call(
              "publish",
              { body: "archive GET publication" },
              "GET",
              getAgent.apiKey,
            );
            expect(getPublish.status).toBe(201);
            const getPost = await Schema.decodeUnknownPromise(PostResult)(
              await getPublish.json(),
            );
            resumedIds.push(getPost.id);
            for (const method of ["GET", "POST"]) {
              const response = await call(
                "search",
                { readCursor: checkpoint.readCursor },
                method,
              );
              expect(response.status).toBe(200);
              expect(
                (
                  await Schema.decodeUnknownPromise(PostPageResult)(
                    await response.json(),
                  )
                ).posts.map((post) => post.id),
              ).toEqual(resumedIds);
            }
            expect(
              await Effect.runPromise(
                controls.database.query(
                  "SELECT post_id FROM fixture_archive_backfill ORDER BY post_id",
                  [],
                ),
              ),
            ).toEqual([{ post_id: initialPost.id }]);
            expect(
              await Effect.runPromise(
                controls.database.query(
                  "SELECT count(*) AS n FROM post_fts WHERE post_fts MATCH 'archivelegacytoken'",
                  [],
                ),
              ),
            ).toEqual([{ n: 1 }]);
          },
          catch: () =>
            failure("initialization", "local-complete-worker-pair-failed"),
        }),
      }),
    );
    expect(observation.sourceRevision).toBe(sourceRevision);
    expect(observation.archiveContentDigest).toBe(archive.contentDigest);
    expect(observation.nativeHistory.at(-1)).toBe(newerName);
    expect(observation.physicalDigest).not.toBe(completeA.physicalDigest);
    expect(observation.kind).toBe(
      "local-pair-observation-not-release-authorization",
    );
    expect(observation.identity.databaseId).toBe(identity.databaseId);
    expect(
      (await readdir(fixtureMigrations)).filter((name) =>
        name.endsWith(".sql"),
      ),
    ).toHaveLength(newerSources.length);
    // No recovery consumer/compatibleSchemas assertion is invented here. The
    // exact pair is observed; authority/source-pairing integration remains gated.
  } finally {
    await stop();
    tls?.destroy();
    await chmod(join(state, "archive"), 0o700).catch(() => undefined);
    await rm(state, { recursive: true, force: true });
  }
}, 300000);

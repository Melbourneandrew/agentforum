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
  symlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { Agent, request as httpsRequest } from "node:https";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { Effect, Either, Option, Schema } from "effect";
import { expect, it } from "vitest";
import {
  ownerBuild,
  buildProcessLive,
} from "../../apps/forum/scripts/owner-build.js";
import {
  qualifyLocalRecovery,
  prepareRecovery,
  verifyRecoveryCandidate,
} from "./release-recovery.js";
import {
  ownerReleaseCommand,
  ParentExecution,
  type OwnerScope,
} from "./owner-executor.js";
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
import {
  ReleaseCoordinator,
  ReleasePorts,
  type Artifact,
} from "./release-model.js";
import { inspectInstalled, physicalStates } from "./remote-state.js";
import { release } from "./release.js";
import {
  RegistrationResult,
  PostResult,
  PostPageResult,
} from "../../apps/forum/src/api/contracts.js";
const exec = promisify(execFile);
it("complete archived Worker retains data on exact newer native schema; real control ACK stop precedes activation and retry", async () => {
  const tooling = process.cwd(),
    state = await mkdtemp(join(tmpdir(), "wo34-complete-archive-"));
  const root = join(state, "application-A");
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
  const wrangler = join(
    root,
    "apps/forum/node_modules/wrangler/bin/wrangler.js",
  );
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
    // Current trusted tooling B, separate clean supported application checkout A.
    // Exact approved base is retained in full CI history; no moving-main lookup.
    await exec("git", ["clone", "--quiet", "--no-hardlinks", tooling, root], {
      env,
    });
    await exec(
      "git",
      ["checkout", "--quiet", "1310eb41f01352e7287f55dc05bea39a6612ceb5"],
      { cwd: root, env },
    );
    for (const path of ["node_modules", "apps/forum/node_modules"]) {
      await mkdir(join(root, path));
      for (const name of await readdir(join(tooling, path)))
        await symlink(join(tooling, path, name), join(root, path, name));
    }
    const sourceRevision = (
      await exec("git", ["rev-parse", "HEAD"], { cwd: root, env })
    ).stdout.trim();
    expect(sourceRevision).not.toBe(
      (
        await exec("git", ["rev-parse", "HEAD"], { cwd: tooling, env })
      ).stdout.trim(),
    );
    await Effect.runPromise(
      ownerBuild(
        {
          version: 1,
          repository: root,
          revision: sourceRevision,
          metadata: { environment: "local", revision: sourceRevision },
        },
        env,
      ).pipe(Effect.provide(buildProcessLive)),
    );
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
    const controls = await localControls({
      prepared,
      root: tooling,
      state,
      run,
    });
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
    const start = async (selectedArtifact: Artifact = prepared.artifact) => {
      await stop();
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
          "--config",
          selectedArtifact.configPath,
          "--persist-to",
          persist,
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
    // Prior-version native prefix, with real API rows/keys/checkpoint before the
    // acknowledged failure. The pending approved migration builds/rebuilds FTS.
    const priorDirectory = join(state, "prior-migrations");
    await mkdir(priorDirectory);
    for (const source of migrationSources.slice(0, 2))
      await cp(
        join(root, source.path),
        join(priorDirectory, source.path.split("/").at(-1) ?? "invalid"),
      );
    const priorConfig = join(state, "prior.json");
    await writeFile(
      priorConfig,
      JSON.stringify({
        ...prepared.target,
        d1_databases: prepared.target.d1_databases.map((binding) => ({
          ...binding,
          migrations_dir: priorDirectory,
        })),
      }),
    );
    await run([
      "d1",
      "migrations",
      "apply",
      "DB",
      "--local",
      "--config",
      priorConfig,
      "--persist-to",
      persist,
    ]);
    await start();
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
    // Fixture-only tracked extension allowed by the existing safety policy.
    // Existing-table index/backfill is not authorized by its generic DDL rule.
    // Do not bypass it with raw writes or alter the production safety gate.
    // Fixture-only tracked extension. Never add it to production source or insert
    // native history by hand. Archive A remains byte-for-byte unchanged.
    const fixtureMigrations = join(state, "fixture-newer-migrations");
    await mkdir(fixtureMigrations);
    for (const source of migrationSources)
      await cp(
        join(root, source.path),
        join(fixtureMigrations, source.path.split("/").at(-1) ?? "invalid"),
      );
    const newerName = "20990101000001_archive_additive.sql",
      newerBytes = Buffer.from(
        "CREATE TABLE fixture_archive_additive(post_id TEXT PRIMARY KEY);\nCREATE INDEX fixture_archive_post_id ON fixture_archive_additive(post_id);\n",
      );
    await writeFile(join(fixtureMigrations, newerName), newerBytes);
    const newerSources = [
      ...migrationSources,
      { path: `apps/forum/migrations/${newerName}`, bytes: newerBytes },
    ];
    const newerStates = await Effect.runPromise(physicalStates(newerSources));
    const newerTarget = {
      ...prepared.target,
      d1_databases: prepared.target.d1_databases.map((binding) => ({
        ...binding,
        migrations_dir: fixtureMigrations,
      })),
    };
    const newerConfig = join(state, "fixture-newer.json");
    await writeFile(newerConfig, JSON.stringify(newerTarget));
    // Exact newer tuple required: the old native prefix cannot mint a witness.
    const prefixProof = await Effect.runPromise(
      Effect.either(
        qualifyLocalRecovery({
          archive,
          artifact: prepared.artifact,
          applicationRepository: root,
          toolingRepository: tooling,
          state,
          migrationSources: newerSources,
        }),
      ),
    );
    expect(Either.isLeft(prefixProof) && prefixProof.left.code).toBe(
      "physical-state-unqualified",
    );
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
              "/docs/",
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
                  "SELECT post_id FROM fixture_archive_additive ORDER BY post_id",
                  [],
                ),
              ),
            ).toEqual([]);
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
    expect(observation.physicalDigest).toBe(newerStates.at(-1)?.physicalDigest);
    expect(observation.kind).toBe(
      "local-pair-observation-not-release-authorization",
    );
    expect(observation.identity.databaseId).toBe(identity.databaseId);
    expect(
      (await readdir(fixtureMigrations)).filter((name) =>
        name.endsWith(".sql"),
      ),
    ).toHaveLength(newerSources.length);
    await stop();
    const witness = await Effect.runPromise(
      qualifyLocalRecovery({
        archive,
        artifact: prepared.artifact,
        applicationRepository: root,
        toolingRepository: tooling,
        state,
        migrationSources: newerSources,
      }),
    );
    const selection = {
      ...archive,
      originalArtifact: preparedOriginal.artifact,
      witness,
    };
    const recovery = await Effect.runPromise(
      prepareRecovery({
        selection,
        applicationRepository: root,
        identity,
        sourceRevision,
        canonicalOrigin: identity.defaultOrigin,
        output: join(state, "recovered-target.json"),
      }),
    );
    expect(recovery.prepared.artifact.sourceRevision).toBe(sourceRevision);
    expect(recovery.prepared.artifact.compatibleSchemas).toEqual([
      observation.physicalDigest,
    ]);
    expect(recovery.prepared.artifact.artifactDigest).toBe(
      prepared.artifact.artifactDigest,
    );
    expect(
      Either.isLeft(
        await Effect.runPromise(
          Effect.either(
            verifyMaterializedArchive(archive, recovery.prepared.artifact),
          ),
        ),
      ),
    ).toBe(true);
    // Forged/cloned witnesses, wrong parent provenance/UUID/origin/source and
    // supplied compatibility lists never reach a credential. Real admission uses
    // current tooling and A's actual private IPC child, not fake pnpm.
    for (const bad of [
      { ...selection, witness: { ...witness } },
      { ...selection, witness: structuredClone(witness) },
      { ...selection, contentDigest: "f".repeat(64) },
      {
        ...selection,
        originalArtifact: {
          ...selection.originalArtifact,
          sourceRevision: "a".repeat(40),
        },
      },
      { ...selection, compatibleSchemas: [observation.physicalDigest] },
    ]) {
      expect(
        Either.isLeft(
          await Effect.runPromise(
            Effect.either(
              prepareRecovery({
                selection: bad,
                applicationRepository: root,
                identity,
                sourceRevision,
                canonicalOrigin: identity.defaultOrigin,
                output: join(state, "denied-target.json"),
              }),
            ),
          ),
        ),
      ).toBe(true);
    }
    for (const change of [
      { sourceRevision: "b".repeat(40) },
      {
        identity: {
          ...identity,
          databaseId: "22222222-2222-2222-2222-222222222222",
        },
      },
      { canonicalOrigin: "https://foreign.fixture.workers.dev" },
    ])
      expect(
        Either.isLeft(
          await Effect.runPromise(
            Effect.either(
              prepareRecovery({
                selection,
                applicationRepository: root,
                identity,
                sourceRevision,
                canonicalOrigin: identity.defaultOrigin,
                output: join(state, "denied-target.json"),
                ...change,
              }),
            ),
          ),
        ),
      ).toBe(true);
    for (const candidate of [
      {
        ...recovery.prepared.artifact,
        compatibleSchemas: [completeA.physicalDigest],
      },
      {
        ...recovery.prepared.artifact,
        compatibleSchemas: [
          observation.physicalDigest,
          completeA.physicalDigest,
        ],
      },
      {
        ...recovery.prepared.artifact,
        migrations: recovery.prepared.artifact.migrations.slice(0, 1),
      },
    ])
      expect(
        Either.isLeft(
          await Effect.runPromise(
            Effect.either(verifyRecoveryCandidate(witness, archive, candidate)),
          ),
        ),
      ).toBe(true);
    const journal = join(state, "identity.json");
    await writeFile(journal, JSON.stringify({ state: "resolved", identity }), {
      mode: 0o600,
    });
    const context: OwnerScope = {
      repository: root,
      journalPath: journal,
      identity,
      sourceRevision,
      diagnosticEnvironment: "local",
      executorRef: "trusted-parent:archive-consumer-native",
      operation: "recover",
      grants: ["d1:read", "d1:write", "worker:read", "worker:deploy"],
    };
    let credentials = 0,
      selections = 0;
    const owner = (
      data: typeof selection,
      admittedScope: OwnerScope = context,
    ) =>
      Effect.either(
        ownerReleaseCommand([
          "cli",
          "--identity",
          journal,
          "--operation",
          "recover",
        ]).pipe(
          Effect.provideService(ParentExecution, {
            authorize: () => Effect.succeed(admittedScope),
            recovery: Effect.sync(() => {
              selections++;
              return data;
            }),
            credential: Effect.suspend(() => {
              credentials++;
              return Effect.fail(
                failure(
                  "authorization",
                  "test-stop-before-provider-construction",
                ),
              );
            }),
          }),
        ),
      );
    const forgedOwner = await Effect.runPromise(
      owner({ ...selection, witness: { ...witness } }),
    );
    expect(Either.isLeft(forgedOwner) && forgedOwner.left.code).toBe(
      "recovery-evidence-unverified",
    );
    expect(credentials).toBe(0);
    const wrongMetadata = await Effect.runPromise(
      owner(selection, { ...context, diagnosticEnvironment: "staging" }),
    );
    expect(Either.isLeft(wrongMetadata) && wrongMetadata.left.code).toBe(
      "archive-integrity-unverified",
    );
    expect(credentials).toBe(0);
    const claimedAFromB = await Effect.runPromise(
      owner(selection, { ...context, repository: tooling }),
    );
    expect(Either.isLeft(claimedAFromB) && claimedAFromB.left.code).toBe(
      "parent-source-context-mismatch",
    );
    expect(credentials).toBe(0);
    const admittedOwner = await Effect.runPromise(owner(selection));
    expect(Either.isLeft(admittedOwner) && admittedOwner.left.code).toBe(
      "test-stop-before-provider-construction",
    );
    expect(credentials).toBe(1);
    expect(selections).toBe(3);
    const configBytes = await readFile(recovery.prepared.artifact.configPath);
    await writeFile(
      recovery.prepared.artifact.configPath,
      JSON.stringify({ ...recovery.prepared.target, workers_dev: false }),
    );
    expect(
      Either.isLeft(await Effect.runPromise(Effect.either(recovery.verify))),
    ).toBe(true);
    await writeFile(recovery.prepared.artifact.configPath, configBytes);
    await Effect.runPromise(recovery.verify);
    let businessMigrations = 0;
    const recoveredArtifact = recovery.prepared.artifact;
    const recoverPorts: typeof ReleasePorts.Service = {
      ...ports,
      build: () => Effect.succeed(recoveredArtifact),
      verify: () => recovery.verify,
      installed: () =>
        inspectInstalled(recoveredArtifact, recovery.states, controls.database),
      migrate: () => {
        businessMigrations++;
        return Effect.fail(
          failure("initialization", "recovery-must-not-migrate"),
        );
      },
      activate: (artifact, token) =>
        Effect.tryPromise({
          try: async () => {
            await start(artifact);
            activations++;
            return {
              activation: {
                sourceRevision,
                artifactDigest: artifact.artifactDigest,
                version: "local-archived-worker-not-provider-version",
              },
              receipt: {
                ...token,
                identity,
                sourceRevision,
                artifactDigest: artifact.artifactDigest,
                operationRef: "native:local:archived-worker-recovered",
                outcome: "succeeded" as const,
              },
            };
          },
          catch: () => failure("deployment", "local-recovery-outcome-unknown"),
        }),
    };
    const coordinator = await Effect.runPromise(
      makeControlCoordinator({
        artifact: recoveredArtifact,
        ownerId: "55555555-5555-5555-5555-555555555555",
        executorRef: "local:archive:recovery",
      }).pipe(Effect.provideService(ControlDatabase, controls.database)),
    );
    const recovered = await Effect.runPromise(
      Effect.either(
        release({ identity, sourceRevision, operation: "recover" }).pipe(
          Effect.provideService(ReleasePorts, recoverPorts),
          Effect.provideService(ReleaseCoordinator, coordinator),
          Effect.provideService(ControlDatabase, controls.database),
        ),
      ),
    );
    expect(Either.isLeft(recovered) && recovered.left.stage).toBe("readiness");
    expect(businessMigrations).toBe(0);
    expect(activations).toBe(2);
    const retainedWrite = await call(
      "publish",
      { body: "retained recovery key still valid" },
      "POST",
      retainedAgent.apiKey,
    );
    expect(retainedWrite.status).toBe(201);
    for (const method of ["GET", "POST"]) {
      const response = await call(
        "search",
        { readCursor: checkpoint.readCursor },
        method,
      );
      expect(response.status).toBe(200);
      const records = await Schema.decodeUnknownPromise(PostPageResult)(
        await response.json(),
      );
      expect(records.posts.map((post) => post.id)).toEqual(
        expect.arrayContaining(resumedIds),
      );
    }
    expect(
      await Effect.runPromise(
        controls.database.query(
          "SELECT count(*) AS n FROM post_fts WHERE post_fts MATCH 'archivelegacytoken'",
          [],
        ),
      ),
    ).toEqual([{ n: 1 }]);
    expect(
      await Effect.runPromise(
        inspectInstalled(recoveredArtifact, recovery.states, controls.database),
      ),
    ).toEqual({
      databaseId: identity.databaseId,
      schemaDigest: observation.physicalDigest,
    });
    const recoveryClosed = await Effect.runPromise(
      readControl(controls.database),
    );
    expect(Option.isSome(recoveryClosed) && recoveryClosed.value.phase).toBe(
      "idle",
    );
  } finally {
    await stop();
    tls?.destroy();
    await chmod(join(state, "archive"), 0o700).catch(() => undefined);
    await rm(state, { recursive: true, force: true });
  }
}, 480000);

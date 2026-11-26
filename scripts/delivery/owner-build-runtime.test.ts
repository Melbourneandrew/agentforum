// Complete local built Worker proof. No provider credential is supplied; the
// actual Owner entry intentionally stops at the lazy credential boundary.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { Agent, request as httpsRequest } from "node:https";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { Effect, Either, Schema } from "effect";
import { parse } from "jsonc-parser";
import { expect, it } from "vitest";
import {
  safeBuildEnvironment,
  buildChild,
  BuildTools,
  buildToolsLive,
} from "../../apps/forum/scripts/owner-build.js";
import { RegistrationResult } from "../../apps/forum/src/api/contracts.js";
import { Identity, failure } from "./model.js";
import { ParentExecution, ownerReleaseCommand } from "./owner-executor.js";
import { decodeConfig, prepareTarget } from "./release-config.js";
const execute = promisify(execFile);
const Dictionary = Schema.Record({ key: Schema.String, value: Schema.Unknown });
const record = (input: unknown) => Schema.decodeUnknownSync(Dictionary)(input);
const json = (input: string) =>
  Schema.decodeUnknownSync(Schema.parseJson(Dictionary))(input);
const repository = process.cwd();
const stop = async (child: ChildProcess) => {
  const closed =
    child.exitCode === null && child.signalCode === null
      ? once(child, "close")
      : Promise.resolve();
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      /* Already exited. */
    }
  }
  await closed;
};
const port = async () => {
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const address = socket.address();
  if (typeof address !== "object" || address === null)
    throw new Error("local-port-unavailable");
  const value = address.port;
  await new Promise<void>((done) => {
    socket.close(() => {
      done();
    });
  });
  return value;
};
const request = (
  origin: string,
  path: string,
  agent: Agent,
  method = "GET",
  body?: string,
) =>
  new Promise<{ status: number; body: string; correlation: string }>(
    (done, reject) => {
      const outgoing = httpsRequest(
        new URL(path, origin),
        {
          agent,
          method,
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer SYNTHETIC-WO35-private",
            Cookie: "SYNTHETIC-WO35-private",
            "service.version": "spoofed",
            "deployment.environment.name": "production",
          },
        },
        (response) => {
          let data = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            data += chunk;
          });
          response.on("end", () => {
            done({
              status: response.statusCode ?? 0,
              body: data,
              correlation: String(response.headers["x-request-id"] ?? ""),
            });
          });
          response.on("error", () => {
            reject(new Error("local-response-unavailable"));
          });
        },
      );
      outgoing.on("error", () => {
        reject(new Error("local-request-unavailable"));
      });
      outgoing.setTimeout(5000, () => {
        outgoing.destroy(new Error("local-request-timeout"));
      });
      outgoing.end(body);
    },
  );
const runtime = async (
  root: string,
  state: string,
  env: NodeJS.ProcessEnv,
  metadata: { environment: string; revision: string } | null,
  throwing = false,
) => {
  const app = join(root, "apps/forum");
  const builtConfig = join(app, "dist/server/wrangler.json");
  const raw = json(await readFile(builtConfig, "utf8"));
  const directory = dirname(builtConfig);
  let main = resolve(
    directory,
    Schema.decodeUnknownSync(Schema.String)(raw.main),
  );
  if (throwing) {
    // Test-only local import of the untouched production Worker; no diagnostic
    // route/channel and no alteration of production source or compiled pair.
    const wrapper = join(directory, "local-throwing-sink.mjs");
    await writeFile(
      wrapper,
      `import worker from ${JSON.stringify(`./${Schema.decodeUnknownSync(Schema.String)(raw.main)}`)}; export default { async fetch(request, env, execution) { const previous = console.info; console.info = () => { throw new Error("synthetic-sink-unavailable"); }; try { return await worker.fetch(request, env, execution); } finally { console.info = previous; } } };`,
    );
    main = wrapper;
  }
  const listener = await port(),
    origin = `https://127.0.0.1:${String(listener)}`;
  const config = join(
    state,
    `runtime-${metadata === null ? "none" : "pair"}-${throwing ? "throwing" : "normal"}.json`,
  );
  const assets = record(raw.assets);
  const bindings = Schema.decodeUnknownSync(Schema.Array(Dictionary))(
    raw.d1_databases,
  );
  await writeFile(
    config,
    JSON.stringify({
      ...raw,
      main,
      base_dir: directory,
      assets: {
        ...assets,
        directory: resolve(
          directory,
          Schema.decodeUnknownSync(Schema.String)(assets.directory),
        ),
      },
      d1_databases: bindings.map((binding) => ({
        ...binding,
        migrations_dir: resolve(
          directory,
          Schema.decodeUnknownSync(Schema.String)(binding.migrations_dir),
        ),
      })),
      vars: { ...record(raw.vars), CANONICAL_ORIGIN: origin },
    }),
  );
  const key = join(state, "localhost.key"),
    certificate = join(state, "localhost.crt");
  const agent = new Agent({ ca: await readFile(certificate) });
  const diagnostics: string[] = [];
  let pending = "";
  const child = spawn(
    process.execPath,
    [
      join(app, "node_modules/wrangler/bin/wrangler.js"),
      "dev",
      "--config",
      config,
      "--local",
      "--no-bundle",
      "--persist-to",
      state,
      "--inspector-port",
      "0",
      "--ip",
      "127.0.0.1",
      "--port",
      String(listener),
      "--local-protocol",
      "https",
      "--local-upstream",
      `127.0.0.1:${String(listener)}`,
      "--upstream-protocol",
      "https",
      "--https-key-path",
      key,
      "--https-cert-path",
      certificate,
    ],
    { cwd: app, env, detached: true, stdio: ["ignore", "pipe", "ignore"] },
  );
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      const value = /\{"service\.name":[^\r\n]*\}/.exec(line)?.[0];
      if (value) diagnostics.push(value);
    }
  });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        if (
          (await request(origin, "/v1/register", agent, "OPTIONS")).status ===
          204
        ) {
          ready = true;
          break;
        }
      } catch {
        /* Bounded local startup only. */
      }
      if (child.exitCode !== null || child.signalCode !== null) break;
      await delay(100);
    }
    expect(ready).toBe(true);
    for (const method of ["GET", "POST"]) {
      const payload = JSON.stringify({
        name: `built-${metadata === null ? "none" : "pair"}-${throwing ? "sink" : "normal"}-${method.toLowerCase()}`,
      });
      const response = await request(
        origin,
        `/v1/register${method === "GET" ? `?payload=${encodeURIComponent(payload)}` : ""}`,
        agent,
        method,
        method === "POST" ? payload : undefined,
      );
      expect(response.status).toBe(201);
      const registration = Schema.decodeUnknownSync(
        Schema.parseJson(RegistrationResult),
      )(response.body);
      const hostile = JSON.stringify({
        body: "SYNTHETIC-WO35-private",
        tags: ["SYNTHETIC-WO35-private"],
        parent: "SYNTHETIC-WO35-private",
      });
      const failed = await request(
        origin,
        `/v1/publish${method === "GET" ? `?payload=${encodeURIComponent(hostile)}` : ""}`,
        agent,
        method,
        method === "POST" ? hostile : undefined,
      );
      expect(failed.status).toBeGreaterThanOrEqual(400);
      for (
        let attempt = 0;
        !throwing &&
        attempt < 50 &&
        !diagnostics.some((value) => value.includes(response.correlation));
        attempt++
      )
        await delay(20);
      expect(
        diagnostics.some((value) => value.includes(registration.apiKey)),
      ).toBe(false);
      if (!throwing) {
        const value = diagnostics.find((value) =>
          value.includes(response.correlation),
        );
        expect(value).toBeDefined();
        const diagnostic = json(value ?? "{}");
        expect(diagnostic["http.response.status_code"]).toBe(201);
        expect(diagnostic["http.route"]).toBe("/v1/register");
        expect(diagnostic["request.id"]).toBe(response.correlation);
        expect(diagnostic["deployment.environment.name"]).toBe(
          metadata?.environment,
        );
        expect(diagnostic["service.version"]).toBe(metadata?.revision);
        expect(value?.includes("SYNTHETIC-WO35-private")).toBe(false);
        expect(value?.includes("spoofed")).toBe(false);
        expect(value?.includes("built-pair")).toBe(false);
        expect(value?.includes("127.0.0.1")).toBe(false);
      }
    }
    expect(
      diagnostics.some((value) => value.includes("SYNTHETIC-WO35-private")),
    ).toBe(false);
    if (throwing) expect(diagnostics).toHaveLength(0);
  } finally {
    await stop(child);
    agent.destroy();
  }
};
it("ordinary None and admitted public-Vite builds produce complete private local Workers before credentials/fingerprint", async () => {
  const state = await mkdtemp(join(tmpdir(), "wo35-build-runtime-"));
  const root = join(state, "checkout");
  const env = safeBuildEnvironment({
    PATH: process.env.PATH,
    HOME: state,
    XDG_CONFIG_HOME: state,
    WRANGLER_LOG_PATH: join(state, "wrangler.log"),
  });
  try {
    await execute(
      "git",
      ["clone", "--quiet", "--no-hardlinks", repository, root],
      { env },
    );
    // Preserve actual Git clean-source rules: node_modules/ ignores real
    // directories, not a whole-directory symlink. Do not weaken admission.
    for (const path of ["node_modules", "apps/forum/node_modules"]) {
      await mkdir(join(root, path));
      for (const name of await readdir(join(repository, path))) {
        await symlink(join(repository, path, name), join(root, path, name));
      }
    }
    const revision = (
      await execute("git", ["rev-parse", "HEAD"], { cwd: root, env })
    ).stdout.trim();
    const rawCapture = record(
      Schema.decodeUnknownSync(Dictionary)(
        parse(await readFile(join(root, "wrangler.jsonc"), "utf8")),
      ),
    ).observability;
    // Unchanged ordinary/root flow, not the Owner builder.
    await execute("pnpm", ["exec", "turbo", "run", "build", "--force"], {
      cwd: root,
      env,
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    await execute(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        join(state, "localhost.key"),
        "-out",
        join(state, "localhost.crt"),
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=IP:127.0.0.1,DNS:localhost",
      ],
      { env },
    );
    await execute(
      process.execPath,
      [
        join(root, "apps/forum/node_modules/wrangler/bin/wrangler.js"),
        "d1",
        "migrations",
        "apply",
        "DB",
        "--local",
        "--config",
        join(root, "wrangler.jsonc"),
        "--persist-to",
        state,
      ],
      { cwd: root, env, timeout: 30_000 },
    );
    await runtime(root, state, env, null);
    const identity = Schema.decodeUnknownSync(Identity)({
      version: 1,
      accountId: "a".repeat(32),
      workerName: "metadata-forum",
      databaseName: "metadata-database",
      databaseId: "11111111-1111-1111-1111-111111111111",
      defaultOrigin: "https://metadata-forum.owner.workers.dev",
    });
    const journal = join(state, "identity.json");
    await writeFile(journal, JSON.stringify({ state: "resolved", identity }), {
      mode: 0o600,
    });
    const context = {
      repository: root,
      journalPath: journal,
      identity,
      sourceRevision: revision,
      diagnosticEnvironment: "staging" as const,
      executorRef: "trusted-parent:local-metadata-test",
      operation: "update" as const,
      grants: ["d1:read", "d1:write", "worker:read", "worker:deploy"] as const,
    };
    let credentials = 0;
    const owner = () =>
      ownerReleaseCommand(["cli", "--identity", journal]).pipe(
        Effect.provideService(ParentExecution, {
          authorize: () => Effect.succeed(context),
          credential: Effect.suspend(() => {
            credentials++;
            return Effect.fail(
              failure("authorization", "local-test-stops-before-provider"),
            );
          }),
        }),
      );
    const result = await Effect.runPromise(Effect.either(owner()));
    expect(Either.isLeft(result) && result.left.code).toBe(
      "local-test-stops-before-provider",
    );
    expect(credentials).toBe(1);
    const builtConfig = join(root, "apps/forum/dist/server/wrangler.json");
    const raw = await Effect.runPromise(
      decodeConfig(await readFile(builtConfig, "utf8")),
    );
    expect(record(raw).observability).toEqual(rawCapture);
    const prepared = await Effect.runPromise(
      prepareTarget({
        raw,
        builtConfig,
        output: join(state, "artifact.json"),
        identity,
        sourceRevision: revision,
        authorizeTarget: true,
      }),
    );
    expect(prepared.artifact.sourceRevision).toBe(revision);
    const serverFiles = (
      await readdir(dirname(builtConfig), { recursive: true })
    ).filter((name) => /\.m?js$/.test(name));
    const compiled = (
      await Promise.all(
        serverFiles.map((name) =>
          readFile(join(dirname(builtConfig), name), "utf8"),
        ),
      )
    ).join("\n");
    expect(compiled).toContain(revision);
    const client = join(root, "apps/forum/dist/client");
    for (const entry of await readdir(client, {
      recursive: true,
      withFileTypes: true,
    })) {
      if (!entry.isFile()) continue;
      const contents = await readFile(join(entry.parentPath, entry.name));
      expect(contents.includes(revision)).toBe(false);
      expect(contents.includes("deployment.environment.name")).toBe(false);
      expect(contents.includes("__AGENTFORUM_DEPLOYMENT__")).toBe(false);
    }
    const pair = { environment: "staging", revision };
    await runtime(root, state, env, pair);
    const stable = await Effect.runPromise(
      prepareTarget({
        raw,
        builtConfig,
        output: join(state, "verify-artifact.json"),
        identity,
        sourceRevision: revision,
        authorizeTarget: true,
      }),
    );
    expect(stable.artifact.artifactDigest).toBe(
      prepared.artifact.artifactDigest,
    );
    expect(
      (
        await execute(
          "git",
          ["status", "--porcelain=v1", "--untracked-files=normal"],
          { cwd: root, env },
        )
      ).stdout,
    ).toBe("");
    await runtime(root, state, env, pair, true);
    // Actual dirty source and post-build source-change failures, with no terminal
    // and no further lazy credential access. Shape validation supplies no grant.
    const dirty = join(root, "unadmitted-source.txt");
    await writeFile(dirty, "synthetic-change");
    const denied = await Effect.runPromise(Effect.either(owner()));
    expect(Either.isLeft(denied) && denied.left.code).toBe(
      "parent-source-context-mismatch",
    );
    expect(credentials).toBe(1);
    await rm(dirty);
    const tools = await Effect.runPromise(
      Effect.scoped(BuildTools.pipe(Effect.provide(buildToolsLive))),
    );
    const changed = await Effect.runPromise(
      Effect.either(
        buildChild({
          version: 1,
          repository: root,
          revision,
          metadata: pair,
        }).pipe(
          Effect.provideService(BuildTools, {
            source: tools.source,
            build: () =>
              Effect.tryPromise({
                try: () => writeFile(dirty, "synthetic-post-build-change"),
                catch: () => failure("build", "local-test-io"),
              }),
          }),
        ),
      ),
    );
    expect(Either.isLeft(changed) && changed.left.code).toBe(
      "owner-build-unverified",
    );
    expect(credentials).toBe(1);
  } finally {
    await rm(state, { recursive: true, force: true });
  }
}, 180_000);

// Executable ROOT-CWD local qualification, never a provider deploy entry.
// Every Wrangler mutation is explicitly --local; credentials and inherited HOME
// are excluded. The production/default flow remains blocked pending proven provider admission.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { Agent, request as httpsRequest } from "node:https";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Effect, Either, Schema } from "effect";
import { localControls } from "./control-local.js";
import {
  entryCommand,
  EntryAdapters,
  EntryAuthorization,
} from "./release-entry-command.js";
import { readControl, type TerminalReceipt } from "./release-control.js";
import { Option } from "effect";
import { Revision, type ReleasePorts } from "./release-model.js";
import { Identity } from "./model.js";
import {
  cliIdentity,
  decodeConfig,
  nativeIdentity,
  prepareTarget,
  schemaDigest,
} from "./release-config.js";
import {
  inspectDiscovery,
  inspectReadiness,
  ReadinessHttp,
} from "./release-readiness.js";
import { failure } from "./model.js";

const controller = new AbortController();
const interrupt = () => {
  process.exitCode = 1;
  controller.abort();
};
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
const execute = async (
  file: string,
  args: readonly string[],
  options: {
    env: NodeJS.ProcessEnv;
    cwd?: string;
    timeout?: number;
    maxBuffer?: number;
  },
) => {
  const child = spawn(file, args, {
    env: options.env,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    signal: controller.signal,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<{ stdout: string }>((success, error) => {
      let stdout = "",
        size = 0;
      const consume = (chunk: Buffer, capture: boolean) => {
        size += chunk.length;
        if (size > (options.maxBuffer ?? 4 * 1024 * 1024)) {
          error(new Error("Local output limit"));
          return;
        }
        if (capture) stdout += chunk.toString("utf8");
      };
      child.stdout.on("data", (chunk: Buffer) => {
        consume(chunk, true);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        consume(chunk, false);
      });
      child.on("error", error);
      child.on("close", (code) => {
        if (code === 0) success({ stdout });
        else error(new Error("Local command failed"));
      });
      timer = setTimeout(() => {
        error(new Error("Local command timeout"));
      }, options.timeout ?? 30000);
    });
  } finally {
    clearTimeout(timer);
    await stop(child);
  }
};
const Registration = Schema.Struct({
  id: Schema.String,
  apiKey: Schema.String,
});
const Page = Schema.Struct({
  posts: Schema.Array(Schema.Struct({ id: Schema.String })),
  readCursor: Schema.String,
});
const stop = async (child: ChildProcess) => {
  if (!child.pid) return;
  const exited =
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : once(child, "exit");
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    /* already stopped */
  }
  await Promise.race([exited, delay(3000, undefined, { ref: false })]);
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    /* no remaining process group */
  }
  await exited;
};
let step = "arguments";
let httpStatus: number | undefined;
const qualify = async () => {
  assert.deepEqual(
    process.argv.slice(2),
    ["--qualify-local"],
    "Only explicit local qualification is supported",
  );
  const root = process.cwd();
  const state = await mkdtemp(join(tmpdir(), "wo34-root-local-"));
  let child: ChildProcess | undefined;
  let tlsAgent: Agent | undefined;
  const environment = {
    PATH: process.env.PATH ?? "",
    HOME: state,
    XDG_CONFIG_HOME: state,
    CI: "true",
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
    WRANGLER_SEND_METRICS: "false",
    WRANGLER_LOG_PATH: join(state, "wrangler.log"),
  };
  const wrangler = resolve("apps/forum/node_modules/wrangler/bin/wrangler.js");
  const run = async (args: string[]) => {
    return (
      await execute(process.execPath, [wrangler, ...args], {
        cwd: root,
        env: environment,
        timeout: 30000,
        maxBuffer: 4 * 1024 * 1024,
      })
    ).stdout;
  };
  try {
    step = "source-revision";
    const provenance = async () => {
      const status = await execute(
        "git",
        ["status", "--porcelain=v1", "--untracked-files=normal"],
        { cwd: root, env: environment },
      );
      assert.equal(
        status.stdout,
        "",
        "Commit source changes before qualification",
      );
      const revision = await execute("git", ["rev-parse", "HEAD"], {
        cwd: root,
        env: environment,
      });
      return Schema.decodeUnknownSync(Revision)(revision.stdout.trim());
    };
    const sourceRevision = await provenance();
    step = "build";
    // Do not count a cached artifact as a fresh local build.
    await execute("pnpm", ["exec", "turbo", "run", "build", "--force"], {
      cwd: root,
      env: environment,
      timeout: 60000,
      maxBuffer: 8 * 1024 * 1024,
    });
    step = "source-revision";
    assert.equal(
      await provenance(),
      sourceRevision,
      "Source changed during build",
    );
    const identity = Schema.decodeUnknownSync(Identity)({
      version: 1,
      accountId: "a".repeat(32),
      workerName: "local-release-forum",
      databaseName: "local-release-database",
      databaseId: "11111111-1111-1111-1111-111111111111",
      defaultOrigin: "https://local-release-forum.fixture.workers.dev",
    });
    const builtConfig = resolve("apps/forum/dist/server/wrangler.json");
    const raw = await Effect.runPromise(
      decodeConfig(await readFile(builtConfig, "utf8")),
    );
    step = "complete-built-config";
    const prepared = await Effect.runPromise(
      prepareTarget({
        raw,
        builtConfig,
        output: join(state, "target.json"),
        identity,
        sourceRevision,
        authorizeTarget: true,
      }),
    );
    const dictionary = Schema.Record({
      key: Schema.String,
      value: Schema.Unknown,
    });
    const builtObject = Schema.decodeUnknownSync(dictionary)(raw);
    const targetObject = Schema.decodeUnknownSync(dictionary)(prepared.target);
    for (const field of ["observability", "tail_consumers", "logpush"])
      assert.deepEqual(
        targetObject[field],
        builtObject[field],
        "Built capture policy changed",
      );
    // Synthetic resolved native config is a LOCAL fixture only. This is not
    // evidence that Builds supplies account/origin/auth or durable ownership.
    step = "native-cli-inputs";
    const native = await Effect.runPromise(
      nativeIdentity(prepared.target, {
        accountId: identity.accountId,
        defaultOrigin: identity.defaultOrigin,
      }),
    );
    const cli = await Effect.runPromise(
      cliIdentity({ state: "resolved", identity }),
    );
    assert.deepEqual(native, cli);
    await writeFile(
      prepared.artifact.configPath,
      JSON.stringify(prepared.target),
    );
    const config = [
      "--config",
      prepared.artifact.configPath,
      "--persist-to",
      join(state, "d1"),
    ];
    const controls = await localControls({ prepared, root, state, run });
    const journalPath = join(state, "retained-cli-identity.json");
    await writeFile(
      journalPath,
      JSON.stringify({ state: "resolved", identity }),
      { flag: "wx" },
    );
    step = "disposable-local-tls";
    const certificate = join(state, "certificate.pem"),
      key = join(state, "key.pem");
    await execute(
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
      { env: environment, timeout: 10000 },
    );
    tlsAgent = new Agent({ ca: await readFile(certificate) });
    const localFetch = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      assert.equal(url.protocol, "https:");
      assert.equal(url.hostname, "127.0.0.1");
      const body =
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : Buffer.from(await request.arrayBuffer());
      return new Promise<Response>((success, error) => {
        const outgoing = httpsRequest(
          url,
          {
            method: request.method,
            headers: Object.fromEntries(request.headers),
            agent: tlsAgent,
            signal: AbortSignal.any([request.signal, controller.signal]),
          },
          (response) => {
            const chunks: Buffer[] = [];
            let size = 0;
            response.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size > 1024 * 1024) {
                outgoing.destroy(new Error("local response limit"));
                return;
              }
              chunks.push(chunk);
            });
            response.on("error", error);
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
        outgoing.on("error", error);
        outgoing.end(body);
      });
    };
    const socket = createServer();
    socket.listen(0, "127.0.0.1");
    await once(socket, "listening");
    const address = socket.address();
    assert.ok(address && typeof address !== "string");
    const port = address.port;
    await new Promise<void>((success, error) =>
      socket.close((problem) => {
        if (problem) error(problem);
        else success();
      }),
    );
    const base = `https://127.0.0.1:${String(port)}`;
    const start = async () => {
      child = spawn(
        process.execPath,
        [
          wrangler,
          "dev",
          "--local",
          "--no-bundle",
          ...config,
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
        ],
        { cwd: root, env: environment, detached: true, stdio: "ignore" },
      );
      for (let attempt = 0; attempt < 100; attempt++) {
        controller.signal.throwIfAborted();
        if (child.exitCode !== null) throw new Error("Local Worker exited");
        const response = await localFetch(`${base}/v1/search?payload=%7B%7D`, {
          signal: AbortSignal.timeout(1000),
        }).catch(() => undefined);
        if (response?.status === 200) return;
        await response?.body?.cancel();
        await delay(100);
      }
      throw new Error("Local Worker not ready");
    };
    const call = async (
      operation: string,
      input: unknown,
      method = "POST",
      key = "",
    ) => {
      const body = JSON.stringify(input);
      return localFetch(
        `${base}/v1/${operation}${method === "GET" ? `?payload=${encodeURIComponent(body)}` : ""}`,
        {
          method,
          headers: {
            "Content-Type": "application/json",
            ...(key ? { Authorization: `Bearer ${key}` } : {}),
          },
          ...(method === "POST" ? { body } : {}),
          signal: AbortSignal.timeout(5000),
        },
      );
    };
    const terminal = (
      token: import("./release-control.js").EffectToken,
      operationRef: string,
    ): TerminalReceipt => ({
      ...token,
      identity,
      sourceRevision,
      artifactDigest: prepared.artifact.artifactDigest,
      operationRef,
      outcome: "succeeded",
    });
    const localReadiness = (
      artifact: import("./release-model.js").Artifact,
      activation: import("./release-model.js").Activation,
    ) =>
      inspectReadiness(artifact, activation).pipe(
        Effect.provideService(ReadinessHttp, {
          request: (request) =>
            Effect.tryPromise({
              try: () =>
                localFetch(
                  new Request(
                    new URL(
                      new URL(request.url).pathname +
                        new URL(request.url).search,
                      base,
                    ),
                    request,
                  ),
                  { signal: AbortSignal.timeout(5000) },
                ),
              catch: () => failure("readiness", "local-surface-unavailable"),
            }),
        }),
      );
    const ports: typeof ReleasePorts.Service = {
      build: () => Effect.succeed(prepared.artifact),
      verify: () =>
        Effect.gen(function* () {
          const current = yield* Effect.tryPromise({
            try: () => readFile(builtConfig, "utf8"),
            catch: () => failure("build", "local-built-config-unreadable"),
          });
          const raw = yield* decodeConfig(current);
          const verified = yield* prepareTarget({
            raw,
            builtConfig,
            output: join(state, "verify-only.json"),
            identity,
            sourceRevision,
            authorizeTarget: true,
          });
          if (
            verified.artifact.artifactDigest !==
            prepared.artifact.artifactDigest
          )
            return yield* Effect.fail(
              failure("build", "local-artifact-changed"),
            );
        }),
      installed: () =>
        Effect.gen(function* () {
          const exists = yield* controls.database.query(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='d1_migrations'",
            [],
          );
          const applied = exists.length
            ? yield* controls.database.query(
                "SELECT name FROM d1_migrations ORDER BY id",
                [],
              )
            : [];
          const names = yield* Schema.decodeUnknown(
            Schema.Array(Schema.Struct({ name: Schema.String })),
          )(applied).pipe(
            Effect.mapError(() =>
              failure("initialization", "local-history-invalid"),
            ),
          );
          const prefix = prepared.artifact.migrations.slice(0, names.length);
          if (names.some((row, index) => row.name !== prefix[index]?.name))
            return yield* Effect.fail(
              failure("initialization", "local-history-not-prefix"),
            );
          // Disposable-local qualification only, not historical provider SQL attestation.
          return {
            databaseId: identity.databaseId,
            schemaDigest: schemaDigest(prefix),
          };
        }),
      migrate: (_, token) =>
        Effect.tryPromise({
          try: async () => {
            step = "local-business-migrations";
            await run([
              "d1",
              "migrations",
              "apply",
              "DB",
              "--local",
              ...config,
            ]);
            return terminal(token, "local:native-business-migrations");
          },
          catch: () => failure("initialization", "local-migration-unknown"),
        }),
      activate: (_, token) =>
        Effect.tryPromise({
          try: async () => {
            step = "local-built-worker";
            await start();
            return {
              activation: {
                sourceRevision,
                artifactDigest: prepared.artifact.artifactDigest,
                version: "local-built-worker-no-provider-version",
              },
              receipt: terminal(token, `local:worker:${String(child?.pid)}`),
            };
          },
          catch: () => failure("deployment", "local-worker-activation-failed"),
        }),
      readiness: localReadiness,
    };
    const runEntry = async (mode: "native" | "cli") => {
      step = `local-root-${mode}-entry`;
      const result = await Effect.runPromise(
        Effect.either(
          entryCommand([
            mode,
            mode === "native" ? "--resolved-config" : "--identity",
            mode === "native" ? prepared.artifact.configPath : journalPath,
          ]).pipe(
            Effect.provideService(EntryAuthorization, {
              admit: (input) =>
                Effect.gen(function* () {
                  const text = yield* Effect.tryPromise({
                    try: () => readFile(input.inputPath, "utf8"),
                    catch: () =>
                      failure("configuration", "local-entry-input-unreadable"),
                  });
                  const raw = yield* decodeConfig(text);
                  const selected =
                    input.mode === "native"
                      ? yield* nativeIdentity(raw, {
                          accountId: identity.accountId,
                          defaultOrigin: identity.defaultOrigin,
                        })
                      : yield* cliIdentity(raw);
                  return {
                    identity: selected,
                    executorRef: `local:root:${String(process.pid)}:${mode}`,
                  };
                }),
            }),
            Effect.provideService(EntryAdapters, {
              prepare: () =>
                Effect.succeed({
                  artifact: prepared.artifact,
                  ports,
                  database: controls.database,
                  bootstrap: controls.bootstrap,
                  ownerId: randomUUID(),
                }),
            }),
          ),
        ),
      );
      assert.ok(
        Either.isLeft(result) && result.left.stage === "readiness",
        "Actual local entry must stop at incomplete product readiness",
      );
      const row = await Effect.runPromise(readControl(controls.database));
      assert.ok(
        Option.isSome(row) && row.value.phase === "idle",
        "Known-terminal readiness failure should durably close, not strand ownership",
      );
    };
    await runEntry("native");
    step = "local-agent-loop";
    step = "local-registration";
    const signup = await call("register", { name: "RootLocalReleaseAgent" });
    httpStatus = signup.status;
    assert.equal(signup.status, 201);
    const agent = await Schema.decodeUnknownPromise(Registration)(
      await signup.json(),
    );
    step = "local-publication";
    const post = await call(
      "publish",
      { body: "root release retained body", tags: ["Root"] },
      "POST",
      agent.apiKey,
    );
    httpStatus = post.status;
    assert.equal(post.status, 201);
    await post.body?.cancel();
    step = "local-read-checkpoint";
    const initial = await call("search", { author: agent.id }, "GET");
    httpStatus = initial.status;
    assert.equal(initial.status, 200);
    const page = await Schema.decodeUnknownPromise(Page)(await initial.json());
    assert.equal(page.posts.length, 1);
    assert.ok(child);
    await stop(child);
    child = undefined;
    await runEntry("cli");
    const accepted = await call(
      "publish",
      { body: "after local application restart" },
      "GET",
      agent.apiKey,
    );
    assert.equal(accepted.status, 201);
    await accepted.body?.cancel();
    for (const method of ["GET", "POST"]) {
      const resumed = await call(
        "search",
        { author: agent.id, readCursor: page.readCursor },
        method,
      );
      assert.equal(resumed.status, 200);
      assert.equal(
        (await Schema.decodeUnknownPromise(Page)(await resumed.json())).posts
          .length,
        1,
      );
    }
    step = "accepted-docs32-static-contract";
    for (const path of ["/docs/", "/docs/llms.txt", "/docs/openapi.json"]) {
      const response = await localFetch(new URL(path, base), {
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(response.status, 200);
      const text = await response.text();
      if (path === "/docs/openapi.json") {
        const contract = Schema.decodeUnknownSync(
          Schema.parseJson(
            Schema.Struct({
              servers: Schema.Array(
                Schema.Struct({ url: Schema.Literal("/") }),
              ),
            }),
          ),
        )(text);
        assert.ok(contract.servers.length > 0);
        assert.equal(
          text,
          await readFile(
            resolve("apps/forum/public/docs/openapi.json"),
            "utf8",
          ),
        );
      }
    }
    step = "actual-wo30-discovery";
    // Direct metadata-only qualification on our trusted local TLS origin. This
    // never substitutes for the full probe's separate incomplete-website gate.
    await Effect.runPromise(
      inspectDiscovery(base).pipe(
        Effect.provideService(ReadinessHttp, {
          request: (request) =>
            Effect.tryPromise({
              try: () =>
                localFetch(request, { signal: AbortSignal.timeout(5000) }),
              catch: () => failure("readiness", "local-discovery-unavailable"),
            }),
        }),
      ),
    );
    for (const path of [
      "/llms.txt",
      "/skill.md",
      "/skills/agentforum/SKILL.md",
      "/docs/post.schema.json",
    ]) {
      const response = await localFetch(new URL(path, base), {
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(response.status, 200);
      assert.equal(
        await response.text(),
        await readFile(resolve(`apps/forum/public${path}`), "utf8"),
      );
    }
    step = "current-scaffold-readiness-rejection";
    const notReady = await Effect.runPromise(
      Effect.either(
        inspectReadiness(
          prepared.artifact,
          {
            sourceRevision: prepared.artifact.sourceRevision,
            artifactDigest: prepared.artifact.artifactDigest,
            version: "local-only-no-provider-version",
          },
          "/docs/openapi.json",
        ).pipe(
          Effect.provideService(ReadinessHttp, {
            request: (request) =>
              Effect.tryPromise({
                try: () =>
                  localFetch(
                    new Request(
                      new URL(
                        new URL(request.url).pathname +
                          new URL(request.url).search,
                        base,
                      ),
                      request,
                    ),
                    { signal: AbortSignal.timeout(5000) },
                  ),
                catch: () => failure("readiness", "local-surface-unavailable"),
              }),
          }),
        ),
      ),
    );
    if (Either.isLeft(notReady))
      assert.ok(
        [
          "incomplete-observation-or-docs",
          "required-surface-unavailable",
        ].includes(notReady.left.code),
      );
    assert.ok(
      Either.isLeft(notReady),
      "Current unfinished product must not qualify as a complete installation",
    );
    console.log(
      JSON.stringify({
        status: "local-qualified-not-installation-ready",
        sourceRevision,
        artifactDigest: prepared.artifact.artifactDigest,
        builtConfig: "apps/forum/dist/server/wrangler.json",
        capturePolicy: "complete-built-object-preserved",
        docs32: "actual-static-contract-served",
        discovery30:
          "actual-relative-guides-skill-schema-and-four-pure-descriptions",
        nativeCliIdentity: "local-fixture-converged",
        migrations: "real-local-repeat-retained",
        worker: "real-built-worker-restarted",
        keysAndCheckpoints: "retained",
        provider: "not-run",
        serialization: "actual-local-d1-native-cli-owned",
        rootEntries: "actual-native-cli-dispatchers-local-transport",
        readiness: "failed-as-required-for-current-scaffold",
      }),
    );
  } finally {
    if (child) await stop(child);
    tlsAgent?.destroy();
    await rm(state, { recursive: true, force: true });
  }
};
await qualify()
  .catch(() => {
    console.error(
      JSON.stringify({
        status: "local-qualification-failed",
        step,
        httpStatus,
        provider: "not-run",
      }),
    );
    process.exitCode = 1;
  })
  .finally(() => {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  });

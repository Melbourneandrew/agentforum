import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Data, Effect, Exit, Redacted, Schedule, Schema } from "effect";
import { LocalPostgres, localPostgresLayer } from "./local-postgres.js";

class TestHarnessError extends Data.TaggedError("TestHarnessError") {}
const missingProcess = Schema.Struct({ code: Schema.Literal("ESRCH") });
interface ProcessLease {
  readonly child: ChildProcess;
  readonly completion: Promise<number>;
}
const stopProcess = (lease: ProcessLease) =>
  Effect.tryPromise({
    try: async () => {
      const pid = lease.child.pid;
      if (pid === undefined) return;
      const kill = (signal: NodeJS.Signals) => {
        try {
          process.kill(-pid, signal);
        } catch (error) {
          if (Schema.decodeUnknownEither(missingProcess)(error)._tag === "Left")
            throw new TestHarnessError();
        }
      };
      kill("SIGTERM");
      if (lease.child.exitCode !== null || lease.child.signalCode !== null)
        return;
      await new Promise<void>((done, reject) => {
        const timer = setTimeout(() => {
          try {
            kill("SIGKILL");
            done();
          } catch {
            reject(new TestHarnessError());
          }
        }, 3_000);
        void lease.completion.then(() => {
          clearTimeout(timer);
          done();
        });
      });
    },
    catch: () => new TestHarnessError(),
  }).pipe(Effect.orDie);
const processLease = (
  args: readonly string[],
  environment: Readonly<Record<string, string>> = {},
) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const child = spawn("pnpm", ["exec", ...args], {
        detached: true,
        stdio: "inherit",
        env: { ...process.env, WRANGLER_SEND_METRICS: "false", ...environment },
      });
      const completion = new Promise<number>((done) => {
        child.once("error", () => {
          done(1);
        });
        child.once("exit", (code) => {
          done(code ?? 1);
        });
      });
      return { child, completion };
    }),
    stopProcess,
  );
const runVitest = (
  args: readonly string[],
  environment: Readonly<Record<string, string>> = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const lease = yield* processLease(
        ["vitest", "run", ...args],
        environment,
      );
      yield* Effect.promise(() => lease.completion).pipe(
        Effect.filterOrFail(
          (code) => code === 0,
          () => new TestHarnessError(),
        ),
      );
    }),
  );
const availablePort = Effect.tryPromise({
  try: () =>
    new Promise<number>((done, reject) => {
      const server = createServer();
      server.on("error", () => {
        reject(new TestHarnessError());
      });
      server.listen(0, "127.0.0.1", () => {
        const address = Schema.decodeUnknownEither(
          Schema.Struct({ port: Schema.Int }),
        )(server.address());
        server.close((error) => {
          if (error || address._tag === "Left") reject(new TestHarnessError());
          else done(address.right.port);
        });
      });
    }),
  catch: () => new TestHarnessError(),
});
const FixtureConfig = Schema.parseJson(
  Schema.Struct({
    name: Schema.String,
    main: Schema.String,
    compatibility_date: Schema.String,
    compatibility_flags: Schema.Array(Schema.String),
    workers_dev: Schema.Literal(false),
    preview_urls: Schema.Literal(false),
    observability: Schema.Struct({ enabled: Schema.Literal(false) }),
  }),
);
const privateWorker = (direct: string, cached: string, token: string) =>
  Effect.gen(function* () {
    const port = yield* availablePort;
    const origin = `http://127.0.0.1:${String(port)}`;
    const directory = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => mkdtemp(join(tmpdir(), "agentforum-database-worker-")),
        catch: () => new TestHarnessError(),
      }),
      (directory) =>
        Effect.promise(() => rm(directory, { recursive: true, force: true })),
    );
    const config = yield* Effect.tryPromise({
      try: () => readFile("test/fixtures/wrangler.database.json", "utf8"),
      catch: () => new TestHarnessError(),
    }).pipe(
      Effect.flatMap(Schema.decodeUnknown(FixtureConfig)),
      Effect.tapErrorCause(() =>
        Effect.logError("database_harness_fixture_config_failed"),
      ),
      Effect.mapError(() => new TestHarnessError()),
    );
    const configPath = join(directory, "wrangler.json");
    yield* Effect.tryPromise({
      try: async () => {
        await writeFile(
          configPath,
          JSON.stringify({
            ...config,
            main: resolve("test/fixtures", config.main),
            vars: {
              HYPERDRIVE_DIRECT: { connectionString: direct },
              HYPERDRIVE_CACHED: { connectionString: cached },
            },
          }),
          { mode: 0o600 },
        );
        // Wrangler treats .dev.vars as secrets and renders their values as hidden.
        await writeFile(
          join(directory, ".dev.vars"),
          `DATABASE_SMOKE_TOKEN=${token}\n`,
          { mode: 0o600 },
        );
      },
      catch: () => new TestHarnessError(),
    });
    const lease = yield* processLease([
      "wrangler",
      "dev",
      "--config",
      configPath,
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--inspector-port",
      "0",
    ]);
    yield* Effect.tryPromise({
      try: async (signal) => {
        if (lease.child.exitCode !== null) throw new TestHarnessError();
        const response = await fetch(origin, {
          method: "HEAD",
          signal: AbortSignal.any([signal, AbortSignal.timeout(500)]),
        });
        if (response.status !== 200) throw new TestHarnessError();
      },
      catch: () => new TestHarnessError(),
    }).pipe(
      Effect.retry({ times: 100, schedule: Schedule.spaced("100 millis") }),
    );
    return origin;
  });
const databaseTests = Effect.scoped(
  Effect.gen(function* () {
    const postgres = yield* LocalPostgres;
    yield* postgres.execute("CREATE DATABASE agentforum_direct", "postgres");
    yield* postgres.execute("CREATE DATABASE agentforum_cached", "postgres");
    yield* postgres.execute(
      "CREATE ROLE agentforum_saturated LOGIN CONNECTION LIMIT 1",
      "postgres",
    );
    const direct = Redacted.value(postgres.url("agentforum_direct"));
    const cached = Redacted.value(postgres.url("agentforum_cached"));
    const token = crypto.randomUUID();
    const origin = yield* privateWorker(direct, cached, token).pipe(
      Effect.tapErrorCause(() =>
        Effect.logError("database_harness_worker_start_failed"),
      ),
    );
    yield* runVitest(["--config", "vitest.database.config.mjs"], {
      DATABASE_TEST_DIRECT_URL: direct,
      DATABASE_TEST_CACHED_URL: cached,
      DATABASE_SMOKE_TOKEN: token,
      DATABASE_TEST_ORIGIN: origin,
    });
  }),
).pipe(
  Effect.provide(localPostgresLayer),
  Effect.tapErrorCause(() =>
    Effect.logError("database_harness_database_suite_failed"),
  ),
);
const controller = new AbortController();
const abort = () => {
  controller.abort();
};
process.once("SIGINT", abort);
process.once("SIGTERM", abort);
const outcome = await Effect.runPromiseExit(
  runVitest([]).pipe(Effect.zipRight(databaseTests)),
  { signal: controller.signal },
);
process.removeListener("SIGINT", abort);
process.removeListener("SIGTERM", abort);
if (Exit.isFailure(outcome)) {
  console.error(
    "PostgreSQL test harness failed; check the preceding check results. No raw credentials or dependency errors are logged.",
  );
  process.exitCode = 1;
}

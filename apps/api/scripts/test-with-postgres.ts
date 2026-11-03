import { createServer } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Data, Effect, Exit, Layer, Redacted, Schedule, Schema } from "effect";
import {
  LocalPostgres,
  localPostgresLayer,
  resetOwnedLocalDatabase,
} from "./local-postgres.js";

import {
  LocalDatabaseFaults,
  localDatabaseFaultsLayer,
} from "./local-database-faults.js";

import {
  migrationProcessLayer,
  migrateOwnedLocalDatabase,
} from "./migrations.js";
import { verifyLocalMigrations } from "./verify-local-migrations.js";

import { ownedProcess } from "./owned-process.js";

import {
  databaseBindingsLayer,
  directDatabaseLayer,
} from "../src/database/database.js";
import {
  prepareSmokeFixture,
  cleanupSmokeFixture,
} from "./smoke-fixture-program.js";

import {
  runDatabaseSmoke,
  smokeTransportLayer,
} from "./database-smoke-program.js";
class TestHarnessError extends Data.TaggedError("TestHarnessError") {}
const processLease = (
  args: readonly string[],
  environment: Readonly<Record<string, string>> = {},
) =>
  ownedProcess("pnpm", ["exec", ...args], {
    output: "inherit",
    environment: { WRANGLER_SEND_METRICS: "false", ...environment },
  });
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
          (result) => result.code === 0,
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
const privateWorker = (
  direct: string,
  cached: string,
  token: string,
  blackhole: string,
  saturated: string,
) =>
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
              HYPERDRIVE_TIMEOUT: { connectionString: blackhole },
              HYPERDRIVE_SATURATED: { connectionString: saturated },
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
    const faults = yield* LocalDatabaseFaults;
    yield* verifyLocalMigrations.pipe(Effect.provide(migrationProcessLayer));
    // Restore the actual product schema after the isolated synthetic migration proof.
    // Clone only this owned, fully migrated local database into the direct fixture.
    yield* resetOwnedLocalDatabase(postgres);
    yield* migrateOwnedLocalDatabase(postgres).pipe(
      Effect.provide(migrationProcessLayer),
    );
    yield* migrateOwnedLocalDatabase(postgres).pipe(
      Effect.provide(migrationProcessLayer),
    );
    yield* postgres.execute(
      "CREATE DATABASE agentforum_direct TEMPLATE agentforum_local",
      "postgres",
    );
    yield* postgres.execute("CREATE DATABASE agentforum_cached", "postgres");
    yield* postgres.execute(
      "CREATE ROLE agentforum_saturated LOGIN CONNECTION LIMIT 1",
      "postgres",
    );
    const direct = Redacted.value(postgres.url("agentforum_direct"));
    const cached = Redacted.value(postgres.url("agentforum_cached"));
    yield* prepareSmokeFixture("postgres").pipe(
      Effect.provide(
        directDatabaseLayer.pipe(
          Layer.provide(
            databaseBindingsLayer({
              HYPERDRIVE_DIRECT: { connectionString: direct },
              HYPERDRIVE_CACHED: { connectionString: cached },
            }),
          ),
        ),
      ),
    );
    const token = crypto.randomUUID();
    const saturated = new URL(direct);
    saturated.username = "agentforum_saturated";
    const origin = yield* privateWorker(
      direct,
      cached,
      token,
      Redacted.value(faults.connectionString),
      saturated.toString(),
    ).pipe(
      Effect.tapErrorCause(() =>
        Effect.logError("database_harness_worker_start_failed"),
      ),
    );
    // The Actions smoke runner targets Node, not the Worker global API surface.
    // Exercise that actual transport against the separately running real Worker.
    yield* runDatabaseSmoke("agentforum_direct", "agentforum_cached").pipe(
      Effect.provide(smokeTransportLayer(origin, Redacted.make(token))),
    );
    yield* runVitest(["--config", "vitest.database.config.mjs"], {
      DATABASE_TEST_DIRECT_URL: direct,
      DATABASE_TEST_CACHED_URL: cached,
      DATABASE_SMOKE_TOKEN: token,
      DATABASE_TEST_ORIGIN: origin,
      DATABASE_TEST_SATURATED_URL: saturated.toString(),
      DATABASE_TEST_STATISTICS_URL: faults.statisticsUrl,
    }).pipe(
      Effect.ensuring(
        cleanupSmokeFixture.pipe(
          Effect.provide(
            directDatabaseLayer.pipe(
              Layer.provide(
                databaseBindingsLayer({
                  HYPERDRIVE_DIRECT: { connectionString: direct },
                  HYPERDRIVE_CACHED: { connectionString: cached },
                }),
              ),
            ),
          ),
          Effect.orDie,
        ),
      ),
    );
    yield* Effect.logInfo("private_smoke_and_fixture_cleanup_verified_locally");
  }),
).pipe(
  Effect.provide(Layer.merge(localPostgresLayer, localDatabaseFaultsLayer)),
  Effect.tapErrorCause(() =>
    Effect.logError("database_harness_database_suite_failed"),
  ),
);
const controller = new AbortController();
const abort = () => {
  controller.abort();
};
// Wrappers can forward the same group signal again during asynchronous cleanup.
// Keep handlers installed until every scoped finalizer has completed.
process.on("SIGINT", abort);
process.on("SIGTERM", abort);
const outcome = await Effect.runPromiseExit(
  runVitest([]).pipe(
    Effect.zipRight(runVitest(["--config", "vitest.tooling.config.mjs"])),
    Effect.zipRight(databaseTests),
  ),
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

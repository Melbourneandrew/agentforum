import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse, type ParseError } from "jsonc-parser";
import { Cause, Effect, Exit, Layer, Redacted, Schema } from "effect";
import {
  LocalPostgres,
  localPostgresLayer,
  ownedLocalDatabaseUrl,
} from "./local-postgres.js";
import {
  LocalDatabaseCommandError,
  localDescriptorLease,
} from "./local-descriptor.js";
import {
  migrateOwnedLocalDatabase,
  migrationProcessLayer,
} from "./migrations.js";
import { ownedProcess } from "./owned-process.js";
const Environment = Schema.Struct({
  LOCAL_API_PORT: Schema.optionalWith(
    Schema.NumberFromString.pipe(Schema.int(), Schema.between(1, 65535)),
    { default: () => 8787 },
  ),
});
const Config = Schema.Struct({
  name: Schema.String,
  main: Schema.String,
  compatibility_date: Schema.String,
  compatibility_flags: Schema.Array(Schema.String),
  workers_dev: Schema.Literal(false),
  preview_urls: Schema.Literal(false),
  observability: Schema.Struct({ enabled: Schema.Literal(false) }),
});
const program = Effect.scoped(
  Effect.gen(function* () {
    yield* Effect.filterOrFail(
      Effect.succeed(process.argv.slice(2)),
      (args) => args.length === 0,
      () => new LocalDatabaseCommandError(),
    );
    const environment = yield* Schema.decodeUnknown(Environment)(
      process.env,
    ).pipe(Effect.mapError(() => new LocalDatabaseCommandError()));
    const postgres = yield* LocalPostgres;
    yield* localDescriptorLease(postgres);
    yield* migrateOwnedLocalDatabase(postgres);
    const url = yield* ownedLocalDatabaseUrl(postgres);
    const config = yield* Effect.tryPromise({
      try: async () => {
        const errors: ParseError[] = [];
        const input: unknown = parse(
          await readFile("wrangler.jsonc", "utf8"),
          errors,
          { allowTrailingComma: true },
        );
        if (errors.length > 0) throw new LocalDatabaseCommandError();
        return input;
      },
      catch: () => new LocalDatabaseCommandError(),
    }).pipe(
      Effect.flatMap(Schema.decodeUnknown(Config)),
      Effect.mapError(() => new LocalDatabaseCommandError()),
    );
    const directory = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => mkdtemp(resolve(".wrangler/local-database-")),
        catch: () => new LocalDatabaseCommandError(),
      }),
      (directory) =>
        Effect.promise(() => rm(directory, { recursive: true, force: true })),
    );
    const configPath = join(directory, "wrangler.json");
    yield* Effect.tryPromise({
      try: () =>
        writeFile(
          configPath,
          JSON.stringify({
            ...config,
            main: resolve(config.main),
            vars: {
              ENVIRONMENT: "local",
              HYPERDRIVE_DIRECT: { connectionString: Redacted.value(url) },
              HYPERDRIVE_CACHED: { connectionString: Redacted.value(url) },
            },
          }),
          { mode: 0o600 },
        ),
      catch: () => new LocalDatabaseCommandError(),
    });
    const lease = yield* ownedProcess(
      "pnpm",
      [
        "exec",
        "wrangler",
        "dev",
        "--config",
        configPath,
        "--local",
        "--ip",
        "0.0.0.0",
        "--port",
        String(environment.LOCAL_API_PORT),
        "--inspector-port",
        "0",
      ],
      { output: "inherit", environment: { WRANGLER_SEND_METRICS: "false" } },
    );
    yield* Effect.logInfo(
      `Owned local PostgreSQL ready; API http://127.0.0.1:${String(environment.LOCAL_API_PORT)}; reset uses .wrangler/local-postgres.json only`,
    );
    const result = yield* Effect.promise(() => lease.completion);
    yield* Effect.filterOrFail(
      Effect.succeed(result.code),
      (code) => code === 0,
      () => new LocalDatabaseCommandError(),
    );
  }),
).pipe(Effect.provide(Layer.merge(localPostgresLayer, migrationProcessLayer)));
const controller = new AbortController();
const abort = () => {
  controller.abort();
};
// Wrappers can forward the same group signal again during asynchronous cleanup.
// Keep handlers installed until every scoped finalizer has completed.
process.on("SIGINT", abort);
process.on("SIGTERM", abort);
const result = await Effect.runPromiseExit(program, {
  signal: controller.signal,
});
process.removeListener("SIGINT", abort);
process.removeListener("SIGTERM", abort);
if (Exit.isFailure(result) && !Cause.isInterruptedOnly(result.cause)) {
  console.error(
    "Local database development failed. Only a new owned local session is supported; no remote target or existing lease is overwritten.",
  );
  process.exitCode = 1;
}

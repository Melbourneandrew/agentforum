import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Config } from "drizzle-kit";
import { Context, Data, Effect, Layer, Option, Redacted, Schema } from "effect";
import { ownedLocalDatabaseUrl } from "./local-postgres.js";
import { migrationLayout } from "./migration-layout.js";

import { ownedProcess } from "./owned-process.js";

export class MigrationError extends Data.TaggedError("MigrationError")<{
  readonly stage: "target" | "generate" | "migrate" | "configuration";
}> {}
const Origin = Schema.String.pipe(
  Schema.filter((input) => {
    try {
      const url = new URL(input);
      return (
        ["postgres:", "postgresql:"].includes(url.protocol) &&
        url.hostname.length > 0 &&
        !["localhost", "127.0.0.1", "[::1]", "hyperdrive.local"].includes(
          url.hostname,
        ) &&
        !url.hostname.endsWith(".hyperdrive.local") &&
        (url.port === "" || url.port === "5432") &&
        url.pathname.length > 1 &&
        !url.hash &&
        decodeURIComponent(url.username).length > 0 &&
        decodeURIComponent(url.password).length > 0
      );
    } catch {
      return false;
    }
  }),
);
const RemoteEnvironment = Schema.Struct({
  GITHUB_ACTIONS: Schema.Literal("true"),
  MIGRATION_DATABASE_URL: Schema.Redacted(Origin),
});
export const migrationOrigin = (environment: unknown) =>
  Schema.decodeUnknown(RemoteEnvironment)(environment).pipe(
    Effect.map((value) => {
      const url = new URL(Redacted.value(value.MIGRATION_DATABASE_URL));
      url.port = "5432";
      url.searchParams.set("sslmode", "verify-full");
      return Redacted.make(url.toString());
    }),
    Effect.mapError(() => new MigrationError({ stage: "target" })),
  );
export const redactMigrationOutput = (
  output: string,
  credential: Option.Option<Redacted.Redacted>,
) => {
  let safe = output.replace(
    /postgres(?:ql)?:\/\/[^\s"'<>]+/gi,
    "[REDACTED_DATABASE_URL]",
  );
  if (Option.isSome(credential)) {
    const raw = Redacted.value(credential.value);
    const url = new URL(raw);
    const password = decodeURIComponent(url.password);
    for (const value of [
      raw,
      url.password,
      password,
      JSON.stringify(password).slice(1, -1),
    ]) {
      if (value.length > 0) safe = safe.replaceAll(value, "[REDACTED]");
    }
  }
  return safe;
};
export class MigrationProcess extends Context.Tag(
  "@agentforum/tooling/MigrationProcess",
)<
  MigrationProcess,
  {
    readonly run: (
      stage: "generate" | "migrate",
      config: string,
      credential: Option.Option<Redacted.Redacted>,
    ) => Effect.Effect<void, MigrationError>;
  }
>() {}
export const migrationProcessLayer = Layer.succeed(MigrationProcess, {
  run: (stage, config, credential) =>
    Effect.scoped(
      Effect.gen(function* () {
        const lease = yield* ownedProcess(
          "pnpm",
          ["exec", "drizzle-kit", stage, "--config", config],
          { output: "capture", environment: {} },
        );
        const result = yield* Effect.promise(() => lease.completion).pipe(
          Effect.timeoutFail({
            duration: "120 seconds",
            onTimeout: () => new MigrationError({ stage }),
          }),
        );
        yield* Effect.filterOrFail(
          Effect.succeed(result),
          (value) => !value.overflow,
          () => new MigrationError({ stage }),
        );
        yield* Effect.sync(() => {
          process.stdout.write(
            redactMigrationOutput(result.stdout, credential),
          );
          process.stderr.write(
            redactMigrationOutput(result.stderr, credential),
          );
        });
        yield* Effect.filterOrFail(
          Effect.succeed(result.code),
          (code) => code === 0,
          () => new MigrationError({ stage }),
        );
      }),
    ),
});
const configLease = (config: Config) =>
  Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => mkdtemp(join(tmpdir(), "agentforum-migration-")),
        catch: () => new MigrationError({ stage: "configuration" }),
      }),
      (directory) =>
        Effect.promise(() => rm(directory, { recursive: true, force: true })),
    );
    const path = join(directory, "drizzle.config.ts");
    yield* Effect.tryPromise({
      try: () =>
        writeFile(path, `export default ${JSON.stringify(config)};\n`, {
          mode: 0o600,
        }),
      catch: () => new MigrationError({ stage: "configuration" }),
    });
    return path;
  });
export const generateMigration = (schema: string, directory: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const process = yield* MigrationProcess;
      const config = yield* configLease({
        ...migrationLayout,
        schema: resolve(schema),
        out: resolve(directory),
      });
      yield* process.run("generate", config, Option.none());
    }),
  );
const migrate = (url: Redacted.Redacted, directory: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const process = yield* MigrationProcess;
      const config = yield* configLease({
        ...migrationLayout,
        schema: resolve(migrationLayout.schema),
        out: resolve(directory),
        dbCredentials: { url: Redacted.value(url) },
      });
      yield* process.run("migrate", config, Option.some(url));
    }),
  );
export const migrateOwnedLocalDatabase = (
  descriptor: unknown,
  directory = migrationLayout.out,
) =>
  ownedLocalDatabaseUrl(descriptor).pipe(
    Effect.mapError(() => new MigrationError({ stage: "target" })),
    Effect.flatMap((url) => migrate(url, directory)),
  );
export const migrateOrigin = (environment: unknown) =>
  migrationOrigin(environment).pipe(
    Effect.flatMap((url) => migrate(url, migrationLayout.out)),
  );

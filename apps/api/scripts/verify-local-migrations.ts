import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Data, Effect, Exit } from "effect";
import { LocalPostgres, resetOwnedLocalDatabase } from "./local-postgres.js";
import { generateMigration, migrateOwnedLocalDatabase } from "./migrations.js";
class MigrationVerificationError extends Data.TaggedError(
  "MigrationVerificationError",
) {}
const assertFixture = `DO $probe$ BEGIN
  IF to_regclass('public.agentforum_adapter_probe') IS NULL THEN RAISE EXCEPTION 'Fixture table absent'; END IF;
  IF (SELECT count(*) FROM drizzle.__drizzle_migrations) <> 1 THEN RAISE EXCEPTION 'Migration journal mismatch'; END IF;
END $probe$`;
export const verifyLocalMigrations = Effect.scoped(
  Effect.gen(function* () {
    const postgres = yield* LocalPostgres;
    const directory = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => mkdtemp(join(tmpdir(), "agentforum-migration-proof-")),
        catch: () => new MigrationVerificationError(),
      }),
      (directory) =>
        Effect.promise(() => rm(directory, { recursive: true, force: true })),
    );
    // Apply the genuine repository baseline, then isolate the nonempty fixture proof.
    yield* migrateOwnedLocalDatabase(postgres);
    yield* resetOwnedLocalDatabase(postgres);
    yield* generateMigration("test/fixtures/database-schema.ts", directory);
    yield* migrateOwnedLocalDatabase(postgres, directory);
    yield* postgres.execute(assertFixture);
    yield* postgres.execute(
      `INSERT INTO agentforum_adapter_probe VALUES ('migration-probe','{"verified":true}')`,
    );
    yield* migrateOwnedLocalDatabase(postgres, directory);
    yield* postgres.execute(assertFixture);
    for (const invalid of [
      {
        ...postgres,
        port: postgres.port === 65535 ? 65534 : postgres.port + 1,
      },
      { ...postgres, id: "0".repeat(64) },
    ]) {
      const rejected = yield* Effect.exit(resetOwnedLocalDatabase(invalid));
      yield* Effect.filterOrFail(
        Effect.succeed(rejected),
        Exit.isFailure,
        () => new MigrationVerificationError(),
      );
      yield* postgres.execute(
        `DO $probe$ BEGIN IF (SELECT count(*) FROM agentforum_adapter_probe WHERE id='migration-probe') <> 1 THEN RAISE EXCEPTION 'Protected fixture changed'; END IF; END $probe$`,
      );
    }
    yield* resetOwnedLocalDatabase(postgres);
    yield* postgres.execute(
      `DO $probe$ BEGIN IF to_regclass('public.agentforum_adapter_probe') IS NOT NULL OR to_regnamespace('drizzle') IS NOT NULL THEN RAISE EXCEPTION 'Reset retained schema or journal'; END IF; END $probe$`,
    );
    yield* migrateOwnedLocalDatabase(postgres, directory);
    yield* postgres.execute(assertFixture);
    yield* Effect.logInfo("real_local_migration_and_reset_verification_passed");
  }),
);

import { Effect, Exit } from "effect";
import { resetOwnedLocalDatabase } from "./local-postgres.js";
import {
  LocalDatabaseCommandError,
  readLocalDescriptor,
} from "./local-descriptor.js";
import {
  migrateOwnedLocalDatabase,
  migrationProcessLayer,
} from "./migrations.js";
const result = await Effect.runPromiseExit(
  Effect.gen(function* () {
    yield* Effect.filterOrFail(
      Effect.succeed(process.argv.slice(2)),
      (args) => args.length === 0,
      () => new LocalDatabaseCommandError(),
    );
    const descriptor = yield* readLocalDescriptor;
    yield* resetOwnedLocalDatabase(descriptor);
    yield* migrateOwnedLocalDatabase(descriptor);
    yield* Effect.logInfo(
      "Owned agentforum_local database and migration journal reset and migrated",
    );
  }).pipe(Effect.provide(migrationProcessLayer)),
);
if (Exit.isFailure(result)) {
  console.error(
    "Local reset refused or failed. It accepts no URL or database-name arguments and requires the live owned local descriptor; no remote target is selected.",
  );
  process.exitCode = 1;
}

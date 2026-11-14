import { Effect, Exit } from "effect";
import { migrationLayout } from "./migration-layout.js";
import {
  checkMigrationHistory,
  checkMigrationSnapshot,
  migrationBaseCommit,
  migrationSqlParserLayer,
  readGitMigrationSnapshot,
  readMigrationSnapshot,
} from "./migration-safety.js";

const result = await Effect.runPromiseExit(
  Effect.gen(function* () {
    const base = yield* migrationBaseCommit(process.argv.slice(2));
    const previous = yield* readGitMigrationSnapshot(base);
    const current = yield* readMigrationSnapshot(migrationLayout.out);
    yield* checkMigrationHistory(previous, current);
    yield* checkMigrationSnapshot(current);
  }).pipe(Effect.provide(migrationSqlParserLayer)),
);
if (Exit.isFailure(result)) {
  console.error(
    "Migration safety failed: require append-only history and supported additive SQL. See DATABASE.md; SQL and dependency errors are not printed.",
  );
  process.exitCode = 1;
} else {
  console.log(
    "Migration safety passed: append-only history and supported additive SQL. This is not deployed migration or lock/latency evidence.",
  );
}

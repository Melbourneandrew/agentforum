import { Effect, Exit } from "effect";
import { migrateOrigin, migrationProcessLayer } from "./migrations.js";
const outcome = await Effect.runPromiseExit(
  migrateOrigin(process.env).pipe(Effect.provide(migrationProcessLayer)),
);
if (Exit.isFailure(outcome)) {
  console.error(
    "Database migration failed. Use dedicated direct-origin credentials on port 5432 in authorized GitHub Actions; no runtime binding fallback is supported.",
  );
  process.exitCode = 1;
}

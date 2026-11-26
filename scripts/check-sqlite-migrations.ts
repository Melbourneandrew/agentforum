import { resolve } from "node:path";
import {
  checkSqliteMigrations,
  checkOperationalMigrations,
  SqliteMigrationError,
} from "./sqlite-migrations.js";

try {
  const [base, ...extra] = process.argv.slice(2);
  if (base === undefined || extra.length !== 0)
    throw new SqliteMigrationError("history");
  const report = await checkSqliteMigrations(
    resolve(import.meta.dirname, ".."),
    base,
  );
  await checkOperationalMigrations(resolve(import.meta.dirname, ".."), base);
  console.log(
    `SQLite migration safety passed: ${String(report.migrations)} migrations, ${String(report.statements)} statements; trusted-base history and native SQLite/Wrangler replay.`,
  );
} catch (error) {
  console.error(
    error instanceof SqliteMigrationError
      ? error.message
      : "SQLite migration safety failed",
  );
  process.exitCode = 1;
}

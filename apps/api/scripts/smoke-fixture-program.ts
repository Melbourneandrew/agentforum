import { sql } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { DirectDatabase } from "../src/database/database.js";
import { createProbeTable } from "../test/fixtures/transaction-probe.js";
export const SmokeRole = Schema.String.pipe(
  Schema.pattern(/^[a-z_][a-z0-9_]{0,62}$/),
);
export const prepareSmokeFixture = (role: string) =>
  Effect.flatMap(DirectDatabase, (database) =>
    database.transaction((session) =>
      session
        .execute(() => createProbeTable, Schema.Never)
        .pipe(
          Effect.zipRight(
            session.execute(
              () =>
                sql`GRANT SELECT, INSERT, DELETE ON TABLE agentforum_adapter_probe TO ${sql.identifier(role)}`,
              Schema.Never,
            ),
          ),
        ),
    ),
  );
export const cleanupSmokeFixture = Effect.flatMap(DirectDatabase, (database) =>
  database.execute(
    () => sql`DROP TABLE IF EXISTS agentforum_adapter_probe`,
    Schema.Never,
  ),
);

import { Schema } from "effect";
export const ConnectionInfo = Schema.Struct({
  pid: Schema.Int,
  database: Schema.String,
});

import { jsonb, pgTable, text } from "drizzle-orm/pg-core";
// Synthetic verification table only; never part of the product schema baseline.
export const databaseProbe = pgTable("agentforum_adapter_probe", {
  id: text("id").primaryKey(),
  payload: jsonb("payload").notNull(),
});

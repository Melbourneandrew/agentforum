import { sql } from "drizzle-orm";
import {
  check,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

// One identity has exactly one issued credential. Keeping their mandatory fields
// in one row prevents a reserved identity without credential material, even at
// the SQL boundary. Public projections must never select credential columns.
export const agents = pgTable(
  "agents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: varchar("name", { length: 39 }).notNull(),
    canonicalName: text("canonical_name")
      .generatedAlwaysAs(sql`lower(name COLLATE "C")`)
      .notNull(),
    keyVersion: varchar("key_version", { length: 128 }).notNull(),
    lookupId: varchar("lookup_id", { length: 128 }).notNull(),
    keyDigest: varchar("key_digest", { length: 64 }).notNull(),
    pepperVersion: varchar("pepper_version", { length: 128 }).notNull(),
  },
  (table) => [
    uniqueIndex("agents_canonical_name_unique").on(table.canonicalName),
    uniqueIndex("agents_credential_lookup_unique").on(
      table.keyVersion,
      table.lookupId,
    ),
    check(
      "agents_name_grammar",
      sql`(${table.name} COLLATE "C") ~ '^[A-Za-z0-9]([A-Za-z0-9-]{0,37}[A-Za-z0-9])?$' AND position('--' in ${table.name}) = 0`,
    ),
    check(
      "agents_digest_sha256_hex",
      sql`length(${table.keyDigest}) = 64 AND (${table.keyDigest} COLLATE "C") ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "agents_credential_metadata_nonempty",
      sql`length(${table.keyVersion}) > 0 AND length(${table.lookupId}) > 0 AND length(${table.pepperVersion}) > 0`,
    ),
  ],
);

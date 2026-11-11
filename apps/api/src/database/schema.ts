import { sql } from "drizzle-orm";
import {
  bigint,
  integer,
  jsonb,
  index,
  timestamp,
  foreignKey,
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

export const publicationCounter = pgTable(
  "publication_counter",
  {
    id: integer("id").primaryKey(),
    value: bigint("value", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
  },
  (table) => [
    check(
      "publication_counter_singleton",
      sql`${table.id} = 1 AND ${table.value} >= 0`,
    ),
  ],
);

export const posts = pgTable(
  "posts",
  {
    id: varchar("id", { length: 21 }).primaryKey(),
    authorId: uuid("author_id")
      .notNull()
      .references(() => agents.id),
    authorName: varchar("author_name", { length: 39 }).notNull(),
    body: text("body").notNull(),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    replyToId: varchar("reply_to_id", { length: 21 }),
    publishedAt: timestamp("published_at", {
      withTimezone: true,
      mode: "string",
      precision: 3,
    }).notNull(),
    publicationOrder: bigint("publication_order", { mode: "bigint" }).notNull(),
  },
  (table) => [
    foreignKey({
      name: "posts_parent_fk",
      columns: [table.replyToId],
      foreignColumns: [table.id],
    }),
    uniqueIndex("posts_publication_order_unique").on(table.publicationOrder),
    index("posts_feed_order_idx").on(table.publicationOrder, table.id),
    index("posts_reply_order_idx").on(
      table.replyToId,
      table.publicationOrder,
      table.id,
    ),
    index("posts_author_order_idx").on(
      table.authorId,
      table.publicationOrder,
      table.id,
    ),
    index("posts_body_trgm_idx").using("gin", table.body.op("gin_trgm_ops")),
    index("posts_metadata_idx").using(
      "gin",
      table.metadata.op("jsonb_path_ops"),
    ),
    check(
      "posts_id_format",
      sql`length(${table.id}) = 21 AND (${table.id} COLLATE "C") ~ '^[A-Za-z0-9_-]{21}$'`,
    ),
    check("posts_order_positive", sql`${table.publicationOrder} > 0`),
    check("posts_body_nonempty", sql`length(${table.body}) > 0`),
    check(
      "posts_metadata_object",
      sql`jsonb_typeof(${table.metadata}) = 'object'`,
    ),
  ],
);

export const postRateLimitEvents = pgTable(
  "post_rate_limit_events",
  {
    postId: varchar("post_id", { length: 21 })
      .primaryKey()
      .references(() => posts.id),
    authorId: uuid("author_id")
      .notNull()
      .references(() => agents.id),
    publishedAt: timestamp("published_at", {
      withTimezone: true,
      mode: "string",
      precision: 3,
    }).notNull(),
  },
  (table) => [
    index("post_rate_events_author_time_idx").on(
      table.authorId,
      table.publishedAt,
    ),
    index("post_rate_events_expiry_idx").on(table.publishedAt, table.authorId),
  ],
);

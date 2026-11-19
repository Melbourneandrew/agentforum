import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";

export const agents = sqliteTable(
  "agents",
  {
    id: text("id").primaryKey().notNull(),
    name: text("name").notNull(),
    canonicalName: text("canonical_name")
      .notNull()
      .generatedAlwaysAs(sql`lower(name)`, { mode: "stored" }),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  },
  (table) => [
    uniqueIndex("agents_canonical_name_unique").on(table.canonicalName),
    check(
      "agents_name_grammar",
      sql`length(${table.name}) BETWEEN 1 AND 39 AND ${table.name} NOT GLOB '*[^A-Za-z0-9-]*' AND substr(${table.name},1,1) GLOB '[A-Za-z0-9]' AND substr(${table.name},-1,1) GLOB '[A-Za-z0-9]' AND instr(${table.name},'--')=0 AND instr(${table.name},char(0))=0`,
    ),
  ],
);
export const credentials = sqliteTable(
  "credentials",
  {
    lookupId: text("lookup_id").primaryKey().notNull(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    digest: text("digest").notNull(),
  },
  (table) => [
    uniqueIndex("credentials_agent_unique").on(table.agentId),
    check(
      "credentials_digest_sha256",
      sql`length(${table.digest})=64 AND ${table.digest} NOT GLOB '*[^0-9a-f]*' AND instr(${table.digest},char(0))=0`,
    ),
    check(
      "credentials_lookup_bound",
      sql`length(${table.lookupId}) BETWEEN 1 AND 128 AND instr(${table.lookupId},char(0))=0`,
    ),
  ],
);
export const posts = sqliteTable(
  "posts",
  {
    // Never select this column directly into JavaScript; use CAST(... AS TEXT).
    publicationOrder: integer("publication_order").primaryKey({
      autoIncrement: true,
    }),
    id: text("id").notNull(),
    authorId: text("author_id")
      .notNull()
      .references(() => agents.id),
    parentId: text("parent_id").references((): AnySQLiteColumn => posts.id),
    body: text("body").notNull(),
    tagCount: integer("tag_count").notNull().default(0),
    publishedAt: text("published_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    publicationWindow: integer("publication_window")
      .notNull()
      .default(sql`(CAST(unixepoch() / 60 AS INTEGER))`),
  },
  (table) => [
    uniqueIndex("posts_public_id_unique").on(table.id),
    index("posts_author_order").on(table.authorId, table.publicationOrder),
    index("posts_parent_order").on(table.parentId, table.publicationOrder),
    index("posts_author_window").on(table.authorId, table.publicationWindow),
    check("posts_body_nonempty", sql`length(CAST(${table.body} AS BLOB))>0`),
    check(
      "posts_id_nano21",
      sql`length(${table.id})=21 AND ${table.id} NOT GLOB '*[^A-Za-z0-9_-]*' AND instr(${table.id},char(0))=0`,
    ),
  ],
);
export const postTags = sqliteTable(
  "post_tags",
  {
    postId: text("post_id")
      .notNull()
      .references(() => posts.id),
    tag: text("tag").notNull(),
    ordinal: integer("ordinal").notNull(),
  },
  (table) => [
    uniqueIndex("post_tags_exact_unique").on(table.postId, table.tag),
    uniqueIndex("post_tags_ordinal_unique").on(table.postId, table.ordinal),
    index("post_tags_lookup").on(table.tag, table.postId),
    check(
      "post_tags_bounds",
      sql`${table.ordinal} BETWEEN 0 AND 31 AND length(CAST(${table.tag} AS BLOB)) BETWEEN 1 AND 256`,
    ),
  ],
);

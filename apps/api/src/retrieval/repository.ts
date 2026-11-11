import { sql, type SQL } from "drizzle-orm";
import { Context, Effect, Layer, Option, Schema } from "effect";
import {
  DirectDatabase,
  directDatabaseLayer,
  databaseBindingsLayer,
  type DatabaseConfigurationError,
  type DatabaseConnectionError,
  type DatabaseConnectionTimeoutError,
  type DatabaseQueryError,
  type DatabaseDecodeError,
  type DatabaseTransactionClosedError,
} from "../database/database.js";
import { posts } from "../database/schema.js";
import { PostRecord } from "../posts/contract.js";
import type { Boundary } from "./cursors.js";
export interface RetrievalQuery {
  readonly id: Option.Option<string>;
  readonly replyTo: Option.Option<string>;
  readonly boundary: Option.Option<Boundary>;
  readonly ascending: boolean;
  readonly limit: number;
}
export type RetrievalPersistenceError =
  | DatabaseConfigurationError
  | DatabaseConnectionError
  | DatabaseConnectionTimeoutError
  | DatabaseQueryError
  | DatabaseDecodeError
  | DatabaseTransactionClosedError;
export class RetrievalRepository extends Context.Tag(
  "@agentforum/api/RetrievalRepository",
)<
  RetrievalRepository,
  {
    readonly select: (
      query: RetrievalQuery,
    ) => Effect.Effect<
      readonly Schema.Schema.Type<typeof PostRecord>[],
      RetrievalPersistenceError
    >;
  }
>() {}
const select = (query: RetrievalQuery) =>
  Effect.flatMap(DirectDatabase, (database) =>
    database.execute(() => {
      const predicates: SQL[] = [sql`true`];
      if (Option.isSome(query.id))
        predicates.push(
          sql`${posts.id} COLLATE "C" = ${query.id.value}::text COLLATE "C"`,
        );
      if (Option.isSome(query.replyTo))
        predicates.push(
          sql`${posts.replyToId} COLLATE "C" = ${query.replyTo.value}::text COLLATE "C"`,
        );
      if (
        Option.isSome(query.boundary) &&
        query.boundary.value.kind === "post"
      ) {
        const boundary = query.boundary.value;
        predicates.push(
          query.ascending
            ? sql`(${posts.publicationOrder}, ${posts.id} COLLATE "C") > (${boundary.publicationOrder}::bigint, ${boundary.postId}::text COLLATE "C")`
            : sql`(${posts.publicationOrder}, ${posts.id} COLLATE "C") < (${boundary.publicationOrder}::bigint, ${boundary.postId}::text COLLATE "C")`,
        );
      }
      const ordering = query.ascending
        ? sql`${posts.publicationOrder} ASC, ${posts.id} COLLATE "C" ASC`
        : sql`${posts.publicationOrder} DESC, ${posts.id} COLLATE "C" DESC`;
      return sql`SELECT ${posts.id} AS id, ${posts.authorId} AS author_id, ${posts.authorName} AS author_name,
 ${posts.body} AS body, ${posts.metadata} AS metadata, ${posts.replyToId} AS reply_to_id,
 ${posts.publicationOrder}::text AS publication_order,
 to_char(${posts.publishedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS published_at
 FROM ${posts} WHERE ${sql.join(predicates, sql` AND `)} ORDER BY ${ordering} LIMIT ${query.limit + 1}`;
    }, PostRecord),
  );
// Acquire direct access only when a validated query is actually executed. Invalid
// signatures, purposes and fingerprints never open a database connection.
export const retrievalRepositoryLayer = (bindings: unknown) =>
  Layer.succeed(RetrievalRepository, {
    select: (query) =>
      select(query).pipe(
        Effect.provide(
          directDatabaseLayer.pipe(
            Layer.provide(databaseBindingsLayer(bindings)),
          ),
        ),
      ),
  });

import type { D1Database } from "@cloudflare/workers-types/index.ts";
import { Context, Data, Effect, Layer, Option, Schema } from "effect";
import {
  AgentName,
  Nano21,
  PublicationOrder,
  Timestamp,
} from "../api/contracts";
import { StorageFailure } from "../database/store";
import { RequestContext } from "../runtime/context";

export const crawlerPageSize = 1000;
const Post = Schema.Struct({
  id: Nano21,
  publicationOrder: PublicationOrder,
  publishedAt: Timestamp,
});
const Identity = Schema.Struct({ name: AgentName });
const Boundary = Schema.String.pipe(
  Schema.pattern(/^(?:0|[1-9][0-9]{0,18})$/),
  Schema.filter((value) => BigInt(value) <= 9223372036854775807n),
);
class InvalidCrawlerSelection extends Data.TaggedError(
  "InvalidCrawlerSelection",
) {}
const checkedLimit = (limit: number) =>
  Number.isSafeInteger(limit) && limit > 0 && limit <= crawlerPageSize;
/** Minimal indexed projections only. No body/Tags/activity/credentials, OFFSET or count guesses. */
export const makeCrawlerStore = (db: D1Database) => {
  const read = (sql: string, values: readonly (string | number)[]) =>
    Effect.tryPromise({
      try: () =>
        db
          .prepare(sql)
          .bind(...values)
          .all(),
      catch: () => new StorageFailure(),
    }).pipe(
      Effect.filterOrFail(
        (result) => result.success,
        () => new StorageFailure(),
      ),
      Effect.map((result) => result.results),
    );
  return {
    nextPost: (after: string) =>
      Effect.gen(function* () {
        if (!Schema.is(Boundary)(after))
          return yield* new InvalidCrawlerSelection();
        const rows = yield* read(
          "SELECT id,CAST(publication_order AS TEXT) AS publicationOrder,published_at AS publishedAt FROM posts WHERE publication_order>CAST(? AS INTEGER) ORDER BY publication_order LIMIT 1",
          [after],
        ).pipe(
          Effect.flatMap(Schema.decodeUnknown(Schema.Array(Post))),
          Effect.mapError(() => new StorageFailure()),
        );
        return Option.fromNullable(rows[0]);
      }),
    postRange: (after: string, through: string, limit = crawlerPageSize) =>
      Effect.gen(function* () {
        if (
          !Schema.is(Boundary)(after) ||
          !Schema.is(PublicationOrder)(through) ||
          BigInt(after) >= BigInt(through) ||
          !checkedLimit(limit)
        )
          return yield* new InvalidCrawlerSelection();
        const rows = yield* read(
          "SELECT id,CAST(publication_order AS TEXT) AS publicationOrder,published_at AS publishedAt FROM posts WHERE publication_order>CAST(? AS INTEGER) AND publication_order<=CAST(? AS INTEGER) ORDER BY publication_order LIMIT ?",
          [after, through, limit + 1],
        ).pipe(
          Effect.flatMap(Schema.decodeUnknown(Schema.Array(Post))),
          Effect.mapError(() => new StorageFailure()),
        );
        return { posts: rows.slice(0, limit), hasMore: rows.length > limit };
      }),
    identities: (after: Option.Option<string>, limit = crawlerPageSize) =>
      Effect.gen(function* () {
        if (
          !checkedLimit(limit) ||
          (Option.isSome(after) && !Schema.is(AgentName)(after.value))
        )
          return yield* new InvalidCrawlerSelection();
        // canonical_name has an existing unique index; return exact registered spelling.
        const rows = yield* read(
          `SELECT name FROM agents ${Option.isSome(after) ? "WHERE canonical_name>?" : ""} ORDER BY canonical_name LIMIT ?`,
          [
            ...(Option.isSome(after) ? [after.value.toLowerCase()] : []),
            limit + 1,
          ],
        ).pipe(
          Effect.flatMap(Schema.decodeUnknown(Schema.Array(Identity))),
          Effect.mapError(() => new StorageFailure()),
        );
        const agents = rows.slice(0, limit);
        return {
          agents,
          hasMore: rows.length > limit,
          after: Option.fromNullable(agents.at(-1)?.name),
        };
      }),
  };
};
export class CrawlerStore extends Context.Tag("@agentforum/forum/CrawlerStore")<
  CrawlerStore,
  ReturnType<typeof makeCrawlerStore>
>() {}
export const crawlerStoreLayer = Layer.effect(
  CrawlerStore,
  Effect.map(RequestContext, ({ bindings }) => makeCrawlerStore(bindings.DB)),
);

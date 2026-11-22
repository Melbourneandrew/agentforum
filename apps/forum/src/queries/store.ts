import type { D1Database } from "@cloudflare/workers-types/index.ts";
import { Context, Effect, Layer, Option, Schema } from "effect";
import {
  Nano21,
  PublicationOrder,
  Timestamp,
  Utf8Text,
  Tag,
  Tags,
} from "../api/contracts.js";
import { StorageFailure } from "../database/store.js";
import { RequestContext } from "../runtime/context.js";

const Row = Schema.Struct({
  id: Nano21,
  authorId: Nano21,
  parentId: Schema.OptionFromNullOr(Nano21),
  body: Utf8Text,
  publicationOrder: PublicationOrder,
  publishedAt: Timestamp,
});
const TagRow = Schema.Struct({ postId: Nano21, tag: Tag });
export interface ChronologicalSelection {
  readonly author: Option.Option<string>;
  readonly parent: Option.Option<string>;
  readonly order: "newest" | "oldest";
  readonly limit: number;
  readonly boundary: Option.Option<
    | { readonly sequence: string; readonly id: string }
    | { readonly sequence: "0" }
  >;
}
const projection = `id,author_id AS authorId,parent_id AS parentId,body,
  CAST(publication_order AS TEXT) AS publicationOrder,published_at AS publishedAt`;

/** Request-local direct D1 adapter. Two bounded reads, not N+1 per Post. */
export const makeQueryStore = (db: D1Database) => {
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
  const rows = (sql: string, values: readonly (string | number)[]) =>
    read(sql, values).pipe(
      Effect.flatMap(Schema.decodeUnknown(Schema.Array(Row))),
      Effect.mapError(() => new StorageFailure()),
    );
  const hydrate = (selected: readonly (typeof Row.Type)[]) =>
    Effect.gen(function* () {
      if (selected.length === 0) return [];
      const tags = yield* read(
        `SELECT post_id AS postId,tag FROM post_tags WHERE post_id IN (${selected.map(() => "?").join(",")}) ORDER BY post_id COLLATE BINARY,ordinal`,
        selected.map((post) => post.id),
      ).pipe(
        Effect.flatMap(Schema.decodeUnknown(Schema.Array(TagRow))),
        Effect.mapError(() => new StorageFailure()),
      );
      const grouped = new Map<string, string[]>();
      for (const row of tags) {
        const group = grouped.get(row.postId) ?? [];
        group.push(row.tag);
        grouped.set(row.postId, group);
      }
      return yield* Effect.forEach(selected, (post) =>
        Schema.decodeUnknown(Tags)(grouped.get(post.id) ?? []).pipe(
          Effect.map((values) => ({ ...post, tags: values })),
          Effect.mapError(() => new StorageFailure()),
        ),
      );
    });
  return {
    lookup: (id: string) =>
      rows(`SELECT ${projection} FROM posts WHERE id=? LIMIT 1`, [id]).pipe(
        Effect.flatMap(hydrate),
        Effect.map((posts) => Option.fromNullable(posts[0])),
      ),
    page: (input: ChronologicalSelection) =>
      Effect.gen(function* () {
        const conditions: string[] = [];
        const values: (string | number)[] = [];
        if (Option.isSome(input.author)) {
          conditions.push("author_id=?");
          values.push(input.author.value);
        }
        if (Option.isSome(input.parent)) {
          conditions.push("parent_id=?");
          values.push(input.parent.value);
        }
        const ascending = input.order === "oldest";
        if (Option.isSome(input.boundary) && "id" in input.boundary.value) {
          const boundary = input.boundary.value;
          const comparison = ascending ? ">" : "<";
          conditions.push(
            `(publication_order ${comparison} CAST(? AS INTEGER) OR (publication_order=CAST(? AS INTEGER) AND id COLLATE BINARY ${comparison} ?))`,
          );
          values.push(boundary.sequence, boundary.sequence, boundary.id);
        }
        const direction = ascending ? "ASC" : "DESC";
        values.push(input.limit + 1);
        // Only fixed SQL fragments interpolate. All request values are bindings.
        const selected = yield* rows(
          `SELECT ${projection} FROM posts ${conditions.length ? "WHERE " + conditions.join(" AND ") : ""} ORDER BY publication_order ${direction},id COLLATE BINARY ${direction} LIMIT ?`,
          values,
        );
        const posts = yield* hydrate(selected.slice(0, input.limit));
        return { posts, hasMore: selected.length > input.limit };
      }),
  };
};
export class QueryStore extends Context.Tag("@agentforum/forum/QueryStore")<
  QueryStore,
  ReturnType<typeof makeQueryStore>
>() {}
export const queryStoreLayer = Layer.effect(
  QueryStore,
  Effect.map(RequestContext, ({ bindings }) => makeQueryStore(bindings.DB)),
);

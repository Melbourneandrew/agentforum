import { CursorToken, PostId } from "@agentforum/contracts";
import { Effect, Option, Schema } from "effect";
import { ForumRead, ForumReadError } from "./retrieval.js";

// Fixed-size URL state. anchor is the first older-page entry, not a snapshot,
// offset, token decoded by this client, or persisted read history.
export const ForumQuery = Schema.Struct({
  post_id: Schema.optional(PostId),
  reply_to: Schema.optional(PostId),
  cursor: Schema.optional(CursorToken),
  anchor: Schema.optional(CursorToken),
  scan: Schema.optional(CursorToken),
});
export type ForumQuery = Schema.Schema.Type<typeof ForumQuery>;
export const prepareForumQuery = (url: URL) => {
  const entries = [...url.searchParams.entries()];
  return Effect.succeed(entries).pipe(
    Effect.filterOrFail(
      (values) =>
        new TextEncoder().encode(url.href).byteLength <= 14_336 &&
        new Set(values.map(([key]) => key)).size === values.length,
      () => new ForumReadError({ kind: "invalid-request" }),
    ),
    Effect.flatMap((values) =>
      Schema.decodeUnknown(ForumQuery)(Object.fromEntries(values), {
        onExcessProperty: "error",
      }),
    ),
    Effect.filterOrFail(
      (query) =>
        (query.post_id === undefined ||
          (query.cursor === undefined &&
            query.reply_to === undefined &&
            query.anchor === undefined &&
            query.scan === undefined)) &&
        (query.cursor === undefined
          ? query.anchor === undefined && query.scan === undefined
          : query.anchor !== undefined),
      () => new ForumReadError({ kind: "invalid-request" }),
    ),
    Effect.mapError(() => new ForumReadError({ kind: "invalid-request" })),
  );
};
export const feedHref = (state: Omit<ForumQuery, "post_id">) => {
  const query = new URLSearchParams();
  for (const key of ["reply_to", "anchor", "cursor", "scan"] as const) {
    const value = state[key];
    if (value !== undefined) query.set(key, value);
  }
  return query.size === 0 ? "/" : "/?" + query.toString();
};
const invalid = () => new ForumReadError({ kind: "invalid-request" });
const requirePost = <A>(values: readonly A[]) =>
  Effect.succeed(values).pipe(
    Effect.filterOrFail((items) => items.length > 0, invalid),
    Effect.flatMap((items) =>
      Option.match(Option.fromNullable(items[0]), {
        onNone: () => Effect.fail(invalid()),
        onSome: Effect.succeed,
      }),
    ),
  );
// <= 18 API requests per continuation, below native subrequest ceilings.
// Each scan uses API page cursors and compares returned immutable Post IDs;
// freshly signed API cursor strings may differ after key rotation. The only
// string identity check marks the retained initial scan entry, not a boundary.
export const previousScanBatch = 16;
export const locatePrevious = (query: ForumQuery) =>
  Effect.gen(function* () {
    const prepared = yield* Effect.succeed(query).pipe(
      Effect.filterOrFail(
        (
          value,
        ): value is ForumQuery & {
          readonly cursor: string;
          readonly anchor: string;
          readonly scan: string;
        } =>
          value.cursor !== undefined &&
          value.anchor !== undefined &&
          value.scan !== undefined,
        invalid,
      ),
    );
    const reader = yield* ForumRead;
    const selection =
      prepared.reply_to === undefined ? {} : { reply_to: prepared.reply_to };
    const target = yield* reader.search({
      ...selection,
      cursor: prepared.cursor,
      limit: 1,
    });
    const first = yield* requirePost(target.posts);
    // This is genuine ascending resumption used only to identify the immediate
    // newer neighbour. It is never passed as a descending Page Cursor.
    const newer = yield* reader.search({
      ...selection,
      read_cursor: target.read_cursor,
      limit: 1,
    });
    const boundary = yield* requirePost(newer.posts);
    let scan = prepared.scan;
    for (let step = 0; step < previousScanBatch; step++) {
      const candidate = yield* reader.search({ ...selection, cursor: scan });
      const head = yield* requirePost(candidate.posts);
      if (head.id === first.id && scan === prepared.anchor)
        return feedHref(selection); // first page is the fresh default feed
      if (candidate.posts[candidate.posts.length - 1]?.id === boundary.id)
        return feedHref({
          ...selection,
          anchor: prepared.anchor,
          cursor: scan,
        });
      yield* Effect.succeed(candidate).pipe(
        Effect.filterOrFail(
          (value) =>
            !value.posts.some((post) => post.id === boundary.id) &&
            BigInt(head.publication_order) > BigInt(first.publication_order),
          invalid,
        ),
      );
      scan = yield* Option.match(candidate.page_cursor, {
        onNone: () => Effect.fail(invalid()),
        onSome: Effect.succeed,
      });
    }
    return feedHref({
      ...selection,
      anchor: prepared.anchor,
      cursor: prepared.cursor,
      scan,
    });
  });

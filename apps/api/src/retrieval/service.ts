import { Context, Data, Effect, Layer, Option, Schema } from "effect";
import { SearchInput, SearchResult } from "./contract.js";
import {
  Cursors,
  type Boundary,
  type CursorInvalidError,
  type CursorCryptoError,
} from "./cursors.js";
import {
  RetrievalRepository,
  type RetrievalPersistenceError,
} from "./repository.js";
export class SearchInputInvalidError extends Data.TaggedError(
  "SearchInputInvalidError",
) {}
export class SearchPostNotFoundError extends Data.TaggedError(
  "SearchPostNotFoundError",
) {}
export class Retrieval extends Context.Tag("@agentforum/api/Retrieval")<
  Retrieval,
  {
    readonly search: (
      input: unknown,
    ) => Effect.Effect<
      Schema.Schema.Type<typeof SearchResult>,
      | SearchInputInvalidError
      | SearchPostNotFoundError
      | CursorInvalidError
      | CursorCryptoError
      | RetrievalPersistenceError
    >;
  }
>() {}
export const retrievalLayer = Layer.effect(
  Retrieval,
  Effect.gen(function* () {
    const repository = yield* RetrievalRepository;
    const cursors = yield* Cursors;
    return {
      search: (input: unknown) =>
        Effect.gen(function* () {
          const prepared = yield* Schema.decodeUnknown(SearchInput)(input, {
            onExcessProperty: "error",
          }).pipe(Effect.mapError(() => new SearchInputInvalidError()));
          const selection = {
            ...(prepared.id === undefined ? {} : { id: prepared.id }),
            ...(prepared.reply_to === undefined
              ? {}
              : { reply_to: prepared.reply_to }),
          };
          const query = yield* cursors.fingerprint(selection);
          const read = Option.fromNullable(prepared.read_cursor),
            page = Option.fromNullable(prepared.cursor);
          const ascending = Option.isSome(read);
          const ordering = ascending
            ? "chronological_asc"
            : "chronological_desc";
          const token = Option.orElse(read, () => page);
          const boundary = Option.isSome(token)
            ? Option.some(
                (yield* cursors.verify(token.value, {
                  purpose: ascending ? "read" : "page",
                  ordering,
                  query,
                })).boundary,
              )
            : Option.none<Boundary>();
          const rows = yield* repository.select({
            id: Option.fromNullable(prepared.id),
            replyTo: Option.fromNullable(prepared.reply_to),
            boundary,
            ascending,
            limit: prepared.limit,
          });
          // Direct missing-ID indication is distinct from an empty feed or resumed poll.
          yield* Effect.succeed(rows).pipe(
            Effect.filterOrFail(
              (rows) =>
                rows.length > 0 ||
                prepared.id === undefined ||
                Option.isSome(token),
              () => new SearchPostNotFoundError(),
            ),
          );
          const posts = rows.slice(0, prepared.limit),
            hasMore = rows.length > prepared.limit;
          const first = Option.fromNullable(posts[0]),
            last = Option.fromNullable(posts[posts.length - 1]);
          const represented = ascending ? last : first;
          const checkpoint: Boundary = Option.isSome(represented)
            ? {
                kind: "post",
                publicationOrder: represented.value.publication_order,
                postId: represented.value.id,
              }
            : Option.getOrElse(boundary, (): Boundary => ({
                kind: "before_first",
                publicationOrder: "0",
              }));
          const readCursor = yield* cursors.sign({
            purpose: "read",
            ordering: "chronological_asc",
            boundary: checkpoint,
            query,
          });
          const pageCursor =
            hasMore && !ascending && Option.isSome(last)
              ? Option.some(
                  yield* cursors.sign({
                    purpose: "page",
                    ordering,
                    boundary: {
                      kind: "post",
                      publicationOrder: last.value.publication_order,
                      postId: last.value.id,
                    },
                    query,
                  }),
                )
              : Option.none<string>();
          return {
            posts,
            page_cursor: pageCursor,
            read_cursor: readCursor,
            has_more: hasMore,
          };
        }),
    };
  }),
);

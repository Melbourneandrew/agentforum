import { AgentDirectory, agentDirectoryLayer } from "../agents/service.js";
import { Effect, Layer, Option } from "effect";
import { ForumQueries } from "../api/services.js";
import {
  BadRequest,
  NotFound,
  Unavailable,
  problemCatalog,
} from "../api/problems.js";
import {
  checkedOffsetAddition,
  type InvalidOffset,
  decodeCursor,
  encodeCursor,
  selectionFingerprint,
  type SearchInput,
} from "../api/query.js";
import { RequestContext } from "../runtime/context.js";
import { compileTextQuery } from "./text.js";
import { QueryStore, type ChronologicalSelection } from "./store.js";

const queryLayer = Layer.effect(
  ForumQueries,
  Effect.gen(function* () {
    const store = yield* QueryStore;
    const directory = yield* AgentDirectory;
    const { origin, correlationId } = yield* RequestContext;
    const fields = (
      code: "invalid-request" | "not-found" | "not-implemented" | "unavailable",
    ) => ({
      type: `${origin}/docs/problems/${code}.json`,
      title: code.replaceAll("-", " "),
      detail: problemCatalog[code],
      instance: `urn:uuid:${correlationId}`,
    });
    const badRequest = () =>
      new BadRequest({
        ...fields("invalid-request"),
        status: 400,
        invalidParams: [{ location: "payload" }],
      });
    const unavailable = () =>
      new Unavailable({ ...fields("unavailable"), status: 503 });
    return {
      search: (input: SearchInput) =>
        Effect.gen(function* () {
          if (input.resource === "agents")
            return yield* directory.search(input);
          if ("id" in input) {
            const post = yield* store
              .lookup(input.id)
              .pipe(Effect.mapError(unavailable));
            if (Option.isNone(post))
              return yield* new NotFound({
                ...fields("not-found"),
                status: 404,
              });
            const { parentId, ...value } = post.value;
            return {
              resource: "posts" as const,
              post: { ...value, reply_to: Option.getOrNull(parentId) },
            };
          }
          const match = yield* Option.match(input.q, {
            onNone: () => Effect.succeed(Option.none<string>()),
            onSome: (q) =>
              compileTextQuery(q).pipe(
                Effect.map(Option.some),
                Effect.mapError(badRequest),
              ),
          });
          const fingerprint = yield* selectionFingerprint(input).pipe(
            Effect.mapError(unavailable),
          );
          const read = input.readCursor;
          const token = Option.orElse(input.pageCursor, () => read);
          const order =
            input.order === "relevance"
              ? "relevance"
              : Option.isSome(read) || input.order === "oldest"
                ? "oldest"
                : "newest";
          let offset = 0;
          let boundary: ChronologicalSelection["boundary"] = Option.none();
          if (Option.isSome(token)) {
            const cursor = yield* decodeCursor(token.value).pipe(
              Effect.mapError(badRequest),
            );
            if (
              cursor.resource !== "posts" ||
              cursor.fingerprint !== fingerprint ||
              cursor.purpose !== (Option.isSome(read) ? "read" : "page") ||
              cursor.order !== order
            )
              return yield* badRequest();
            if ("boundary" in cursor) boundary = Option.some(cursor.boundary);
            else offset = cursor.offset;
          }
          const page = yield* store
            .page({
              author: input.author,
              parent: input.parent,
              order,
              limit: input.limit,
              boundary,
              tags: input.tags,
              tagMatch: input.tagMatch,
              match,
              offset,
            })
            .pipe(Effect.mapError(unavailable));
          const common = {
            version: 1 as const,
            api: "v1" as const,
            resource: "posts" as const,
            fingerprint,
          };
          if (order === "relevance") {
            const addition: Effect.Effect<number, InvalidOffset> =
              checkedOffsetAddition(offset, page.posts.length);
            const nextOffset = yield* addition.pipe(
              Effect.mapError(badRequest),
            );
            const pageCursor = page.hasMore
              ? yield* encodeCursor({
                  ...common,
                  purpose: "page",
                  order: "relevance",
                  offset: nextOffset,
                }).pipe(Effect.mapError(unavailable))
              : null;
            return {
              resource: "posts" as const,
              posts: page.posts.map(({ parentId, ...post }) => ({
                ...post,
                reply_to: Option.getOrNull(parentId),
              })),
              pageCursor,
            };
          }
          const last = Option.fromNullable(page.posts.at(-1));
          const greatest =
            order === "newest" ? Option.fromNullable(page.posts[0]) : last;
          const position = (post: {
            readonly publicationOrder: string;
            readonly id: string;
          }) => ({ sequence: post.publicationOrder, id: post.id });
          const pageCursor =
            page.hasMore && Option.isSome(last)
              ? yield* encodeCursor({
                  ...common,
                  purpose: "page",
                  order,
                  boundary: position(last.value),
                }).pipe(Effect.mapError(unavailable))
              : null;
          const readCursor =
            Option.isNone(greatest) && Option.isSome(read)
              ? read.value
              : yield* encodeCursor({
                  ...common,
                  purpose: "read",
                  order: "oldest",
                  boundary: Option.match(greatest, {
                    onNone: () => ({ sequence: "0" as const }),
                    onSome: position,
                  }),
                }).pipe(Effect.mapError(unavailable));
          return {
            resource: "posts" as const,
            posts: page.posts.map(({ parentId, ...post }) => ({
              ...post,
              reply_to: Option.getOrNull(parentId),
            })),
            pageCursor,
            readCursor,
          };
        }),
    };
  }),
);

export const forumQueriesLayer = queryLayer.pipe(
  Layer.provide(agentDirectoryLayer),
);

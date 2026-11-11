import { env } from "cloudflare:workers";
import { CursorToken, PostId } from "@agentforum/contracts";
import { Effect, Option, Schema } from "effect";
import {
  ForumRead,
  ForumReadError,
  forumReadLive,
} from "../../src/forum/retrieval.js";
import { streamForumPage } from "../../src/forum/stream.js";
import { ForumFailure, PostDetail, PostsTable } from "../../src/forum/views.js";

export const runtime = "edge";
const Query = Schema.Struct({
  post_id: Schema.optional(PostId),
  reply_to: Schema.optional(PostId),
  cursor: Schema.optional(CursorToken),
});
export default function observation(request: Request) {
  if (request.method === "HEAD") return new Response(null);
  if (request.method !== "GET")
    return new Response("Method not allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD, OPTIONS" },
    });
  const url = new URL(request.url);
  const entries = [...url.searchParams.entries()];
  const preparedQuery = Effect.succeed(entries).pipe(
    Effect.filterOrFail(
      (values) =>
        new TextEncoder().encode(url.href).byteLength <= 14_336 &&
        new Set(values.map(([key]) => key)).size === values.length,
      () => new ForumReadError({ kind: "invalid-request" }),
    ),
    Effect.flatMap((values) =>
      Schema.decodeUnknown(Query)(Object.fromEntries(values), {
        onExcessProperty: "error",
      }),
    ),
    Effect.filterOrFail(
      (query) =>
        query.post_id === undefined ||
        (query.cursor === undefined && query.reply_to === undefined),
      () => new ForumReadError({ kind: "invalid-request" }),
    ),
    Effect.mapError(() => new ForumReadError({ kind: "invalid-request" })),
  );
  const content = Effect.gen(function* () {
    const query = yield* preparedQuery;
    const reader = yield* ForumRead;
    if (query.post_id !== undefined) {
      const detail = yield* reader.search({ id: query.post_id });
      const found = Option.fromNullable(detail.posts[0]);
      if (Option.isNone(found))
        return (
          <ForumFailure missing={true} retry={"/posts/" + query.post_id} />
        );
      const replies = yield* reader.search({ reply_to: found.value.id });
      return <PostDetail post={found.value} replies={replies} />;
    }
    const selection =
      query.reply_to === undefined ? {} : { reply_to: query.reply_to };
    const results = yield* reader.search({
      ...selection,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    });
    const next = Option.map(results.page_cursor, (cursor) => {
      const parameters = new URLSearchParams({ ...selection, cursor });
      return "/?" + parameters.toString();
    });
    // Previous-page resolution is integrated in the next navigation milestone;
    // do not invent offsets, forge tokens or persist a history/read ledger.
    return (
      <PostsTable
        posts={results.posts}
        next={next}
        previous={Option.none()}
        parent={Option.fromNullable(query.reply_to)}
      />
    );
  }).pipe(
    Effect.provide(forumReadLive(env)),
    Effect.catchTag("ForumReadError", (error) =>
      Effect.succeed(
        <ForumFailure
          missing={error.kind === "not-found"}
          retry={
            url.pathname === "/" || url.pathname.startsWith("/posts/")
              ? url.pathname + url.search
              : "/"
          }
        />,
      ),
    ),
  );
  return streamForumPage(request, content);
}

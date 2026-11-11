import { env } from "cloudflare:workers";
import { Effect, Option } from "effect";
import { ForumRead, forumReadLive } from "../../src/forum/retrieval.js";
import { streamForumPage } from "../../src/forum/stream.js";
import { ForumFailure, PostDetail, PostsTable } from "../../src/forum/views.js";

import {
  prepareForumQuery,
  feedHref,
  locatePrevious,
} from "../../src/forum/navigation.js";
export const runtime = "edge";
export default function observation(request: Request) {
  if (request.method === "HEAD") return new Response(null);
  if (request.method !== "GET")
    return new Response("Method not allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD, OPTIONS" },
    });
  const url = new URL(request.url);
  const preparedQuery = prepareForumQuery(url);
  const content = Effect.gen(function* () {
    const query = yield* preparedQuery;
    if (query.scan !== undefined) {
      const destination = yield* locatePrevious(query);
      return (
        <section className="forum-card forum-empty" role="status">
          <meta httpEquiv="refresh" content={"0;url=" + destination} />
          <h1>Locating previous page</h1>
          <p>
            Following the original API keysets without storing browsing history.
          </p>
          <a href={destination}>Continue to previous page</a>
        </section>
      );
    }
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
    const next = Option.map(results.page_cursor, (cursor) =>
      feedHref({ ...selection, cursor, anchor: query.anchor ?? cursor }),
    );
    const previous =
      query.cursor === undefined || query.anchor === undefined
        ? Option.none<string>()
        : Option.some(
            feedHref({
              ...selection,
              cursor: query.cursor,
              anchor: query.anchor,
              scan: query.anchor,
            }),
          );
    return (
      <PostsTable
        posts={results.posts}
        next={next}
        previous={previous}
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

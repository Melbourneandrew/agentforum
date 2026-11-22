import { Data, Effect, Option, Schema } from "effect";
import { Nano21, type PostResult } from "../../src/api/contracts.js";
import { decodeSearch } from "../../src/api/query.js";
import type { PageContext } from "../../src/runtime/context.js";
import {
  markdownRendererLayer,
  renderMarkdown,
} from "../../src/rendering/markdown.js";

export const replyPageSize = 10;
export const postPageHeaders = { "Cache-Control": "no-store, private" };
import { postHref } from "./links";

export interface PostEntry {
  readonly post: typeof PostResult.Type;
  readonly rendering:
    | { readonly status: "rendered"; readonly html: string }
    | { readonly status: "fallback" };
}
export interface PageFailure {
  readonly kind: "failure";
  readonly status: number;
  readonly title: string;
  readonly message: string;
  readonly retryHref: string;
}
export type Replies =
  | {
      readonly kind: "ready";
      readonly entries: readonly PostEntry[];
      readonly next: string | null;
      readonly paged: boolean;
    }
  | PageFailure;
export type PostPageModel =
  | PageFailure
  | {
      readonly kind: "post";
      readonly entry: PostEntry;
      readonly replies: Replies;
    };
export interface PostPageResponse {
  readonly status: number;
  readonly model: PostPageModel;
}
class InvalidPostPage extends Data.TaggedError("InvalidPostPage") {}
class UnexpectedPostResult extends Data.TaggedError("UnexpectedPostResult") {}
const failure = (status: number, retryHref: string): PageFailure => ({
  kind: "failure",
  status,
  retryHref,
  title:
    status === 404
      ? "Post not found"
      : status === 400
        ? "Invalid Post page"
        : "Post could not be loaded",
  message:
    status === 404
      ? "This Post does not exist in this installation."
      : status === 400
        ? "The Post address or reply cursor is invalid."
        : "The requested content is unavailable. Please try again.",
});
// Only safe classifications cross into HTML, never dependency/schema error text.
const statusOf = (error: { readonly _tag: string }) => {
  switch (error._tag) {
    case "NotFound":
      return 404;
    case "InvalidPostPage":
    case "InvalidSearch":
    case "BadRequest":
      return 400;
    case "NotImplemented":
      return 501;
    case "Unavailable":
    case "FingerprintFailure":
      return 503;
    default:
      return 500;
  }
};
const renderEntry = (post: typeof PostResult.Type) =>
  renderMarkdown(post.body).pipe(
    Effect.map((rendering): PostEntry => ({ post, rendering })),
  );

/** Public read bridge only: no bindings, writes, loopback HTTP or alternate query model. */
export const loadPostPage = (
  request: Request,
  postId: unknown,
  context: PageContext,
): Promise<PostPageResponse> => {
  const retry = Schema.is(Nano21)(postId) ? postHref(postId) : "/";
  const program = Effect.gen(function* () {
    const url = new URL(request.url);
    if (
      [...url.searchParams.keys()].some((key) => key !== "replyCursor") ||
      url.searchParams.getAll("replyCursor").length > 1
    )
      return yield* Effect.fail(new InvalidPostPage());
    // Validate all state before reading. Shared decoder binds cursors to this parent.
    const lookup = yield* decodeSearch({ id: postId });
    if (lookup.resource !== "posts" || !("id" in lookup))
      return yield* Effect.fail(new InvalidPostPage());
    const cursor = Option.fromNullable(url.searchParams.get("replyCursor"));
    const repliesInput = yield* decodeSearch({
      parent: lookup.id,
      order: "newest",
      limit: replyPageSize,
      ...(Option.isSome(cursor) ? { pageCursor: cursor.value } : {}),
    });
    const result = yield* context.search(lookup);
    if (result.resource !== "posts" || !("post" in result))
      return yield* Effect.fail(new UnexpectedPostResult());
    const entry = yield* renderEntry(result.post);
    const repliesResult = yield* context
      .search(repliesInput)
      .pipe(Effect.either);
    if (repliesResult._tag === "Left") {
      const status = statusOf(repliesResult.left);
      return {
        status,
        model: {
          kind: "post",
          entry,
          replies: failure(status, postHref(lookup.id, cursor)),
        },
      } satisfies PostPageResponse;
    }
    const page = repliesResult.right;
    if (page.resource !== "posts" || !("posts" in page))
      return yield* Effect.fail(new UnexpectedPostResult());
    const entries = yield* Effect.forEach(page.posts, renderEntry, {
      concurrency: 1,
    });
    return {
      status: 200,
      model: {
        kind: "post",
        entry,
        replies: {
          kind: "ready",
          entries,
          paged: Option.isSome(cursor),
          next:
            page.pageCursor === null
              ? null
              : postHref(lookup.id, Option.some(page.pageCursor)),
        },
      },
    } satisfies PostPageResponse;
  });
  return Effect.runPromise(
    program.pipe(
      Effect.catchAll((error) =>
        Effect.succeed({
          status: statusOf(error),
          model: failure(statusOf(error), retry),
        } satisfies PostPageResponse),
      ),
      Effect.catchAllCause(() =>
        Effect.succeed({
          status: 500,
          model: failure(500, retry),
        } satisfies PostPageResponse),
      ),
      Effect.provide(markdownRendererLayer()),
    ),
    { signal: request.signal },
  );
};

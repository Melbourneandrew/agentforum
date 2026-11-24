import { Data, Effect, Option } from "effect";
import type { PostResult } from "../../src/api/contracts.js";
import type { PageContext } from "../../src/runtime/context.js";
import {
  browseHref,
  decodeBrowseState,
  firstPage,
  nextPageHref,
  previousPageHref,
  type BrowseState,
} from "./state";

export const browseHeaders = { "Cache-Control": "no-store, private" };
export interface BrowseControls {
  readonly q: string;
  readonly author: string;
  readonly parent: string;
  readonly tags: readonly string[];
  readonly tagMatch: string;
  readonly order: string;
}
export type BrowseModel = {
  readonly controls: BrowseControls;
} & (
  | {
      readonly kind: "ready";
      readonly posts: readonly (typeof PostResult.Type)[];
      readonly filtered: boolean;
      readonly next: string | null;
      readonly previous: string | null;
      readonly first: string;
    }
  | {
      readonly kind: "failure";
      readonly title: string;
      readonly message: string;
      readonly retry: string;
    }
);
export interface BrowseResponse {
  readonly status: number;
  readonly model: BrowseModel;
}
class UnexpectedBrowseResult extends Data.TaggedError(
  "UnexpectedBrowseResult",
) {}
const controls = (url: URL): BrowseControls => ({
  q: url.searchParams.get("q") ?? "",
  author: url.searchParams.get("author") ?? "",
  parent: url.searchParams.get("parent") ?? "",
  tags: url.searchParams.getAll("tag").filter((tag) => tag !== ""),
  tagMatch: url.searchParams.get("tagMatch") ?? "all",
  order: url.searchParams.get("order") ?? "newest",
});
const failure = (
  status: number,
  values: BrowseControls,
  retry: string,
): BrowseResponse => ({
  status,
  model: {
    kind: "failure",
    controls: values,
    title: status === 400 ? "Invalid Posts query" : "Posts could not be loaded",
    message:
      status === 400
        ? "The filters, Text Query, ordering or page cursor cannot be used. Edit the controls or return to the first page."
        : "Public Posts are unavailable. Please try again.",
    retry,
  },
});
const statusOf = (error: { readonly _tag: string }) => {
  switch (error._tag) {
    case "InvalidBrowseState":
    case "InvalidSearch":
    case "InvalidTextQuery":
    case "BadRequest":
      return 400;
    case "Unavailable":
    case "FingerprintFailure":
      return 503;
    case "NotImplemented":
      return 501;
    default:
      return 500;
  }
};
const ready = (
  state: BrowseState,
  values: BrowseControls,
  posts: readonly (typeof PostResult.Type)[],
  cursor: string | null,
): BrowseResponse => ({
  status: 200,
  model: {
    kind: "ready",
    controls: values,
    posts,
    filtered:
      Option.isSome(state.selection.q) ||
      Option.isSome(state.selection.author) ||
      Option.isSome(state.selection.parent) ||
      state.selection.tags.length > 0,
    next: cursor === null ? null : nextPageHref(state, cursor),
    previous: Option.getOrNull(previousPageHref(state)),
    first: browseHref(firstPage(state)),
  },
});

/** Direct request-local typed reads only; no ambient DB, fetch, auth or writes. */
export const loadBrowsePage = (request: Request, context: PageContext) => {
  const url = new URL(request.url);
  const values = controls(url);
  const program = Effect.gen(function* () {
    const state = yield* decodeBrowseState(url);
    return yield* context.search(state.selection).pipe(
      Effect.flatMap(
        (result): Effect.Effect<BrowseResponse, UnexpectedBrowseResult> =>
          result.resource === "posts" && "posts" in result
            ? Effect.succeed(
                ready(state, values, result.posts, result.pageCursor),
              )
            : Effect.fail(new UnexpectedBrowseResult()),
      ),
      Effect.catchAll((error) =>
        Effect.succeed(failure(statusOf(error), values, browseHref(state))),
      ),
    );
  });
  return Effect.runPromise(
    program.pipe(
      Effect.catchAll((error) =>
        Effect.succeed(failure(statusOf(error), values, "/")),
      ),
      Effect.catchAllCause(() => Effect.succeed(failure(500, values, "/"))),
    ),
    { signal: request.signal },
  );
};

import { Data, Effect, Option, Schema } from "effect";
import { AgentName, type AgentRecord } from "../../src/api/contracts.js";
import { decodeSearch } from "../../src/api/query.js";
import type { PageContext } from "../../src/runtime/context.js";
import { authorHref, authorsHref } from "./links";

export const authorPageSize = 10;
export const authorPageHeaders = { "Cache-Control": "no-store, private" };
export interface AuthorFailure {
  readonly kind: "failure";
  readonly status: number;
  readonly title: string;
  readonly retryHref: string;
  readonly message: string;
}
export type AuthorPageModel =
  | AuthorFailure
  | { readonly kind: "identity"; readonly agent: typeof AgentRecord.Type }
  | {
      readonly kind: "directory";
      readonly agents: readonly (typeof AgentRecord.Type)[];
      readonly next: string | null;
      readonly paged: boolean;
    };
export interface AuthorPageResponse {
  readonly status: number;
  readonly model: AuthorPageModel;
}
class InvalidAuthorPage extends Data.TaggedError("InvalidAuthorPage") {}
class UnexpectedAuthorResult extends Data.TaggedError(
  "UnexpectedAuthorResult",
) {}
const statusOf = (error: { readonly _tag: string }) => {
  switch (error._tag) {
    case "InvalidAuthorPage":
    case "InvalidSearch":
    case "BadRequest":
      return 400;
    case "NotFound":
      return 404;
    case "Unavailable":
    case "FingerprintFailure":
      return 503;
    case "NotImplemented":
      return 501;
    default:
      return 500;
  }
};
const failure = (status: number, retryHref: string): AuthorPageResponse => ({
  status,
  model: {
    kind: "failure",
    status,
    retryHref,
    title:
      status === 404
        ? "Author not found"
        : status === 400
          ? "Invalid Authors page"
          : "Authors could not be loaded",
    message:
      status === 404
        ? "No such Author exists in this installation."
        : status === 400
          ? "The Author address or directory cursor is invalid."
          : "Public identity information is unavailable. Please try again.",
  },
});

/** Only the existing request-local read port; no bindings, auth, loopback or writes. */
export const loadAuthorPage = (
  request: Request,
  name: unknown,
  context: PageContext,
): Promise<AuthorPageResponse> => {
  const identity = Option.fromNullable(name);
  const reset = Schema.is(AgentName)(name) ? authorHref(name) : authorsHref();
  const program = Effect.gen(function* () {
    const params = new URL(request.url).searchParams;
    if (
      [...params.keys()].some((key) => key !== "pageCursor") ||
      params.getAll("pageCursor").length > 1 ||
      (Option.isSome(identity) && [...params.keys()].length > 0)
    )
      return yield* new InvalidAuthorPage();
    const cursor = Option.fromNullable(params.get("pageCursor"));
    const input = yield* decodeSearch({
      resource: "agents",
      limit: authorPageSize,
      ...(Option.isSome(identity) ? { name: identity.value } : {}),
      ...(Option.isSome(cursor) ? { pageCursor: cursor.value } : {}),
    });
    if (input.resource !== "agents") return yield* new UnexpectedAuthorResult();
    const retry = Option.isSome(input.name)
      ? authorHref(input.name.value)
      : authorsHref(input.pageCursor);
    return yield* context.search(input).pipe(
      Effect.flatMap(
        (result): Effect.Effect<AuthorPageResponse, UnexpectedAuthorResult> => {
          if (result.resource !== "agents")
            return Effect.fail(new UnexpectedAuthorResult());
          if (Option.isSome(input.name)) {
            if (!("agent" in result))
              return Effect.fail(new UnexpectedAuthorResult());
            return Effect.succeed({
              status: 200,
              model: { kind: "identity", agent: result.agent },
            });
          }
          if (!("agents" in result))
            return Effect.fail(new UnexpectedAuthorResult());
          return Effect.succeed({
            status: 200,
            model: {
              kind: "directory",
              agents: result.agents,
              paged: Option.isSome(input.pageCursor),
              next:
                result.pageCursor === null
                  ? null
                  : authorsHref(Option.some(result.pageCursor)),
            },
          });
        },
      ),
      Effect.catchAll((error) =>
        Effect.succeed(failure(statusOf(error), retry)),
      ),
    );
  });
  return Effect.runPromise(
    program.pipe(
      Effect.catchAll((error) =>
        Effect.succeed(failure(statusOf(error), reset)),
      ),
      Effect.catchAllCause(() => Effect.succeed(failure(500, reset))),
    ),
    { signal: request.signal },
  );
};

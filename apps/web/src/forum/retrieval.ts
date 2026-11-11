import { SearchInput, SearchResult } from "@agentforum/contracts";
import { Context, Data, Effect, Layer, Schema } from "effect";

export class ForumReadError extends Data.TaggedError("ForumReadError")<{
  readonly kind:
    | "configuration"
    | "invalid-request"
    | "not-found"
    | "invalid-response"
    | "unavailable";
}> {}
export class ForumTransport extends Context.Tag(
  "@agentforum/web/ForumTransport",
)<
  ForumTransport,
  { readonly get: (url: string) => Effect.Effect<Response, ForumReadError> }
>() {}
export const nativeForumTransportLayer = Layer.succeed(ForumTransport, {
  get: (url) =>
    Effect.tryPromise({
      try: (signal) =>
        fetch(url, {
          method: "GET",
          headers: { Accept: "application/json" },
          redirect: "error",
          signal,
        }),
      catch: () => new ForumReadError({ kind: "unavailable" }),
    }),
});
export class ForumRead extends Context.Tag("@agentforum/web/ForumRead")<
  ForumRead,
  {
    readonly search: (
      input: unknown,
    ) => Effect.Effect<Schema.Schema.Type<typeof SearchResult>, ForumReadError>;
  }
>() {}
const Origin = Schema.String.pipe(
  Schema.filter((value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === "https:" || url.protocol === "http:") &&
        (value === url.origin || value === url.origin + "/")
      );
    } catch {
      return false;
    }
  }),
);
// Fifty maximum-size source-bounded Posts plus server facts/cursors fit below
// this response ceiling. Bound the actual stream, not a Content-Length claim.
export const maxForumResponseBytes = 4 * 1024 * 1024;
const boundedJson = (response: Response) =>
  Effect.acquireUseRelease(
    Effect.try({
      try: () => {
        const reader = response.body?.getReader();
        if (reader === undefined)
          throw new ForumReadError({ kind: "invalid-response" });
        return reader;
      },
      catch: () => new ForumReadError({ kind: "invalid-response" }),
    }),
    (reader) =>
      Effect.tryPromise({
        try: async (): Promise<unknown> => {
          const decoder = new TextDecoder("utf-8", { fatal: true });
          let size = 0;
          let text = "";
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > maxForumResponseBytes)
              throw new ForumReadError({ kind: "invalid-response" });
            text += decoder.decode(chunk.value, { stream: true });
          }
          text += decoder.decode();
          const decoded: unknown = JSON.parse(text);
          return decoded;
        },
        catch: () => new ForumReadError({ kind: "invalid-response" }),
      }),
    (reader) =>
      Effect.tryPromise({
        try: () => reader.cancel(),
        catch: () => new ForumReadError({ kind: "unavailable" }),
      }).pipe(
        Effect.ignore,
        Effect.ensuring(
          Effect.sync(() => {
            reader.releaseLock();
          }),
        ),
      ),
  );
const closeResponse = (response: Response) =>
  Effect.tryPromise({
    try: () => response.body?.cancel() ?? Promise.resolve(),
    catch: () => new ForumReadError({ kind: "unavailable" }),
  }).pipe(Effect.ignore);
export const forumReadLayer = (bindings: unknown) =>
  Layer.effect(
    ForumRead,
    Effect.gen(function* () {
      const { API_ORIGIN: origin } = yield* Schema.decodeUnknown(
        Schema.Struct({ API_ORIGIN: Origin }),
      )(bindings).pipe(
        Effect.mapError(() => new ForumReadError({ kind: "configuration" })),
      );
      const transport = yield* ForumTransport;
      return {
        search: (input: unknown) =>
          Effect.gen(function* () {
            const prepared = yield* Schema.decodeUnknown(SearchInput)(input, {
              onExcessProperty: "error",
            }).pipe(
              Effect.mapError(
                () => new ForumReadError({ kind: "invalid-request" }),
              ),
            );
            const wire = yield* Schema.encode(SearchInput)(prepared).pipe(
              Effect.mapError(
                () => new ForumReadError({ kind: "invalid-request" }),
              ),
            );
            const url = new URL("/v1/search", origin);
            url.searchParams.set("payload", JSON.stringify(wire));
            return yield* Effect.acquireUseRelease(
              transport.get(url.href),
              (response) => {
                if (!response.ok)
                  return Effect.fail(
                    new ForumReadError({
                      kind:
                        response.status === 404
                          ? "not-found"
                          : response.status === 400
                            ? "invalid-request"
                            : "unavailable",
                    }),
                  );
                if (
                  response.headers.get("Content-Type")?.split(";")[0] !==
                  "application/json"
                )
                  return Effect.fail(
                    new ForumReadError({ kind: "invalid-response" }),
                  );
                return boundedJson(response).pipe(
                  Effect.flatMap(Schema.decodeUnknown(SearchResult)),
                  Effect.mapError(
                    () => new ForumReadError({ kind: "invalid-response" }),
                  ),
                );
              },
              closeResponse,
            );
          }),
      };
    }),
  );
export const forumReadLive = (bindings: unknown) =>
  forumReadLayer(bindings).pipe(Layer.provide(nativeForumTransportLayer));

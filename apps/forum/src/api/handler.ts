import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  HttpServer,
  HttpServerResponse,
} from "@effect/platform";
import { Effect, Layer, Schema } from "effect";
import { RequestContext } from "../runtime/context.js";

const FoundationProblem = Schema.Struct({
  type: Schema.String,
  title: Schema.String,
  status: Schema.Literal(501),
  detail: Schema.String,
  instance: Schema.String,
}).pipe(
  HttpApiSchema.withEncoding({
    kind: "Json",
    contentType: "application/problem+json",
  }),
);
export const Api = HttpApi.make("forum")
  .add(
    HttpApiGroup.make("foundation")
      .add(HttpApiEndpoint.get("registerGet", "/v1/register"))
      .add(HttpApiEndpoint.post("registerPost", "/v1/register"))
      .add(HttpApiEndpoint.get("publishGet", "/v1/publish"))
      .add(HttpApiEndpoint.post("publishPost", "/v1/publish"))
      .add(HttpApiEndpoint.get("searchGet", "/v1/search"))
      .add(HttpApiEndpoint.post("searchPost", "/v1/search")),
  )
  .addError(FoundationProblem, { status: 501 });
export const problemResponse = (
  status: number,
  origin: string,
  id: string,
  code: string,
  detail: string,
) =>
  new Response(
    JSON.stringify({
      type: origin
        ? `${origin}/docs/problems/${code}`
        : `https://www.rfc-editor.org/rfc/rfc9110.html#status.${String(status)}`,
      title: code.replaceAll("-", " "),
      status,
      detail,
      instance: `urn:uuid:${id}`,
    }),
    {
      status,
      headers: {
        "Content-Type": "application/problem+json",
        "Cache-Control": "no-store, private",
        "X-Request-Id": id,
      },
    },
  );
export const apiHandler = (
  request: Request,
  context: Layer.Layer<RequestContext>,
) =>
  Effect.gen(function* () {
    const notImplemented = Effect.gen(function* () {
      const { origin, correlationId } = yield* RequestContext;
      return HttpServerResponse.fromWeb(
        problemResponse(
          501,
          origin,
          correlationId,
          "not-implemented",
          "This runtime foundation does not yet implement the forum operations.",
        ),
      );
    });
    const groups = HttpApiBuilder.group(Api, "foundation", (handlers) =>
      handlers
        .handleRaw("registerGet", () => notImplemented)
        .handleRaw("registerPost", () => notImplemented)
        .handleRaw("publishGet", () => notImplemented)
        .handleRaw("publishPost", () => notImplemented)
        .handleRaw("searchGet", () => notImplemented)
        .handleRaw("searchPost", () => notImplemented),
    );
    const handler = HttpApiBuilder.toWebHandler(
      HttpApiBuilder.api(Api).pipe(
        Layer.provide(groups),
        Layer.provideMerge(context),
        Layer.provideMerge(HttpServer.layerContext),
      ),
    );
    return yield* Effect.acquireUseRelease(
      Effect.succeed(handler),
      (app) => Effect.tryPromise(() => app.handler(request)),
      (app) => Effect.promise(() => app.dispose()),
    );
  });

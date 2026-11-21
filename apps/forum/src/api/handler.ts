import {
  HttpApiBuilder,
  HttpServer,
  HttpServerResponse,
} from "@effect/platform";
import { Effect, Layer } from "effect";
import { RequestContext } from "../runtime/context.js";
import { Api } from "./definition.js";
import { problemResponse } from "./problems.js";
import { readDocument, decodePublish, decodeRegister } from "./transport.js";
import { decodeSearch } from "./query.js";
export { Api } from "./definition.js";
export { problemResponse } from "./problems.js";

export const apiHandler = (
  request: Request,
  context: Layer.Layer<RequestContext>,
) =>
  Effect.gen(function* () {
    const { origin, correlationId } = yield* RequestContext.pipe(
      Effect.provide(context),
    );
    const path = new URL(request.url).pathname;
    if (!["/v1/register", "/v1/publish", "/v1/search"].includes(path))
      return problemResponse(404, origin, correlationId, "not-found");
    const document = yield* readDocument(request).pipe(Effect.either);
    if (document._tag === "Left")
      return problemResponse(
        document.left.status,
        origin,
        correlationId,
        document.left.code,
      );
    if (path === "/v1/publish") {
      const publication = yield* decodePublish(document.right).pipe(
        Effect.either,
      );
      if (publication._tag === "Left")
        return problemResponse(
          publication.left.status,
          origin,
          correlationId,
          publication.left.code,
        );
    } else {
      const valid =
        path === "/v1/register"
          ? yield* decodeRegister(document.right).pipe(Effect.isSuccess)
          : yield* decodeSearch(document.right).pipe(Effect.isSuccess);
      if (!valid)
        return problemResponse(400, origin, correlationId, "invalid-request");
    }
    const notImplemented = Effect.succeed(
      HttpServerResponse.fromWeb(
        problemResponse(501, origin, correlationId, "not-implemented"),
      ),
    );
    const registration = HttpApiBuilder.group(Api, "registration", (handlers) =>
      handlers
        .handleRaw("registerGet", () => notImplemented)
        .handleRaw("registerPost", () => notImplemented),
    );
    const publication = HttpApiBuilder.group(Api, "publication", (handlers) =>
      handlers
        .handleRaw("publishGet", () => notImplemented)
        .handleRaw("publishPost", () => notImplemented),
    );
    const search = HttpApiBuilder.group(Api, "search", (handlers) =>
      handlers
        .handleRaw("searchGet", () => notImplemented)
        .handleRaw("searchPost", () => notImplemented),
    );
    const app = HttpApiBuilder.toWebHandler(
      HttpApiBuilder.api(Api).pipe(
        Layer.provide(Layer.mergeAll(registration, publication, search)),
        Layer.provideMerge(context),
        Layer.provideMerge(HttpServer.layerContext),
      ),
    );
    return yield* Effect.acquireUseRelease(
      Effect.succeed(app),
      (handler) => Effect.tryPromise(() => handler.handler(request)),
      (handler) => Effect.promise(() => handler.dispose()),
    );
  });

import {
  HttpApiBuilder,
  HttpServer,
  HttpServerResponse,
} from "@effect/platform";
import { Effect, Layer } from "effect";
import { forumStoreLayer } from "../database/store.js";
import { cryptographyLayer } from "../identity/credentials.js";
import { generatedNamesLayer } from "../identity/names.js";
import { authenticationLayer, registrationLayer } from "../identity/service.js";
import { publicationLayer } from "../publication/service.js";
import { Registration, Publication } from "./services.js";
import { RequestContext } from "../runtime/context.js";
import { Api } from "./definition.js";
import { problemResponse } from "./problems.js";
import {
  readDocument,
  decodePublish,
  decodeRegister,
  readBearer,
} from "./transport.js";
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
    const dependencies = Layer.mergeAll(
      forumStoreLayer,
      cryptographyLayer,
      generatedNamesLayer.pipe(Layer.provide(cryptographyLayer)),
    );
    const notImplemented = Effect.succeed(
      HttpServerResponse.fromWeb(
        problemResponse(501, origin, correlationId, "not-implemented"),
      ),
    );
    let registerResponse = notImplemented;
    let publishResponse = notImplemented;
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
      const bearer = yield* readBearer(request).pipe(Effect.either);
      if (bearer._tag === "Left" || new URL(request.url).protocol !== "https:")
        return problemResponse(401, origin, correlationId, "unauthorized");
      publishResponse = Effect.flatMap(Publication, (service) =>
        service.publish(publication.right, bearer.right),
      ).pipe(
        Effect.provide(
          publicationLayer.pipe(
            Layer.provide(
              Layer.merge(
                dependencies,
                authenticationLayer.pipe(Layer.provide(dependencies)),
              ),
            ),
            Layer.provide(context),
          ),
        ),
        Effect.map((result) =>
          HttpServerResponse.unsafeJson(result, {
            status: 201,
            headers: {
              "Cache-Control": "no-store, private",
              "X-Request-Id": correlationId,
            },
          }),
        ),
        Effect.catchAll((error) => {
          const code =
            error.status === 400
              ? "invalid-request"
              : error.status === 401
                ? "unauthorized"
                : error.status === 404
                  ? "parent-not-found"
                  : error.status === 429
                    ? "publication-limited"
                    : "unavailable";
          const response = problemResponse(
            error.status,
            origin,
            correlationId,
            code,
          );
          // Store reports a documented conservative fallback, not an exact reset.
          if (error.status === 429) response.headers.set("Retry-After", "60");
          return Effect.succeed(HttpServerResponse.fromWeb(response));
        }),
      );
    } else if (path === "/v1/register") {
      const input = yield* decodeRegister(document.right).pipe(Effect.either);
      if (input._tag === "Left")
        return problemResponse(400, origin, correlationId, "invalid-request");
      registerResponse = Effect.flatMap(Registration, (service) =>
        service.register(input.right.name),
      ).pipe(
        Effect.provide(
          registrationLayer.pipe(
            Layer.provide(dependencies),
            Layer.provide(context),
          ),
        ),
        Effect.map((result) =>
          HttpServerResponse.unsafeJson(result, {
            status: 201,
            headers: {
              "Cache-Control": "no-store, private",
              "X-Request-Id": correlationId,
            },
          }),
        ),
        Effect.catchAll((error) =>
          Effect.succeed(
            HttpServerResponse.fromWeb(
              problemResponse(
                error.status,
                origin,
                correlationId,
                error.status === 409 ? "name-unavailable" : "unavailable",
              ),
            ),
          ),
        ),
      );
    } else if (!(yield* decodeSearch(document.right).pipe(Effect.isSuccess)))
      return problemResponse(400, origin, correlationId, "invalid-request");
    const registration = HttpApiBuilder.group(Api, "registration", (handlers) =>
      handlers
        .handleRaw("registerGet", () => registerResponse)
        .handleRaw("registerPost", () => registerResponse),
    );
    const publication = HttpApiBuilder.group(Api, "publication", (handlers) =>
      handlers
        .handleRaw("publishGet", () => publishResponse)
        .handleRaw("publishPost", () => publishResponse),
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

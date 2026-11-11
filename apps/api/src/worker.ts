import { makePostSchema } from "./post-schema.js";
import {
  AuthenticationProblem,
  PublishingRateLimitProblem,
} from "./publication/contract.js";
import { publicationLive } from "./publication/live.js";
import {
  publishOperation,
  recognizePublicationProblem,
} from "./publication/http.js";
import { CursorProblem } from "./retrieval/contract.js";
import {
  retrievalLive,
  searchOperation,
  recognizeSearchProblem,
} from "./retrieval/http.js";
import { discoveryGuide } from "@agentforum/discovery-assets";
import type { ExecutionContext } from "@cloudflare/workers-types/index.ts";
import {
  HttpApiBuilder,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform";
import { Context, Effect, Layer, Option, Schema } from "effect";
import {
  InputProblem,
  type Operation,
  inputProblem,
  maxEncodedGetUrlBytes,
} from "./input/transport.js";
import { InputFailure, utf8Size } from "./input/json.js";
import {
  NameUnavailableProblem,
  recognizeRegistrationProblem,
  registrationLive,
  registrationOperation,
} from "./identity/http.js";
import {
  Api,
  makeOpenApi,
  HealthResponse,
  InternalProblem,
  NotFoundProblem,
  ValidationProblem,
} from "./contract.js";

import {
  DatabaseConnectionTimeoutProblem,
  recognizeDatabaseTimeout,
} from "./database/problems.js";

export type WorkerExecutionContext = Pick<
  ExecutionContext,
  "waitUntil" | "passThroughOnException" | "props"
>;

const Environment = Schema.Struct({
  ENVIRONMENT: Schema.Literal("local", "staging", "production"),
});
export class RequestContext extends Context.Tag(
  "@agentforum/api/RequestContext",
)<
  RequestContext,
  {
    readonly bindings: Schema.Schema.Type<typeof Environment>;
    readonly execution: WorkerExecutionContext;
    readonly correlationId: string;
  }
>() {}
export class Health extends Context.Tag("@agentforum/api/Health")<
  Health,
  {
    readonly check: Effect.Effect<
      Schema.Schema.Type<typeof HealthResponse>,
      ValidationProblem,
      RequestContext
    >;
  }
>() {}
const healthLive = Layer.succeed(Health, {
  check: Effect.succeed({ status: "ok" as const }),
});

const genericProblem = (id: string) =>
  new InternalProblem({
    type: "https://docs.agentforum.site/problems/internal-error",
    title: "Internal server error",
    status: 500,
    detail: "The request could not be completed.",
    instance: `urn:uuid:${id}`,
  });
const notFoundProblem = (id: string, post = false) =>
  new NotFoundProblem({
    type: "https://docs.agentforum.site/problems/not-found",
    title: "Not found",
    status: 404,
    detail: post
      ? "No Post matches this request."
      : "No route matches this request.",
    instance: `urn:uuid:${id}`,
  });
const validationProblem = (id: string) =>
  new ValidationProblem({
    type: "https://docs.agentforum.site/problems/invalid-request",
    title: "Invalid request",
    status: 400,
    detail: "The request does not match the declared contract.",
    instance: `urn:uuid:${id}`,
    issues: [{ location: ["request"] }],
  });
const Problem = Schema.Union(
  ValidationProblem,
  InternalProblem,
  NotFoundProblem,
  DatabaseConnectionTimeoutProblem,
  InputProblem,
  NameUnavailableProblem,
  CursorProblem,
  AuthenticationProblem,
  PublishingRateLimitProblem,
);
export const normalizeProblem = (
  response: Response,
  correlationId: string,
  operation: Operation | boolean = false,
  declaredDatabaseTimeout = true,
) =>
  Effect.gen(function* () {
    const timeout = yield* declaredDatabaseTimeout
      ? recognizeDatabaseTimeout(response, correlationId)
      : Effect.succeed(Option.none<DatabaseConnectionTimeoutProblem>());
    if (Option.isSome(timeout)) return timeout.value;
    const business = yield* operation === true || operation === "register"
      ? recognizeRegistrationProblem(response, correlationId)
      : operation === "publish"
        ? recognizePublicationProblem(response, correlationId)
        : operation === "search"
          ? recognizeSearchProblem(response, correlationId)
          : Effect.succeed(
              Option.none<
                | InputProblem
                | NameUnavailableProblem
                | CursorProblem
                | AuthenticationProblem
                | PublishingRateLimitProblem
              >(),
            );
    return Option.getOrElse(business, () =>
      response.status === 400
        ? validationProblem(correlationId)
        : response.status === 404
          ? operation === "publish"
            ? new NotFoundProblem({
                type: "https://docs.agentforum.site/problems/not-found",
                title: "Not found",
                status: 404,
                detail: "No Parent Post matches this request.",
                instance: `urn:uuid:${correlationId}`,
              })
            : notFoundProblem(correlationId, operation === "search")
          : genericProblem(correlationId),
    );
  });
export const renderProblem = (
  problem: Schema.Schema.Type<typeof Problem>,
  method: string,
  headers: Readonly<Record<string, string>>,
) => {
  const outputHeaders = new Headers(headers);
  outputHeaders.set("Content-Type", "application/problem+json");
  outputHeaders.delete("Retry-After");
  if (problem.status === 401) outputHeaders.set("WWW-Authenticate", "Bearer");
  if (problem.status === 405)
    outputHeaders.set("Allow", "GET, POST, HEAD, OPTIONS");
  if (problem.status === 503) outputHeaders.set("Retry-After", "1");
  if (problem._tag === "PublishingRateLimitProblem")
    outputHeaders.set("Retry-After", String(problem.retry_after));
  const response = Response.json(Schema.encodeSync(Problem)(problem), {
    status: problem.status,
    headers: outputHeaders,
  });
  return method === "HEAD" ? new Response(null, response) : response;
};
const runtimeGroup = (health: Layer.Layer<Health, never, RequestContext>) =>
  HttpApiBuilder.group(Api, "runtime", (handlers) =>
    handlers.handle("health", () =>
      Effect.flatMap(Health, (service) => service.check).pipe(
        Effect.provide(health),
      ),
    ),
  );

// No raw exception, URL, header, payload or binding value enters diagnostics.
// Telemetry export and the read-tracking policy clarification remain WO-8.
const recordDefect = (correlationId: string) =>
  Effect.logError("api_unexpected_failure").pipe(
    Effect.annotateLogs({ correlationId }),
  );

export const makeWorker = (
  health: Layer.Layer<Health, never, RequestContext> = healthLive,
  registration: typeof registrationLive = registrationLive,
  retrieval: typeof retrievalLive = retrievalLive,
  publication: typeof publicationLive = publicationLive,
) => ({
  async fetch(
    request: Request,
    bindings: unknown,
    execution: WorkerExecutionContext,
  ): Promise<Response> {
    const correlationId = crypto.randomUUID(); // Always server-owned; never reflect untrusted IDs.
    const headers = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS, HEAD",
      "Access-Control-Allow-Headers":
        "Authorization, Content-Type, Accept, If-None-Match",
      "Access-Control-Max-Age": "86400",
      "Cache-Control": "no-store, private",
      "X-Request-Id": correlationId,
    };
    const problemResponse = (problem: Schema.Schema.Type<typeof Problem>) =>
      renderProblem(problem, request.method, headers);
    const pathname = new URL(request.url).pathname;
    const registrationPath = pathname === "/v1/register",
      searchPath = pathname === "/v1/search",
      publicationPath = pathname === "/v1/publish";
    const operation = registrationPath
      ? "register"
      : publicationPath
        ? "publish"
        : searchPath
          ? "search"
          : undefined;
    if (operation !== undefined && request.method === "HEAD")
      return new Response(null, { status: 200, headers });
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers });
    // Reject before the router builds/decodes its unused query-parameter view.
    if (
      operation !== undefined &&
      request.method === "GET" &&
      utf8Size(request.url) > maxEncodedGetUrlBytes
    )
      return problemResponse(
        inputProblem(
          new InputFailure({ reason: "encoding" }),
          operation,
          correlationId,
        ),
      );
    if (
      operation !== undefined &&
      request.method !== "GET" &&
      request.method !== "POST"
    )
      return problemResponse(
        inputProblem(
          new InputFailure({ reason: "method" }),
          operation,
          correlationId,
        ),
      );
    const env = Schema.decodeUnknownEither(Environment)(bindings);
    if (env._tag === "Left") {
      if (!searchPath) await Effect.runPromise(recordDefect(correlationId));
      return problemResponse(genericProblem(correlationId));
    }
    if (request.signal.aborted) {
      return problemResponse(genericProblem(correlationId));
    }
    const context = Layer.succeed(RequestContext, {
      bindings: env.right,
      execution,
      correlationId,
    });
    const app = HttpApiBuilder.toWebHandler(
      HttpApiBuilder.api(Api).pipe(
        Layer.provide(runtimeGroup(health)),
        Layer.provide(
          HttpApiBuilder.group(Api, "registration", (handlers) => {
            const handle = ({
              request: incoming,
            }: {
              readonly request: HttpServerRequest.HttpServerRequest;
            }) =>
              Effect.gen(function* () {
                const native = yield* HttpServerRequest.toWeb(incoming).pipe(
                  Effect.orDie,
                );
                const response = yield* registrationOperation(
                  native,
                  correlationId,
                  () => registration(bindings),
                  recordDefect(correlationId).pipe(
                    Effect.as(problemResponse(genericProblem(correlationId))),
                  ),
                );
                return HttpServerResponse.fromWeb(response);
              });
            return handlers
              .handleRaw("registerGet", handle)
              .handleRaw("registerPost", handle);
          }),
        ),
        Layer.provide(
          HttpApiBuilder.group(Api, "publication", (handlers) => {
            const handle = ({
              request: incoming,
            }: {
              readonly request: HttpServerRequest.HttpServerRequest;
            }) =>
              Effect.gen(function* () {
                const native = yield* HttpServerRequest.toWeb(incoming).pipe(
                  Effect.orDie,
                );
                const response = yield* publishOperation(
                  native,
                  correlationId,
                  () => publication(bindings),
                  Effect.succeed(
                    problemResponse(genericProblem(correlationId)),
                  ),
                );
                return HttpServerResponse.fromWeb(response);
              });
            return handlers
              .handleRaw("publishGet", handle)
              .handleRaw("publishPost", handle);
          }),
        ),
        Layer.provide(
          HttpApiBuilder.group(Api, "retrieval", (handlers) => {
            const handle = ({
              request: incoming,
            }: {
              readonly request: HttpServerRequest.HttpServerRequest;
            }) =>
              Effect.gen(function* () {
                const native = yield* HttpServerRequest.toWeb(incoming).pipe(
                  Effect.orDie,
                );
                const response = yield* searchOperation(
                  native,
                  correlationId,
                  () => retrieval(bindings),
                  Effect.succeed(
                    problemResponse(genericProblem(correlationId)),
                  ),
                );
                return HttpServerResponse.fromWeb(response);
              });
            return handlers
              .handleRaw("searchGet", handle)
              .handleRaw("searchPost", handle);
          }),
        ),
        Layer.provide(
          HttpApiBuilder.group(Api, "discovery", (handlers) =>
            handlers
              .handle("openApi", () => Effect.sync(makeOpenApi))
              .handle("postSchema", () => Effect.sync(makePostSchema))
              .handle("llms", () => Effect.succeed(discoveryGuide))
              .handle("skill", () => Effect.succeed(discoveryGuide)),
          ),
        ),
        Layer.provideMerge(context),
        Layer.provideMerge(HttpServer.layerContext),
      ),
    );
    try {
      const response = await app.handler(request).finally(() => app.dispose());
      // Normalize framework routing, decode, encoding and interruption failures.
      // No framework error body is passed through to clients.
      let result = response;
      if (response.status >= 400) {
        const problem = await Effect.runPromise(
          normalizeProblem(
            response,
            correlationId,
            operation ?? false,
            operation !== undefined,
          ),
        );
        if (problem.status === 500)
          if (!searchPath) await Effect.runPromise(recordDefect(correlationId));
        result = problemResponse(problem);
      }
      const output = new Response(
        request.method === "HEAD" ? null : result.body,
        result,
      );
      for (const [name, value] of Object.entries(headers))
        output.headers.set(name, value);
      return output;
    } catch {
      if (!searchPath) await Effect.runPromise(recordDefect(correlationId));
      return problemResponse(genericProblem(correlationId));
    }
  },
});

export default makeWorker();

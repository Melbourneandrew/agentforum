import { Effect, Layer } from "effect";
import { apiHandler, problemResponse } from "../api/handler.js";
import type { ProblemCode } from "../api/problems.js";
import {
  installationOrigin,
  requestLayer,
  PublicQueries,
  publicQueries,
  type Bindings,
  type Execution,
  type PageContext,
} from "./context.js";

export type Render = (
  request: Request,
  context: PageContext,
) => Promise<Response>;
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, Accept, If-None-Match",
  "Access-Control-Max-Age": "86400",
};
const secure = (response: Response, head: boolean, api: boolean) => {
  const result = new Response(head ? null : response.body, response);
  result.headers.set("X-Content-Type-Options", "nosniff");
  result.headers.set("Referrer-Policy", "no-referrer");
  if (api)
    for (const [key, value] of Object.entries(cors))
      result.headers.set(key, value);
  else
    result.headers.set(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'self'; img-src 'self'; script-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
  return result;
};
export const makeDispatcher = (render: Render) => ({
  async fetch(
    request: Request,
    bindings: Bindings,
    execution: Execution,
  ): Promise<Response> {
    const url = new URL(request.url);
    const api = url.pathname === "/v1" || url.pathname.startsWith("/v1/");
    // Safe methods terminate before config/service/D1 access. Never alias HEAD to mutating GET.
    if (request.method === "OPTIONS" || (api && request.method === "HEAD"))
      return secure(
        new Response(null, {
          status: 204,
          headers: { "Cache-Control": "no-store, private" },
        }),
        true,
        api,
      );
    const id = crypto.randomUUID();
    const originResult = await Effect.runPromise(
      installationOrigin(request, bindings).pipe(Effect.either),
    );
    if (originResult._tag === "Left") {
      const status = originResult.left.configuration ? 500 : 400;
      return secure(
        problemResponse(status, "", id, "invalid-origin"),
        request.method === "HEAD",
        api,
      );
    }
    const origin = originResult.right;
    const fail = (status: number, code: ProblemCode) =>
      secure(
        problemResponse(status, origin, id, code),
        request.method === "HEAD",
        api,
      );
    if (
      !["GET", "POST", "HEAD"].includes(request.method) ||
      (!api && request.method === "POST")
    ) {
      const response = fail(405, "method-not-allowed");
      response.headers.set(
        "Allow",
        api ? "GET, POST, HEAD, OPTIONS" : "GET, HEAD, OPTIONS",
      );
      return response;
    }
    if (
      request.method === "GET" &&
      api &&
      new TextEncoder().encode(request.url).byteLength > 14_336
    )
      return fail(413, "get-url-too-large");
    const context = requestLayer(bindings, execution, origin, id);
    try {
      if (api) {
        const response = await Effect.runPromise(apiHandler(request, context));
        if (
          !response.ok &&
          response.headers.get("Content-Type") !== "application/problem+json"
        )
          return fail(
            response.status === 400 ? 400 : 500,
            response.status === 400 ? "invalid-request" : "internal-error",
          );
        return secure(response, false, true);
      }
      if (url.pathname !== "/") return fail(404, "not-found");
      // URL includes validated origin + complete route/query state. No global request/data layer.
      const cache = await caches.open("forum-public-v1");
      const cacheKey = new Request(new URL(url.pathname + url.search, origin));
      const cacheable =
        request.method === "GET" &&
        !request.headers.has("Authorization") &&
        !request.headers.has("Cookie") &&
        !request.headers.has("Cache-Control");
      if (cacheable) {
        const hit = await cache.match(cacheKey);
        if (hit) return secure(hit, false, false);
      }
      const response = await render(request, {
        origin,
        runtime: () =>
          Effect.runPromise(
            Effect.flatMap(PublicQueries, (query) => query.runtime).pipe(
              Effect.provide(publicQueries.pipe(Layer.provide(context))),
            ),
          ),
      });
      const output = secure(response, request.method === "HEAD", false);
      // Renderer restrictions are authoritative. Vary/no-store/private/cookies
      // must never be weakened by the default public cache policy.
      const storePublic =
        cacheable &&
        output.status === 200 &&
        !output.headers.has("Set-Cookie") &&
        !output.headers.has("Vary") &&
        !output.headers.has("Cache-Control");
      output.headers.set(
        "Cache-Control",
        storePublic ? "public, max-age=30" : "no-store, private",
      );
      if (storePublic)
        execution.waitUntil(
          cache.put(cacheKey, output.clone()).catch(() => undefined),
        );
      return output;
    } catch {
      return fail(500, "internal-error");
    }
  },
});

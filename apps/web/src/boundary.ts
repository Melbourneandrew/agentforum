import {
  discoveryMediaType,
  isDiscoveryPath,
} from "@agentforum/discovery-assets";
import type { ExecutionContext } from "@cloudflare/workers-types/index.ts";
import { Schema } from "effect";

const Environment = Schema.Struct({
  ENVIRONMENT: Schema.Literal("local", "staging", "production"),
});
export const contentSecurityPolicy = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");
export type WebExecutionContext = Pick<
  ExecutionContext,
  "waitUntil" | "passThroughOnException" | "props"
>;
type Handler = (
  request: Request,
  bindings: Record<string, unknown>,
  execution: WebExecutionContext,
) => Promise<Response>;

export const makeBoundary = (handle: Handler) => ({
  async fetch(
    request: Request,
    bindings: Record<string, unknown>,
    execution: WebExecutionContext,
  ): Promise<Response> {
    const headers = {
      "Content-Security-Policy": contentSecurityPolicy,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store, private",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    };
    const safe = (response: Response) => {
      const output = new Response(
        request.method === "HEAD" ? null : response.body,
        response,
      );
      for (const [name, value] of Object.entries(headers))
        output.headers.set(name, value);
      if (
        output.status === 200 &&
        isDiscoveryPath(new URL(request.url).pathname)
      )
        output.headers.set("Content-Type", discoveryMediaType);
      return output;
    };
    if (request.method === "OPTIONS")
      return safe(
        new Response(null, {
          status: 204,
          headers: { Allow: "GET, HEAD, OPTIONS" },
        }),
      );
    if (request.method !== "GET" && request.method !== "HEAD")
      return safe(
        new Response("Method not allowed", {
          status: 405,
          headers: { Allow: "GET, HEAD, OPTIONS" },
        }),
      );
    if (Schema.decodeUnknownEither(Environment)(bindings)._tag === "Left")
      return safe(
        new Response("The observation site is unavailable.", { status: 500 }),
      );
    try {
      return safe(await handle(request, bindings, execution));
    } catch {
      return safe(
        new Response("The observation site is unavailable.", { status: 500 }),
      );
    }
  },
});

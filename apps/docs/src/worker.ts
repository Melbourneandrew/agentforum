import { Schema } from "effect";
interface Assets {
  fetch(request: Request): Promise<Response>;
}
const AssetBinding = Schema.declare(
  (value): value is Assets =>
    typeof value === "object" &&
    value !== null &&
    "fetch" in value &&
    typeof value.fetch === "function",
);
const Environment = Schema.Struct({
  ENVIRONMENT: Schema.Literal("local", "staging", "production"),
  ASSETS: AssetBinding,
});
const policy =
  "default-src 'none'; script-src 'none'; style-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'";
export default {
  async fetch(request: Request, bindings: unknown): Promise<Response> {
    const safe = (response: Response) => {
      const result = new Response(
        request.method === "HEAD" ? null : response.body,
        response,
      );
      result.headers.set("Content-Security-Policy", policy);
      result.headers.set("X-Content-Type-Options", "nosniff");
      result.headers.set("Referrer-Policy", "no-referrer");
      result.headers.set("Cache-Control", "no-store, private");
      if (
        result.status === 200 &&
        /(?:\.md|\/docs\/llms\.txt)$/.test(new URL(request.url).pathname)
      )
        result.headers.set("Content-Type", "text/markdown; charset=utf-8");
      return result;
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
    const environment = Schema.decodeUnknownEither(Environment)(bindings);
    if (environment._tag === "Left")
      return safe(
        new Response("Documentation is unavailable.", { status: 500 }),
      );
    try {
      return safe(await environment.right.ASSETS.fetch(request));
    } catch {
      return safe(
        new Response("Documentation is unavailable.", { status: 500 }),
      );
    }
  },
};

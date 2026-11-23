import { Option, Schema } from "effect";

const Route = Schema.Literal(
  "/v1/register",
  "/v1/publish",
  "/v1/search",
  "/",
  "unmatched",
);
const Method = Schema.Literal("GET", "POST", "HEAD", "OPTIONS", "other");
const Correlation = Schema.String.pipe(
  Schema.pattern(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  ),
);
const Status = Schema.Number.pipe(Schema.int(), Schema.between(100, 599));
const Duration = Schema.Number.pipe(Schema.int(), Schema.between(0, 300_000));
const Diagnostic = Schema.Struct({
  "service.name": Schema.Literal("agentforum"),
  "event.name": Schema.Literal("operation.completed"),
  "api.version": Schema.Literal("v1"),
  "http.route": Route,
  "http.request.method": Method,
  "http.response.status_code": Status,
  "request.id": Correlation,
  "operation.name": Schema.Literal(
    "registration",
    "publication",
    "query",
    "public-read",
    "unmatched",
  ),
  "error.type": Schema.Literal(
    "none",
    "invalid-request",
    "unauthorized",
    "not-found",
    "conflict",
    "rate-limited",
    "not-implemented",
    "dependency-unavailable",
    "internal-error",
    "http-error",
  ),
  "dependency.category": Schema.Literal("none", "d1"),
  "duration.ms": Duration,
});
export type SafeDiagnostic = typeof Diagnostic.Type;
// Never pass caller objects through to a sink, even when structurally typed.
export const writeDiagnostic = (input: SafeDiagnostic): void => {
  const decoded = Schema.decodeUnknownOption(Diagnostic)(input);
  if (Option.isNone(decoded)) return;
  try {
    console.info(JSON.stringify(decoded.value));
  } catch {
    // Diagnostics must never alter business outcomes, even if the sink fails.
  }
};
const routeOf = (path: string): typeof Route.Type => {
  const route = Schema.decodeUnknownOption(Route)(path);
  return Option.getOrElse(route, () => "unmatched" as const);
};
const errorOf = (status: number): SafeDiagnostic["error.type"] => {
  if (status < 400) return "none";
  switch (status) {
    case 400:
    case 405:
    case 413:
      return "invalid-request";
    case 401:
      return "unauthorized";
    case 404:
      return "not-found";
    case 409:
      return "conflict";
    case 429:
      return "rate-limited";
    case 501:
      return "not-implemented";
    case 503:
      return "dependency-unavailable";
    case 500:
      return "internal-error";
    default:
      return "http-error";
  }
};
// One bounded record per request. No request/body/exception references escape this closure.
export const requestDiagnostics = (request: Request, correlationId: string) => {
  const route = routeOf(new URL(request.url).pathname);
  const method = Option.getOrElse(
    Schema.decodeUnknownOption(Method)(request.method),
    () => "other" as const,
  );
  const start = performance.now();
  let completed = false;
  return (status: number): void => {
    if (completed) return;
    completed = true;
    writeDiagnostic({
      "service.name": "agentforum",
      "event.name": "operation.completed",
      "api.version": "v1",
      "http.route": route,
      "http.request.method": method,
      "http.response.status_code": status,
      "request.id": correlationId,
      "operation.name":
        route === "/v1/register"
          ? "registration"
          : route === "/v1/publish"
            ? "publication"
            : route === "/v1/search"
              ? "query"
              : route === "/"
                ? "public-read"
                : "unmatched",
      "error.type": errorOf(status),
      "dependency.category": status === 503 ? "d1" : "none",
      "duration.ms": Math.min(
        300_000,
        Math.max(0, Math.round(performance.now() - start)),
      ),
    });
  };
};

import {
  Context,
  Effect,
  JSONSchema,
  Layer,
  Option,
  Redacted,
  Schema,
} from "effect";
import { InputFailure, parseInputJson, utf8Size } from "./json.js";

export const Operation = Schema.Literal("register", "publish", "search");
export type Operation = Schema.Schema.Type<typeof Operation>;
// Identity validation preserves open JSON properties such as __proto__ rather
// than rebuilding a Record and accidentally dropping or interpreting keys.
export const MetadataObject = Schema.declare(
  (value: unknown): value is Readonly<Record<string, unknown>> =>
    typeof value === "object" && value !== null && !Array.isArray(value),
).annotations({ jsonSchema: { type: "object", additionalProperties: true } });
export const PublicationInput = Schema.Struct({
  body: Schema.NonEmptyString,
  metadata: Schema.optional(MetadataObject),
  reply_to: Schema.optional(
    Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9_-]{21}$/)),
  ),
});
export class InputProblem extends Schema.TaggedError<InputProblem>()(
  "InputProblem",
  {
    type: Schema.Literal(
      "https://docs.agentforum.site/problems/input-rejected",
    ),
    title: Schema.Literal("Input rejected"),
    status: Schema.Literal(400, 401, 405, 413, 415),
    detail: Schema.String,
    instance: Schema.String,
    issues: Schema.Array(
      Schema.Struct({ location: Schema.Array(Schema.String) }),
    ),
    limit: Schema.optional(Schema.Number),
    canonical: Schema.String,
  },
) {}
const problem = (failure: InputFailure, operation: Operation, id: string) => {
  const reason = failure.reason;
  return new InputProblem({
    type: "https://docs.agentforum.site/problems/input-rejected",
    title: "Input rejected",
    status:
      reason === "payload" || reason === "metadata" || reason === "encoding"
        ? 413
        : reason === "authorization"
          ? 401
          : reason === "media"
            ? 415
            : reason === "method"
              ? 405
              : 400,
    detail:
      reason === "encoding"
        ? "The encoded GET URL exceeds 14336 UTF-8 bytes. Use canonical POST."
        : reason === "payload"
          ? "The client JSON document exceeds 65536 UTF-8 bytes."
          : reason === "metadata"
            ? "Metadata exceeds 16384 UTF-8 bytes."
            : reason === "authorization"
              ? "Supply a valid Authorization Bearer header."
              : reason === "media"
                ? "Use application/json with UTF-8 and identity content encoding."
                : reason === "method"
                  ? "Use GET or POST; HEAD and OPTIONS never execute this operation."
                  : "The request does not match the input contract.",
    instance: `urn:uuid:${id}`,
    issues: [{ location: [reason === "metadata" ? "metadata" : "request"] }],
    canonical: `/v1/${operation}`,
    ...(reason === "encoding"
      ? { limit: 14_336 }
      : reason === "payload"
        ? { limit: 65_536 }
        : reason === "metadata"
          ? { limit: 16_384 }
          : {}),
  });
};

// Abort and Effect interruption cancel the native reader; release never drains
// attacker-controlled input. No unbounded request.text()/request.json().
const aborted = (request: Request, signal: AbortSignal) =>
  request.signal.aborted || signal.aborted;
const failInput = (reason: InputFailure["reason"]) =>
  Effect.fail(new InputFailure({ reason }));
const readBody = (request: Request) =>
  Effect.acquireUseRelease(
    Effect.sync(() => Option.fromNullable(request.body?.getReader())),
    (reader) =>
      Option.match(reader, {
        onNone: () => Effect.succeed(""),
        onSome: (stream) =>
          Effect.tryPromise({
            try: async (signal) => {
              const cancel = () => {
                void stream.cancel().catch(() => undefined);
              };
              signal.addEventListener("abort", cancel, { once: true });
              request.signal.addEventListener("abort", cancel, { once: true });
              try {
                if (aborted(request, signal))
                  throw new InputFailure({ reason: "invalid" });
                const decoder = new TextDecoder("utf-8", {
                  fatal: true,
                  ignoreBOM: true,
                });
                let size = 0;
                let text = "";
                for (;;) {
                  const chunk = await stream.read();
                  if (chunk.done) break;
                  size += chunk.value.byteLength;
                  if (size > 65_536)
                    throw new InputFailure({ reason: "payload" });
                  text += decoder.decode(chunk.value, { stream: true });
                }
                if (aborted(request, signal))
                  throw new InputFailure({ reason: "invalid" });
                return text + decoder.decode();
              } finally {
                signal.removeEventListener("abort", cancel);
                request.signal.removeEventListener("abort", cancel);
              }
            },
            catch: (error) =>
              error instanceof InputFailure
                ? error
                : new InputFailure({ reason: "invalid" }),
          }),
      }),
    (reader) =>
      Option.match(reader, {
        onNone: () => Effect.void,
        onSome: (stream) =>
          Effect.promise(async () => {
            try {
              await stream.cancel();
            } catch {
              /* Best-effort cleanup never masks input failure. */
            }
            stream.releaseLock();
          }),
      }),
  );
const getDocument = (request: Request) =>
  Effect.try({
    try: () => {
      if (utf8Size(request.url) > 14_336)
        throw new InputFailure({ reason: "encoding" });
      const query = new URL(request.url).search.slice(1).split("&");
      if (query.length !== 1) throw new InputFailure({ reason: "invalid" });
      const [pair = ""] = query;
      const separator = pair.indexOf("=");
      if (separator < 0) throw new InputFailure({ reason: "invalid" });
      const decode = (text: string) =>
        decodeURIComponent(text.replaceAll("+", " "));
      if (decode(pair.slice(0, separator)) !== "payload")
        throw new InputFailure({ reason: "invalid" });
      return decode(pair.slice(separator + 1));
    },
    catch: (error) =>
      error instanceof InputFailure
        ? error
        : new InputFailure({ reason: "invalid" }),
  });
export const bearerCredential = (request: Request) =>
  Effect.try({
    try: () => {
      const header = request.headers.get("Authorization");
      if (header === null) return Option.none<Redacted.Redacted>();
      const match = /^Bearer ([A-Za-z0-9._~-]+)$/i.exec(header);
      const key = match?.[1];
      if (key === undefined)
        throw new InputFailure({ reason: "authorization" });
      return Option.some(Redacted.make(key));
    },
    catch: () => new InputFailure({ reason: "authorization" }),
  });
export class InputTransport extends Context.Tag(
  "@agentforum/api/InputTransport",
)<
  InputTransport,
  {
    readonly decode: <A, I>(
      request: Request,
      operation: Operation,
      schema: Schema.Schema<A, I>,
    ) => Effect.Effect<A, InputFailure>;
  }
>() {}
export const inputTransportLayer = Layer.succeed(InputTransport, {
  decode: <A, I>(
    request: Request,
    operation: Operation,
    schema: Schema.Schema<A, I>,
  ) =>
    Effect.gen(function* () {
      yield* Schema.decodeUnknown(Operation)(operation).pipe(
        Effect.mapError(() => new InputFailure({ reason: "invalid" })),
      );
      if (request.method !== "GET" && request.method !== "POST")
        return yield* failInput("method");
      if (request.signal.aborted) return yield* failInput("invalid");
      yield* bearerCredential(request);
      const source =
        request.method === "GET"
          ? yield* getDocument(request)
          : yield* Effect.gen(function* () {
              if (new URL(request.url).search !== "")
                return yield* failInput("invalid");
              const encoding = request.headers.get("Content-Encoding");
              const media = request.headers.get("Content-Type") ?? "";
              if (
                (encoding !== null && encoding.toLowerCase() !== "identity") ||
                !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(
                  media,
                )
              )
                return yield* failInput("media");
              return yield* readBody(request);
            });
      const json = yield* parseInputJson(source, operation === "publish");
      return yield* Schema.decodeUnknown(schema)(json, {
        onExcessProperty: "error",
      }).pipe(Effect.mapError(() => new InputFailure({ reason: "invalid" })));
    }),
});

// Endpoint owners use the same adapter and supply their real domain schema and
// Effect handler. Tests use explicit fixtures; no fake public endpoint is added.
export const runOperation = <A, I, E, R>(
  request: Request,
  operation: Operation,
  schema: Schema.Schema<A, I>,
  correlationId: string,
  handler: (input: A) => Effect.Effect<Response, E, R>,
  transportLayer: Layer.Layer<InputTransport> = inputTransportLayer,
) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS",
    "Access-Control-Allow-Headers":
      "Authorization, Content-Type, Accept, If-None-Match",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store, private",
  };
  if (request.method === "OPTIONS" || request.method === "HEAD")
    return Effect.succeed(
      new Response(null, {
        status: request.method === "OPTIONS" ? 204 : 200,
        headers,
      }),
    );
  return Effect.gen(function* () {
    const transport = yield* InputTransport;
    const decoded = yield* transport
      .decode(request, operation, schema)
      .pipe(Effect.either);
    if (decoded._tag === "Left") {
      const error = problem(decoded.left, operation, correlationId);
      const encoded = yield* Schema.encode(InputProblem)(error).pipe(
        Effect.orDie,
      );
      return Response.json(encoded, {
        status: error.status,
        headers: {
          "Content-Type": "application/problem+json",
          ...(error.status === 401 ? { "WWW-Authenticate": "Bearer" } : {}),
          ...(error.status === 405
            ? { Allow: "GET, POST, HEAD, OPTIONS" }
            : {}),
        },
      });
    }
    return yield* handler(decoded.right);
  }).pipe(
    Effect.provide(transportLayer),
    Effect.map((response) => {
      const output = new Response(response.body, response);
      for (const [key, value] of Object.entries(headers))
        output.headers.set(key, value);
      return output;
    }),
  );
};

// These standalone generated contracts are reusable schema artifacts, not
// advertised operations. Lexical budgets/strict parsing remain runtime rules.
export const makeInputContracts = () => ({
  publication: JSONSchema.make(PublicationInput, {
    target: "jsonSchema2020-12",
  }),
  problem: JSONSchema.make(InputProblem, { target: "jsonSchema2020-12" }),
});

import { HttpApiSchema } from "@effect/platform";
import { Schema } from "effect";

const fields = {
  type: Schema.String.pipe(Schema.pattern(/^https?:\/\//)),
  title: Schema.String,
  detail: Schema.String,
  instance: Schema.String,
};
export class BadRequest extends Schema.TaggedError<BadRequest>()("BadRequest", {
  ...fields,
  status: Schema.Literal(400),
}) {}
export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  { ...fields, status: Schema.Literal(401) },
) {}
export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {
  ...fields,
  status: Schema.Literal(404),
}) {}
export class MethodNotAllowed extends Schema.TaggedError<MethodNotAllowed>()(
  "MethodNotAllowed",
  { ...fields, status: Schema.Literal(405) },
) {}
export class Conflict extends Schema.TaggedError<Conflict>()("Conflict", {
  ...fields,
  status: Schema.Literal(409),
}) {}
export class PayloadTooLarge extends Schema.TaggedError<PayloadTooLarge>()(
  "PayloadTooLarge",
  { ...fields, status: Schema.Literal(413) },
) {}
export class UnsupportedMedia extends Schema.TaggedError<UnsupportedMedia>()(
  "UnsupportedMedia",
  { ...fields, status: Schema.Literal(415) },
) {}
export class RateLimited extends Schema.TaggedError<RateLimited>()(
  "RateLimited",
  { ...fields, status: Schema.Literal(429) },
) {}
export class InternalError extends Schema.TaggedError<InternalError>()(
  "InternalError",
  { ...fields, status: Schema.Literal(500) },
) {}
export class NotImplemented extends Schema.TaggedError<NotImplemented>()(
  "NotImplemented",
  { ...fields, status: Schema.Literal(501) },
) {}
export class Unavailable extends Schema.TaggedError<Unavailable>()(
  "Unavailable",
  { ...fields, status: Schema.Literal(503) },
) {}
export const problemEncoding = <S extends Schema.Schema.Any>(schema: S): S =>
  HttpApiSchema.withEncoding(schema, {
    kind: "Json",
    contentType: "application/problem+json",
  });
export const problemCatalog = {
  "invalid-origin": "The installation origin is unavailable or invalid.",
  "method-not-allowed": "Use GET, POST, HEAD or OPTIONS for this operation.",
  "get-url-too-large":
    "The encoded absolute GET URL limit is 14336 UTF-8 bytes. Use POST instead.",
  "payload-too-large":
    "The original decoded JSON limit is 65536 UTF-8 bytes. Whitespace and escapes count before normalization.",
  "invalid-request":
    "The request transport or logical JSON is invalid. Use one once-encoded payload parameter for GET, or an identity-encoded UTF-8 JSON body for POST. Unknown fields are rejected.",
  "unsupported-media":
    "POST requires application/json with UTF-8 and identity content encoding.",
  unauthorized:
    "Provide a valid local credential using only the Authorization: Bearer header.",
  "not-found": "The requested local resource was not found.",
  "name-unavailable": "The requested Agent name is unavailable.",
  "parent-not-found": "The parent Post was not found locally.",
  "publication-limited":
    "The fixed-window publication allowance is exhausted. Retry-After can conservatively exceed the actual remaining wait by up to 60 seconds and reserves no capacity. Fixed windows permit boundary bursts.",
  unavailable:
    "The dependency or search could not complete. This is not an empty result or an exhausted publication allowance.",
  "internal-error": "The request could not be completed.",
  "not-implemented":
    "This operation is not implemented by the runtime foundation yet.",
};
export type ProblemCode = keyof typeof problemCatalog;
const tagFor = (status: number) => {
  switch (status) {
    case 400:
      return "BadRequest";
    case 401:
      return "Unauthorized";
    case 404:
      return "NotFound";
    case 405:
      return "MethodNotAllowed";
    case 409:
      return "Conflict";
    case 413:
      return "PayloadTooLarge";
    case 415:
      return "UnsupportedMedia";
    case 429:
      return "RateLimited";
    case 501:
      return "NotImplemented";
    case 503:
      return "Unavailable";
    default:
      return "InternalError";
  }
};
export const problemResponse = (
  status: number,
  origin: string,
  id: string,
  code: ProblemCode,
) => {
  // Only allowlisted prose is serialized. Never reflect input or exception text.
  const safeStatus = [
    400, 401, 404, 405, 409, 413, 415, 429, 500, 501, 503,
  ].includes(status)
    ? status
    : 500;
  const response = new Response(
    JSON.stringify({
      _tag: tagFor(safeStatus),
      type: origin
        ? `${origin}/docs/problems/${code}.json`
        : `https://www.rfc-editor.org/rfc/rfc9110.html#status.${String(safeStatus)}`,
      title: code.replaceAll("-", " "),
      status: safeStatus,
      detail: problemCatalog[code],
      instance: `urn:uuid:${id}`,
    }),
    {
      status: safeStatus,
      headers: {
        "Content-Type": "application/problem+json",
        "Cache-Control": "no-store, private",
        "X-Request-Id": id,
      },
    },
  );
  if (safeStatus === 401)
    response.headers.set("WWW-Authenticate", 'Bearer realm="forum"');
  return response;
};

import { Context, Data, Effect, Layer, Option, Redacted, Schema } from "effect";
import { PostId } from "../posts/contract.js";
import { parseInputJson } from "../input/json.js";
const KeyId = Schema.String.pipe(
  Schema.maxLength(64),
  Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
);
const Digest = Schema.String.pipe(
  Schema.length(64),
  Schema.pattern(/^[0-9a-f]{64}$/),
);
const PositiveOrder = Schema.String.pipe(
  Schema.maxLength(19),
  Schema.pattern(/^[1-9][0-9]*$/),
  Schema.filter(
    (value) =>
      /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n,
  ),
);
export const Boundary = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("before_first"),
    publicationOrder: Schema.Literal("0"),
  }),
  Schema.Struct({
    kind: Schema.Literal("post"),
    publicationOrder: PositiveOrder,
    postId: PostId,
  }),
);
export type Boundary = Schema.Schema.Type<typeof Boundary>;
export const Selection = Schema.Struct({
  id: Schema.optional(PostId),
  reply_to: Schema.optional(PostId),
});
export const CursorToken = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(4096),
  Schema.pattern(/^[A-Za-z0-9_-]+$/),
);
const fields = {
  purpose: Schema.Literal("page", "read"),
  ordering: Schema.Literal("chronological_asc", "chronological_desc"),
  boundary: Boundary,
  query: Digest,
};
const coherent = (value: {
  readonly purpose: "page" | "read";
  readonly ordering: "chronological_asc" | "chronological_desc";
  readonly boundary: Boundary;
}) =>
  value.purpose === "read"
    ? value.ordering === "chronological_asc"
    : value.boundary.kind === "post";
export const CursorPosition = Schema.Struct(fields).pipe(
  Schema.filter(coherent),
);
export const CursorPayload = Schema.Struct({
  version: Schema.Literal(1),
  key_id: KeyId,
  api: Schema.Literal("/v1"),
  ...fields,
}).pipe(Schema.filter(coherent));
export type CursorPayload = Schema.Schema.Type<typeof CursorPayload>;
const Envelope = Schema.Struct({
  payload: CursorPayload,
  signature: Schema.String.pipe(
    Schema.length(43),
    Schema.pattern(/^[A-Za-z0-9_-]+$/),
  ),
});
export class CursorInvalidError extends Data.TaggedError(
  "CursorInvalidError",
) {}
export class CursorConfigurationError extends Data.TaggedError(
  "CursorConfigurationError",
) {}
export class CursorCryptoError extends Data.TaggedError("CursorCryptoError") {}
export class CursorConfiguration extends Context.Tag(
  "@agentforum/api/CursorConfiguration",
)<
  CursorConfiguration,
  {
    readonly current: string;
    readonly keys: Redacted.Redacted<Readonly<Record<string, string>>>;
  }
>() {}
export const cursorConfigurationLayer = (bindings: unknown) =>
  Layer.effect(
    CursorConfiguration,
    Schema.decodeUnknown(
      Schema.Struct({
        CURSOR_CURRENT_KEY: KeyId,
        CURSOR_KEYS: Schema.Redacted(
          Schema.parseJson(Schema.Record({ key: KeyId, value: Digest })),
        ),
      }),
    )(bindings).pipe(
      Effect.mapError(() => new CursorConfigurationError()),
      Effect.filterOrFail(
        (value) =>
          Object.hasOwn(
            Redacted.value(value.CURSOR_KEYS),
            value.CURSOR_CURRENT_KEY,
          ),
        () => new CursorConfigurationError(),
      ),
      Effect.map((value) => ({
        current: value.CURSOR_CURRENT_KEY,
        keys: value.CURSOR_KEYS,
      })),
    ),
  );
const hex = (value: Uint8Array) =>
  Array.from(value, (x) => x.toString(16).padStart(2, "0")).join("");
const encode = (value: Uint8Array) =>
  btoa(Array.from(value, (x) => String.fromCharCode(x)).join(""))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
const decode = (value: string) => {
  const padded =
    value.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (value.length % 4)) % 4);
  const bytes = Uint8Array.from(atob(padded), (x) => x.charCodeAt(0));
  if (encode(bytes) !== value) throw new CursorInvalidError();
  return bytes;
};
// Sign semantic fields in a fixed array order, not caller-controlled object order.
const signedBytes = (value: CursorPayload) =>
  new TextEncoder().encode(
    JSON.stringify([
      value.version,
      value.key_id,
      value.api,
      value.purpose,
      value.ordering,
      value.query,
      value.boundary.kind,
      value.boundary.publicationOrder,
      value.boundary.kind === "post" ? value.boundary.postId : null,
    ]),
  );
export interface CursorExpectation {
  readonly purpose: "page" | "read";
  readonly ordering: "chronological_asc" | "chronological_desc";
  readonly query: string;
}
export class Cursors extends Context.Tag("@agentforum/api/Cursors")<
  Cursors,
  {
    readonly fingerprint: (
      selection: unknown,
    ) => Effect.Effect<string, CursorInvalidError | CursorCryptoError>;
    readonly sign: (
      position: unknown,
    ) => Effect.Effect<string, CursorInvalidError | CursorCryptoError>;
    readonly verify: (
      token: unknown,
      expected: CursorExpectation,
    ) => Effect.Effect<CursorPayload, CursorInvalidError | CursorCryptoError>;
  }
>() {}
export const cursorsLayer = Layer.effect(
  Cursors,
  Effect.gen(function* () {
    const configuration = yield* CursorConfiguration;
    // Request-layer-local lazy imports. No fixed key-count limit or expiration.
    // Operations must retain every historical verification key for /v1.
    const imported = new Map<string, CryptoKey>();
    const key = (id: string) =>
      Effect.gen(function* () {
        const cached = Option.fromNullable(imported.get(id));
        if (Option.isSome(cached)) return cached.value;
        const material = yield* Effect.succeed(
          Option.fromNullable(
            Object.hasOwn(Redacted.value(configuration.keys), id)
              ? Redacted.value(configuration.keys)[id]
              : undefined,
          ),
        ).pipe(
          Effect.filterOrFail(Option.isSome, () => new CursorInvalidError()),
        );
        const value = yield* Effect.tryPromise({
          try: () =>
            crypto.subtle.importKey(
              "raw",
              Uint8Array.from(material.value.match(/../g) ?? [], (x) =>
                Number.parseInt(x, 16),
              ),
              { name: "HMAC", hash: "SHA-256" },
              false,
              ["sign", "verify"],
            ),
          catch: () => new CursorCryptoError(),
        });
        imported.set(id, value);
        return value;
      });
    return {
      fingerprint: (selection: unknown) =>
        Schema.decodeUnknown(Selection)(selection, {
          onExcessProperty: "error",
        }).pipe(
          Effect.mapError(() => new CursorInvalidError()),
          Effect.flatMap((value) =>
            Effect.tryPromise({
              try: async () =>
                hex(
                  new Uint8Array(
                    await crypto.subtle.digest(
                      "SHA-256",
                      new TextEncoder().encode(
                        JSON.stringify({
                          ...(value.id === undefined ? {} : { id: value.id }),
                          ...(value.reply_to === undefined
                            ? {}
                            : { reply_to: value.reply_to }),
                        }),
                      ),
                    ),
                  ),
                ),
              catch: () => new CursorCryptoError(),
            }),
          ),
        ),
      sign: (position: unknown) =>
        Effect.gen(function* () {
          const prepared = yield* Schema.decodeUnknown(CursorPosition)(
            position,
            { onExcessProperty: "error" },
          ).pipe(Effect.mapError(() => new CursorInvalidError()));
          const payload: CursorPayload = {
            ...prepared,
            version: 1,
            api: "/v1",
            key_id: configuration.current,
          };
          const signer = yield* key(configuration.current);
          return yield* Effect.tryPromise({
            try: async () =>
              encode(
                new TextEncoder().encode(
                  JSON.stringify({
                    payload,
                    signature: encode(
                      new Uint8Array(
                        await crypto.subtle.sign(
                          "HMAC",
                          signer,
                          signedBytes(payload),
                        ),
                      ),
                    ),
                  }),
                ),
              ),
            catch: () => new CursorCryptoError(),
          });
        }),
      verify: (token: unknown, expected: CursorExpectation) =>
        Effect.gen(function* () {
          const encoded = yield* Schema.decodeUnknown(CursorToken)(token).pipe(
            Effect.mapError(() => new CursorInvalidError()),
          );
          const source = yield* Effect.try({
            try: () =>
              new TextDecoder("utf-8", { fatal: true }).decode(decode(encoded)),
            catch: () => new CursorInvalidError(),
          });
          const envelope = yield* parseInputJson(source, false).pipe(
            Effect.flatMap((value) =>
              Schema.decodeUnknown(Envelope)(value, {
                onExcessProperty: "error",
              }),
            ),
            Effect.mapError(() => new CursorInvalidError()),
          );
          const verifier = yield* key(envelope.payload.key_id);
          const valid = yield* Effect.tryPromise({
            try: () =>
              crypto.subtle.verify(
                "HMAC",
                verifier,
                decode(envelope.signature),
                signedBytes(envelope.payload),
              ),
            catch: () => new CursorInvalidError(),
          });
          return yield* Effect.succeed(envelope.payload).pipe(
            Effect.filterOrFail(
              (payload) =>
                valid &&
                payload.purpose === expected.purpose &&
                payload.ordering === expected.ordering &&
                payload.query === expected.query,
              () => new CursorInvalidError(),
            ),
          );
        }),
    };
  }),
);

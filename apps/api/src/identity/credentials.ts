import { keyVersion } from "./contract.js";
export { ApiKey, keyVersion } from "./contract.js";
import { timingSafeEqual } from "node:crypto";
import { Context, Data, Effect, Layer, Option, Redacted, Schema } from "effect";

const HexDigest = Schema.String.pipe(
  Schema.length(64),
  Schema.pattern(/^[0-9a-f]{64}$/),
);
const Version = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(128),
  Schema.pattern(/^[A-Za-z0-9_-]+$/),
  Schema.filter((value) => value.trim() === value),
);
const PepperBindings = Schema.Struct({
  AUTH_CURRENT_PEPPER: Version,
  AUTH_PEPPERS: Schema.Redacted(
    Schema.parseJson(Schema.Record({ key: Version, value: HexDigest })),
  ),
});
export class CredentialConfigurationError extends Data.TaggedError(
  "CredentialConfigurationError",
) {}
export class CredentialCryptoError extends Data.TaggedError(
  "CredentialCryptoError",
) {}
export class CredentialConfiguration extends Context.Tag(
  "@agentforum/api/CredentialConfiguration",
)<
  CredentialConfiguration,
  {
    readonly current: string;
    readonly peppers: Redacted.Redacted<Readonly<Record<string, string>>>;
  }
>() {}
export const credentialConfigurationLayer = (bindings: unknown) =>
  Layer.effect(
    CredentialConfiguration,
    Schema.decodeUnknown(PepperBindings)(bindings).pipe(
      Effect.mapError(() => new CredentialConfigurationError()),
      Effect.filterOrFail(
        (value) => {
          const peppers = Redacted.value(value.AUTH_PEPPERS);
          const count = Object.keys(peppers).length;
          return (
            count > 0 &&
            count <= 8 &&
            Object.hasOwn(peppers, value.AUTH_CURRENT_PEPPER)
          );
        },
        () => new CredentialConfigurationError(),
      ),
      Effect.map((value) => ({
        current: value.AUTH_CURRENT_PEPPER,
        peppers: value.AUTH_PEPPERS,
      })),
    ),
  );
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
const bytes = (value: string) =>
  Uint8Array.from(value.match(/../g) ?? [], (part) =>
    Number.parseInt(part, 16),
  );
export interface IssuedCredential {
  readonly key: Redacted.Redacted;
  readonly keyVersion: typeof keyVersion;
  readonly lookupId: string;
}
// A 32-bit source has 2^32 outcomes. Discard the incomplete last bucket before
// taking modulo. Exporting this pure decision makes rejection cases testable
// without replacing/patching the genuine native cryptographic source.
export const unbiasedIndex = (
  value: number,
  bound: number,
): Option.Option<number> => {
  if (
    !Number.isInteger(value) ||
    value < 0 ||
    value >= 0x1_0000_0000 ||
    !Number.isInteger(bound) ||
    bound < 1 ||
    bound > 0x1_0000_0000
  )
    return Option.none();
  const limit = Math.floor(0x1_0000_0000 / bound) * bound;
  return value < limit ? Option.some(value % bound) : Option.none();
};
export class CredentialCryptography extends Context.Tag(
  "@agentforum/api/CredentialCryptography",
)<
  CredentialCryptography,
  {
    readonly issue: Effect.Effect<IssuedCredential, CredentialCryptoError>;
    readonly currentPepper: string;
    readonly digest: (
      key: Redacted.Redacted,
      version: string,
    ) => Effect.Effect<Redacted.Redacted, CredentialCryptoError>;
    readonly verify: (
      key: Redacted.Redacted,
      digest: Redacted.Redacted,
      version: string,
    ) => Effect.Effect<boolean, CredentialCryptoError>;
    readonly uniform: (
      bound: number,
    ) => Effect.Effect<number, CredentialCryptoError>;
  }
>() {}
export const credentialCryptographyLayer = Layer.effect(
  CredentialCryptography,
  Effect.gen(function* () {
    const configuration = yield* CredentialConfiguration;
    const keys = yield* Effect.forEach(
      Object.entries(Redacted.value(configuration.peppers)),
      ([version, value]) =>
        Effect.tryPromise({
          try: async () =>
            [
              version,
              await crypto.subtle.importKey(
                "raw",
                bytes(value),
                { name: "HMAC", hash: "SHA-256" },
                false,
                ["sign"],
              ),
            ] as const,
          catch: () => new CredentialCryptoError(),
        }),
    ).pipe(Effect.map((entries) => new Map(entries)));
    const digest = (key: Redacted.Redacted, version: string) =>
      Effect.gen(function* () {
        const signer = yield* Effect.fromNullable(keys.get(version)).pipe(
          Effect.mapError(() => new CredentialCryptoError()),
        );
        return yield* Effect.tryPromise({
          try: async () =>
            Redacted.make(
              hex(
                new Uint8Array(
                  await crypto.subtle.sign(
                    "HMAC",
                    signer,
                    new TextEncoder().encode(Redacted.value(key)),
                  ),
                ),
              ),
            ),
          catch: () => new CredentialCryptoError(),
        });
      });
    return {
      issue: Effect.try({
        try: () => {
          const lookupId = hex(crypto.getRandomValues(new Uint8Array(16)));
          const secret = hex(crypto.getRandomValues(new Uint8Array(32)));
          return {
            key: Redacted.make(`${keyVersion}.${lookupId}.${secret}`),
            keyVersion,
            lookupId,
          };
        },
        catch: () => new CredentialCryptoError(),
      }),
      currentPepper: configuration.current,
      digest,
      verify: (key, expected, version) =>
        Effect.gen(function* () {
          const decoded = yield* Schema.decodeUnknown(HexDigest)(
            Redacted.value(expected),
          ).pipe(Effect.mapError(() => new CredentialCryptoError()));
          const actual = yield* digest(key, version);
          return yield* Effect.try({
            try: () =>
              timingSafeEqual(bytes(Redacted.value(actual)), bytes(decoded)),
            catch: () => new CredentialCryptoError(),
          });
        }),
      uniform: (bound) =>
        Effect.try({
          try: () => {
            if (!Number.isInteger(bound) || bound < 1 || bound > 0x1_0000_0000)
              throw new CredentialCryptoError();
            for (let attempt = 0; attempt < 1024; attempt++) {
              const value = crypto.getRandomValues(new Uint32Array(1))[0];
              if (value === undefined) throw new CredentialCryptoError();
              const result = unbiasedIndex(value, bound);
              if (Option.isSome(result)) return result.value;
            }
            throw new CredentialCryptoError();
          },
          catch: () => new CredentialCryptoError(),
        }),
    };
  }),
);

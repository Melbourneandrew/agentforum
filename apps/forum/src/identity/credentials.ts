import { timingSafeEqual } from "node:crypto";
import { Context, Data, Effect, Layer, Option, Redacted, Schema } from "effect";
export class CredentialCryptoError extends Data.TaggedError(
  "CredentialCryptoError",
) {}
export const ApiKey = Schema.String.pipe(
  Schema.pattern(/^af1\.[0-9a-f]{32}\.[0-9a-f]{64}$/),
);
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
const bytes = (value: string) =>
  Uint8Array.from(value.match(/../g) ?? [], (part) =>
    Number.parseInt(part, 16),
  );
export const unbiasedIndex = (
  value: number,
  bound: number,
): Option.Option<number> =>
  Number.isInteger(value) &&
  value >= 0 &&
  value < 0x100000000 &&
  Number.isInteger(bound) &&
  bound >= 1 &&
  bound <= 0x100000000 &&
  value < Math.floor(0x100000000 / bound) * bound
    ? Option.some(value % bound)
    : Option.none();
const digest = (key: Redacted.Redacted) =>
  Effect.tryPromise({
    try: async () =>
      hex(
        new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(Redacted.value(key)),
          ),
        ),
      ),
    catch: () => new CredentialCryptoError(),
  });
export const makeCryptography = () => ({
  issue: Effect.try({
    try: () => {
      const lookupId = hex(crypto.getRandomValues(new Uint8Array(16)));
      const secret = hex(crypto.getRandomValues(new Uint8Array(32)));
      return { lookupId, key: Redacted.make(`af1.${lookupId}.${secret}`) };
    },
    catch: () => new CredentialCryptoError(),
  }),
  digest,
  verify: (key: Redacted.Redacted, expected: string) =>
    digest(key).pipe(
      Effect.flatMap((actual) =>
        Effect.try({
          try: () =>
            /^[0-9a-f]{64}$/.test(expected) &&
            timingSafeEqual(bytes(actual), bytes(expected)),
          catch: () => new CredentialCryptoError(),
        }),
      ),
    ),
  uniform: (bound: number) =>
    Effect.try({
      try: () => {
        if (!Number.isInteger(bound) || bound < 1 || bound > 0x100000000)
          throw new CredentialCryptoError();
        for (let attempt = 0; attempt < 1024; attempt++) {
          const value = crypto.getRandomValues(new Uint32Array(1))[0];
          if (value === undefined) throw new CredentialCryptoError();
          const index = unbiasedIndex(value, bound);
          if (Option.isSome(index)) return index.value;
        }
        throw new CredentialCryptoError();
      },
      catch: () => new CredentialCryptoError(),
    }),
});
export class CredentialCryptography extends Context.Tag(
  "@agentforum/forum/CredentialCryptography",
)<CredentialCryptography, ReturnType<typeof makeCryptography>>() {}
export const cryptographyLayer = Layer.sync(
  CredentialCryptography,
  makeCryptography,
);

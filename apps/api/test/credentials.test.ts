import { Effect, Layer, Option, Redacted, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  ApiKey,
  CredentialConfiguration,
  CredentialCryptography,
  credentialConfigurationLayer,
  credentialCryptographyLayer,
  unbiasedIndex,
} from "../src/identity/credentials.js";
import { GeneratedNames, generatedNamesLayer } from "../src/identity/names.js";
import { AgentName } from "../src/identity/repository.js";
import {
  vocabulary,
  vocabularyVersion,
} from "../src/identity/vocabulary/english-v1.js";
const bindings = {
  AUTH_CURRENT_PEPPER: "p2",
  AUTH_PEPPERS: JSON.stringify({ p1: "01".repeat(32), p2: "02".repeat(32) }),
};
const configuration = credentialConfigurationLayer(bindings);
const cryptography = credentialCryptographyLayer.pipe(
  Layer.provide(configuration),
);
const run = <A, E>(program: Effect.Effect<A, E, CredentialCryptography>) =>
  Effect.runPromise(program.pipe(Effect.provide(cryptography)));

describe("native credential cryptography in actual workerd", () => {
  it("issues distinct indexed versioned credentials with 256-bit random secret verifiers", async () => {
    const issued = await run(
      Effect.gen(function* () {
        const service = yield* CredentialCryptography;
        return yield* Effect.all([service.issue, service.issue]);
      }),
    );
    const first = issued[0];
    const second = issued[1];
    expect(
      Schema.decodeUnknownEither(ApiKey)(Redacted.value(first.key))._tag,
    ).toBe("Right");
    expect(first.lookupId).toHaveLength(32);
    expect(Redacted.value(first.key).split(".")[2]).toHaveLength(64);
    expect(first.keyVersion).toBe("af_v1");
    expect(first.lookupId).not.toBe(second.lookupId);
    expect(Redacted.value(first.key)).not.toBe(Redacted.value(second.key));
    expect(JSON.stringify(first)).not.toContain(Redacted.value(first.key));
  });
  it("HMACs the complete key, retains old pepper verification and uses real native constant-time comparison", async () => {
    await run(
      Effect.gen(function* () {
        const service = yield* CredentialCryptography;
        const issued = yield* service.issue;
        const old = yield* service.digest(issued.key, "p1");
        const current = yield* service.digest(
          issued.key,
          service.currentPepper,
        );
        expect(Redacted.value(old)).toHaveLength(64);
        expect(Redacted.value(current)).not.toBe(Redacted.value(old));
        expect(yield* service.verify(issued.key, old, "p1")).toBe(true);
        expect(yield* service.verify(issued.key, current, "p2")).toBe(true);
        expect(yield* service.verify(issued.key, old, "p2")).toBe(false);
        const token = Redacted.value(issued.key);
        for (const altered of [
          token.replace("af_v1", "af_v2"),
          token.slice(0, 6) + "0".repeat(32) + token.slice(38),
          token + "x",
        ])
          expect(
            yield* service.verify(Redacted.make(altered), current, "p2"),
          ).toBe(false);
        const expected = yield* Effect.promise(async () => {
          const key = await crypto.subtle.importKey(
            "raw",
            new Uint8Array(32).fill(2),
            { name: "HMAC", hash: "SHA-256" },
            false,
            ["sign"],
          );
          const signature = await crypto.subtle.sign(
            "HMAC",
            key,
            new TextEncoder().encode(token),
          );
          return Array.from(new Uint8Array(signature), (value) =>
            value.toString(16).padStart(2, "0"),
          ).join("");
        });
        expect(Redacted.value(current)).toBe(expected);
        expect(JSON.stringify({ issued, old, current })).not.toContain(token);
        expect(
          (yield* Effect.either(
            service.verify(issued.key, Redacted.make("bad-digest"), "p2"),
          ))._tag,
        ).toBe("Left");
        expect(
          (yield* Effect.either(service.digest(issued.key, "unknown")))._tag,
        ).toBe("Left");
      }),
    );
  });
  it.each([
    undefined,
    {},
    { ...bindings, AUTH_CURRENT_PEPPER: "absent" },
    { ...bindings, AUTH_PEPPERS: '{"p2":"short"}' },
    { ...bindings, AUTH_PEPPERS: '{"p2":"not-json-secret"' },
    {
      ...bindings,
      AUTH_PEPPERS: JSON.stringify(
        Object.fromEntries(
          Array.from({ length: 9 }, (_, i) => [
            `p${String(i)}`,
            "03".repeat(32),
          ]),
        ),
      ),
    },
  ])(
    "fails closed on missing/malformed/version-incomplete pepper configuration",
    async (value) => {
      const result = await Effect.runPromise(
        CredentialConfiguration.pipe(
          Effect.provide(credentialConfigurationLayer(value)),
          Effect.either,
        ),
      );
      expect(result._tag).toBe("Left");
      expect(JSON.stringify(result)).not.toContain("not-json-secret");
    },
  );
  it("rejects incomplete modulo buckets and invalid domains, then draws native in-range values", async () => {
    expect(unbiasedIndex(0, 3)).toEqual(Option.some(0));
    expect(unbiasedIndex(0xffff_fffe, 3)).toEqual(Option.some(2));
    expect(unbiasedIndex(0xffff_ffff, 3)).toEqual(Option.none());
    expect(unbiasedIndex(0xffff_ffff, 64)).toEqual(Option.some(63));
    for (const [value, bound] of [
      [-1, 3],
      [2 ** 32, 3],
      [0, 0],
      [0, 1.5],
      [NaN, 3],
    ])
      expect(unbiasedIndex(value ?? NaN, bound ?? NaN)).toEqual(Option.none());
    await run(
      Effect.gen(function* () {
        const service = yield* CredentialCryptography;
        for (const bound of [3, vocabulary.length])
          for (let i = 0; i < 100; i++) {
            const value = yield* service.uniform(bound);
            expect(value).toBeGreaterThanOrEqual(0);
            expect(value).toBeLessThan(bound);
            expect(Number.isInteger(value)).toBe(true);
          }
        expect((yield* Effect.either(service.uniform(0)))._tag).toBe("Left");
      }),
    );
  });
});
describe("pinned curated-name generation", () => {
  it("pins unique short ASCII words and native outputs to the existing name grammar", async () => {
    expect(vocabularyVersion).toBe("english-v1");
    expect(vocabulary.length).toBe(53);
    expect(new Set(vocabulary).size).toBe(vocabulary.length);
    for (const word of vocabulary) {
      expect(word).toMatch(/^[a-z]{3,7}$/);
      expect(word.length * 5).toBeLessThanOrEqual(39);
    }
    const layer = generatedNamesLayer.pipe(Layer.provide(cryptography));
    await Effect.runPromise(
      Effect.gen(function* () {
        const names = yield* GeneratedNames;
        for (let i = 0; i < 100; i++) {
          const name = yield* names.next;
          const words = name.match(/[A-Z][a-z]*/g) ?? [];
          expect(words.length).toBeGreaterThanOrEqual(3);
          expect(words.length).toBeLessThanOrEqual(5);
          expect(Schema.decodeUnknownEither(AgentName)(name)._tag).toBe(
            "Right",
          );
          for (const word of words)
            expect(new Set<string>(vocabulary).has(word.toLowerCase())).toBe(
              true,
            );
        }
      }).pipe(Effect.provide(layer)),
    );
  });
  it.each([0, 1, 2])(
    "requests uniform word-count and independent word draws for count offset %s",
    async (offset) => {
      await run(
        Effect.gen(function* () {
          const actual = yield* CredentialCryptography;
          const bounds: number[] = [];
          const fixture = Layer.succeed(CredentialCryptography, {
            ...actual,
            uniform: (bound) =>
              Effect.sync(() => {
                bounds.push(bound);
                return bounds.length === 1 ? offset : 0;
              }),
          });
          const result = yield* Effect.flatMap(
            GeneratedNames,
            (names) => names.next,
          ).pipe(
            Effect.provide(generatedNamesLayer.pipe(Layer.provide(fixture))),
          );
          expect(bounds).toEqual([
            3,
            ...Array.from({ length: 3 + offset }, () => vocabulary.length),
          ]);
          expect(result).toBe("Acorn".repeat(3 + offset));
        }),
      );
    },
  );
});

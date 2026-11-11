import { Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  Cursors,
  CursorPayload,
  cursorConfigurationLayer,
  cursorsLayer,
} from "../src/retrieval/cursors.js";
const keys = { k1: "11".repeat(32), k2: "22".repeat(32) };
const live = (current = "k1", ring: Readonly<Record<string, string>> = keys) =>
  cursorsLayer.pipe(
    Layer.provide(
      cursorConfigurationLayer({
        CURSOR_CURRENT_KEY: current,
        CURSOR_KEYS: JSON.stringify(ring),
      }),
    ),
  );
const encode = (text: string) =>
  btoa(text).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
const inspect = (token: string) =>
  Schema.decodeUnknownSync(
    Schema.Struct({
      payload: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
      signature: Schema.String,
    }),
  )(JSON.parse(atob(token.replace(/-/g, "+").replace(/_/g, "/"))));
const position = {
  purpose: "read",
  ordering: "chronological_asc",
  boundary: {
    kind: "post",
    publicationOrder: "9007199254740993",
    postId: "A".repeat(21),
  },
  query: "a".repeat(64),
};
const expected = {
  purpose: "read",
  ordering: "chronological_asc",
  query: position.query,
} as const;
const run = <A, E>(effect: Effect.Effect<A, E, Cursors>) =>
  Effect.runPromise(effect.pipe(Effect.provide(live())));
const invalid = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    expect(yield* Effect.either(effect)).toMatchObject({
      _tag: "Left",
      left: { _tag: "CursorInvalidError" },
    });
  });
describe("native permanent cursors in workerd", () => {
  it("signs transparent versioned envelopes with native HMAC and no credential or expiry", async () => {
    await run(
      Effect.gen(function* () {
        const service = yield* Cursors;
        const token = yield* service.sign(position);
        expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
        const envelope = inspect(token);
        expect(envelope.payload).toEqual({
          ...position,
          version: 1,
          api: "/v1",
          key_id: "k1",
        });
        expect(JSON.stringify(envelope)).not.toContain(keys.k1);
        expect(envelope.payload).not.toHaveProperty("exp");
        expect(yield* service.verify(token, expected)).toEqual(
          envelope.payload,
        );
        expect(Schema.is(CursorPayload)(envelope.payload)).toBe(true);
      }),
    );
  });
  it("fingerprints normalized selection only, preserving case-sensitive ID contents", async () => {
    await run(
      Effect.gen(function* () {
        const service = yield* Cursors;
        expect(yield* service.fingerprint({})).toBe(
          "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
        );
        const id = "a".repeat(21),
          parent = "P".repeat(21);
        expect(yield* service.fingerprint({ id, reply_to: parent })).toBe(
          yield* service.fingerprint({ reply_to: parent, id }),
        );
        expect(yield* service.fingerprint({ id })).not.toBe(
          yield* service.fingerprint({ id: "A".repeat(21) }),
        );
        yield* invalid(service.fingerprint({ limit: 1 }));
      }),
    );
  });
  it("accepts before-first only as an ascending read boundary with no Post ID", async () => {
    await run(
      Effect.gen(function* () {
        const service = yield* Cursors;
        const before = {
          ...position,
          boundary: { kind: "before_first", publicationOrder: "0" },
        };
        const token = yield* service.sign(before);
        expect((yield* service.verify(token, expected)).boundary).toEqual(
          before.boundary,
        );
        yield* invalid(service.sign({ ...before, purpose: "page" }));
        yield* invalid(
          service.sign({
            ...before,
            boundary: { ...before.boundary, postId: "A".repeat(21) },
          }),
        );
        yield* invalid(
          service.sign({ ...before, ordering: "chronological_desc" }),
        );
      }),
    );
  });
  it("separates page/read purposes, ordering and query fingerprints", async () => {
    await run(
      Effect.gen(function* () {
        const service = yield* Cursors;
        const token = yield* service.sign(position);
        for (const mismatch of [
          { ...expected, purpose: "page" },
          { ...expected, ordering: "chronological_desc" },
          { ...expected, query: "b".repeat(64) },
        ] as const)
          yield* invalid(service.verify(token, mismatch));
        const page = yield* service.sign({
          ...position,
          purpose: "page",
          ordering: "chronological_desc",
        });
        expect(
          (yield* service.verify(page, {
            ...expected,
            purpose: "page",
            ordering: "chronological_desc",
          })).purpose,
        ).toBe("page");
      }),
    );
  });
  it("rejects changes to every signed semantic field, unknown keys and signatures", async () => {
    await run(
      Effect.gen(function* () {
        const service = yield* Cursors;
        const envelope = inspect(yield* service.sign(position));
        for (const patch of [
          { version: 2 },
          { key_id: "unknown" },
          { key_id: "constructor" },
          { api: "/v2" },
          { purpose: "page" },
          { ordering: "chronological_desc" },
          { query: "b".repeat(64) },
          { boundary: { ...position.boundary, publicationOrder: "2" } },
          { boundary: { ...position.boundary, postId: "B".repeat(21) } },
        ])
          yield* invalid(
            service.verify(
              encode(
                JSON.stringify({
                  ...envelope,
                  payload: { ...envelope.payload, ...patch },
                }),
              ),
              expected,
            ),
          );
        yield* invalid(
          service.verify(
            encode(JSON.stringify({ ...envelope, signature: "A".repeat(43) })),
            expected,
          ),
        );
      }),
    );
  });
  it("rejects malformed, noncanonical, oversized and invalid UTF-8 tokens", async () => {
    await run(
      Effect.gen(function* () {
        const service = yield* Cursors;
        for (const value of [
          undefined,
          null,
          {},
          "",
          "=",
          "!",
          "a.b",
          "Zh",
          "A".repeat(4097),
          encode(String.fromCharCode(255)),
          encode("[]"),
        ])
          yield* invalid(service.verify(value, expected));
      }),
    );
  });
  it("retains historical keys across current-key additions without clock expiry", async () => {
    const token = await Effect.runPromise(
      Effect.flatMap(Cursors, (service) => service.sign(position)).pipe(
        Effect.provide(live("k1", { k1: keys.k1 })),
      ),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* Cursors;
        expect((yield* service.verify(token, expected)).key_id).toBe("k1");
        const newer = yield* service.sign(position);
        expect((yield* service.verify(newer, expected)).key_id).toBe("k2");
      }).pipe(Effect.provide(live("k2"))),
    );
    await Effect.runPromise(
      Effect.flatMap(Cursors, (service) =>
        invalid(service.verify(token, expected)),
      ).pipe(Effect.provide(live("k2", { k2: keys.k2 }))),
    );
  });
  it("fails closed on malformed or missing server key configuration without exposing material", async () => {
    for (const bindings of [
      undefined,
      {},
      {
        CURSOR_CURRENT_KEY: "bad\n",
        CURSOR_KEYS: JSON.stringify({ "bad\n": keys.k1 }),
      },
      { CURSOR_CURRENT_KEY: "missing", CURSOR_KEYS: JSON.stringify(keys) },
      {
        CURSOR_CURRENT_KEY: "k1",
        CURSOR_KEYS: '{"k1":"synthetic-secret-do-not-reflect"}',
      },
      { CURSOR_CURRENT_KEY: "k1", CURSOR_KEYS: "{" },
    ]) {
      const result = await Effect.runPromise(
        Effect.either(
          Cursors.pipe(
            Effect.provide(
              cursorsLayer.pipe(
                Layer.provide(cursorConfigurationLayer(bindings)),
              ),
            ),
          ),
        ),
      );
      expect(result).toMatchObject({
        _tag: "Left",
        left: { _tag: "CursorConfigurationError" },
      });
      expect(JSON.stringify(result)).not.toContain(
        "synthetic-secret-do-not-reflect",
      );
    }
  });
  it("keeps PostgreSQL bigint boundaries precise and rejects invalid/overflowing variants", async () => {
    await run(
      Effect.gen(function* () {
        const service = yield* Cursors;
        for (const order of ["1", "9223372036854775807"]) {
          const token = yield* service.sign({
            ...position,
            boundary: { ...position.boundary, publicationOrder: order },
          });
          expect(
            (yield* service.verify(token, expected)).boundary.publicationOrder,
          ).toBe(order);
        }
        for (const order of [
          "0",
          "-1",
          "01",
          "1.5",
          "1\n",
          "1\u2028",
          "9223372036854775808",
          "1".repeat(100),
        ])
          yield* invalid(
            service.sign({
              ...position,
              boundary: { ...position.boundary, publicationOrder: order },
            }),
          );
      }),
    );
  });
  it("rejects duplicate JSON keys and unknown envelope fields even with an otherwise valid tag", async () => {
    await run(
      Effect.gen(function* () {
        const service = yield* Cursors;
        const envelope = inspect(yield* service.sign(position));
        yield* invalid(
          service.verify(
            encode(
              `{"payload":${JSON.stringify(envelope.payload)},"payload":${JSON.stringify(envelope.payload)},"signature":${JSON.stringify(envelope.signature)}}`,
            ),
            expected,
          ),
        );
        yield* invalid(
          service.verify(
            encode(JSON.stringify({ ...envelope, extra: "ignored?" })),
            expected,
          ),
        );
        yield* invalid(
          service.verify(
            encode(
              JSON.stringify({
                ...envelope,
                payload: { ...envelope.payload, extra: "ignored?" },
              }),
            ),
            expected,
          ),
        );
      }),
    );
  });
});

import { Effect, Either, Encoding, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  canonicalSelection,
  checkedOffsetAddition,
  CursorEnvelope,
  decodeCursor,
  decodeSearch,
  encodeCursor,
  normalizedSelection,
  parseTextQuery,
  SearchInput,
  selectionFingerprint,
} from "../src/api/query.js";

const id = "a".repeat(21);
const fingerprint = "a".repeat(64);
const base = { version: 1, api: "v1", fingerprint } as const;
const boundary = { sequence: "9223372036854775807", id };
const invalidSearch = async (input: unknown) => {
  expect(
    Either.isLeft(await Effect.runPromise(Effect.either(decodeSearch(input)))),
  ).toBe(true);
};
const invalidCursor = (input: unknown) => {
  const token = Encoding.encodeBase64Url(JSON.stringify(input));
  expect(
    Either.isLeft(Effect.runSync(Effect.either(decodeCursor(token)))),
  ).toBe(true);
};

// No env binding, database, SQL or business handler is used by this suite.
describe("pure query contracts in native workerd", () => {
  it("executes in the Worker runtime and decodes defaults to internal Option", async () => {
    expect(navigator.userAgent).toContain("Cloudflare-Workers");
    const search = await Effect.runPromise(decodeSearch({}));
    expect(search.resource).toBe("posts");
    if (search.resource !== "posts" || "id" in search)
      throw new Error("Expected posts");
    expect(search).toMatchObject({
      order: "newest",
      limit: 50,
      tags: [],
      tagMatch: "all",
    });
    expect(Option.isNone(search.q)).toBe(true);
    expect(Option.isNone(search.author)).toBe(true);
    expect(Schema.decodeUnknownSync(SearchInput)({}).resource).toBe("posts");
  });

  it("rejects unknown properties, malformed fields and incompatible resource/modes", async () => {
    for (const input of [
      { metadata: {} },
      { resource: undefined },
      { limit: undefined },
      { tags: undefined },
      { resource: "other" },
      { resource: "agents", q: "hello" },
      { resource: "agents", id },
      { resource: "agents", author: id },
      { resource: "agents", readCursor: "x" },
      { resource: "agents", tags: [] },
      { resource: "agents", order: "newest" },
      { resource: "agents", name: "a--b" },
      { resource: "agents", name: "a", pageCursor: "x" },
      { author: "bad" },
      { parent: null },
      { id, author: id },
      { id, tags: [] },
      { id, limit: 50 },
      { id, order: "newest" },
      { id, q: "a" },
      { id, order: "oldest" },
      { id, tags: ["x"] },
      { id, pageCursor: "x" },
      { pageCursor: "x", readCursor: "x" },
      { order: "relevance" },
      { order: "relevance", q: "a", readCursor: "x" },
      { limit: 0 },
      { limit: 101 },
      { limit: 1.1 },
      { limit: "50" },
      { tags: Array.from({ length: 33 }, () => "same") },
      { tags: [""] },
      { tags: ["a".repeat(65)] },
      { q: "" },
      { q: "\ud800" },
      { q: " \n\t" },
      { q: '""' },
      { q: '"  "' },
      { q: '"unclosed' },
      { q: 'un"matched' },
      { q: '"hello"tail' },
      { q: "é".repeat(1025) },
      { q: Array.from({ length: 33 }, () => "a").join(" ") },
    ])
      await invalidSearch(input);
    for (const input of [
      {
        author: id,
        parent: id,
        tags: ["x"],
        q: 'hello "two words"',
        limit: 100,
      },
      { resource: "agents", name: "Agent-Name" },
      { id },
    ]) {
      expect(
        Either.isRight(
          await Effect.runPromise(Effect.either(decodeSearch(input))),
        ),
      ).toBe(true);
    }
  });

  it("parses bounded literal AND clauses without claiming native tokenization", () => {
    expect(
      Effect.runSync(parseTextQuery(' OR  "hello   world" a* NOT ')),
    ).toEqual([
      { kind: "word", value: "OR" },
      { kind: "phrase", value: "hello world" },
      { kind: "word", value: "a*" },
      { kind: "word", value: "NOT" },
    ]);
    expect(Effect.runSync(parseTextQuery("é".repeat(1024)))).toHaveLength(1);
    expect(
      Effect.runSync(
        parseTextQuery(Array.from({ length: 32 }, () => "a").join(" ")),
      ),
    ).toHaveLength(32);
    // These are syntax-valid only: WO-38 MUST validate actual native tokens.
    // Do not classify combining marks/private-use characters with JS L/N regex.
    for (const q of ["!!!", "\u0301", "\ue000", '"!!!"'])
      expect(Effect.runSync(parseTextQuery(q))).toHaveLength(1);
  });

  it("normalizes defaults, key order, opaque tag sets and parsed query whitespace", async () => {
    const a = await Effect.runPromise(
      decodeSearch({ tags: ["z", "A", "z", "é"], q: 'hello "two words"' }),
    );
    const b = await Effect.runPromise(
      decodeSearch({
        q: ' hello  "two   words" ',
        limit: 100,
        order: "oldest",
        resource: "posts",
        tags: ["é", "z", "A"],
        tagMatch: "all",
      }),
    );
    expect(canonicalSelection(a)).toBe(canonicalSelection(b));
    expect(normalizedSelection(a)).toMatchObject({ tags: ["A", "z", "é"] });
    expect(await Effect.runPromise(selectionFingerprint(a))).toBe(
      await Effect.runPromise(selectionFingerprint(b)),
    );
    expect(await Effect.runPromise(selectionFingerprint(a))).toMatch(
      /^[0-9a-f]{64}$/,
    );
    const empty = await Effect.runPromise(decodeSearch({}));
    const explicit = await Effect.runPromise(
      decodeSearch({
        resource: "posts",
        tags: [],
        tagMatch: "any",
        limit: 50,
        order: "newest",
      }),
    );
    expect(canonicalSelection(empty)).toBe(canonicalSelection(explicit));
    expect(await Effect.runPromise(selectionFingerprint(empty))).toBe(
      "60ee8cd5ee38ae8a7485db290d6e8511f9deddf7ea6f911550e2efa4dec30544",
    );
    expect(
      Either.isLeft(
        Schema.decodeUnknownEither(SearchInput)({ unexpected: true }),
      ),
    ).toBe(true);
    expect(
      Either.isLeft(
        Schema.decodeUnknownEither(SearchInput)({
          resource: "agents",
          q: "hello",
        }),
      ),
    ).toBe(true);
    const unicodeTags = await Effect.runPromise(
      decodeSearch({ tags: ["\u{10000}", "\ue000", "e\u0301", "é"] }),
    );
    expect(normalizedSelection(unicodeTags)).toMatchObject({
      tags: ["e\u0301", "é", "\ue000", "\u{10000}"],
    });
    const distinct = await Effect.runPromise(
      decodeSearch({ tags: ["Z", "A", "é"], q: 'hello "two words"' }),
    );
    expect(canonicalSelection(a)).not.toBe(canonicalSelection(distinct));
    const names = await Promise.all(
      ["Agent", "agent"].map((name) =>
        Effect.runPromise(decodeSearch({ resource: "agents", name })),
      ),
    );
    expect(names.map(canonicalSelection)[0]).toBe(
      names.map(canonicalSelection)[1],
    );
  });

  it("round-trips every cursor variant without rounding signed-64 sequence values", () => {
    const inputs: readonly CursorEnvelope[] = [
      {
        ...base,
        resource: "posts",
        purpose: "page",
        order: "newest",
        boundary,
      },
      {
        ...base,
        resource: "posts",
        purpose: "page",
        order: "oldest",
        boundary: { sequence: "1", id },
      },
      {
        ...base,
        resource: "posts",
        purpose: "read",
        order: "oldest",
        boundary,
      },
      {
        ...base,
        resource: "posts",
        purpose: "read",
        order: "oldest",
        boundary: { sequence: "0" },
      },
      {
        ...base,
        resource: "posts",
        purpose: "page",
        order: "relevance",
        offset: Number.MAX_SAFE_INTEGER,
      },
      {
        ...base,
        resource: "agents",
        purpose: "page",
        order: "activity",
        offset: 0,
      },
    ];
    for (const input of inputs) {
      const token = Effect.runSync(encodeCursor(input));
      expect(token).not.toMatch(/[+/=]/);
      expect(Effect.runSync(decodeCursor(token))).toEqual(input);
      expect(Schema.decodeUnknownSync(CursorEnvelope)(input)).toEqual(input);
    }
  });

  it("rejects malformed or noncanonical encoding and invalid UTF-8 before schema decode", () => {
    for (const token of [
      "",
      "a".repeat(4097),
      "=",
      "a+b",
      "a/b",
      "e30=",
      "Zh",
      Encoding.encodeBase64Url(new Uint8Array([255])),
      Encoding.encodeBase64Url("not json"),
    ]) {
      expect(
        Either.isLeft(Effect.runSync(Effect.either(decodeCursor(token)))),
      ).toBe(true);
    }
  });

  it("validates complete envelope, signed64 bounds, Nano21, sentinel and offsets", () => {
    const page = {
      ...base,
      resource: "posts",
      purpose: "page",
      order: "newest",
      boundary,
    };
    for (const input of [
      { ...page, version: 2 },
      { ...page, api: "v2" },
      { ...page, extra: 1 },
      { ...page, fingerprint: "A".repeat(64) },
      { ...page, purpose: "read" },
      ...["0", "-1", "01", "1.0", "9223372036854775808", 1].map((sequence) => ({
        ...page,
        boundary: { sequence, id },
      })),
      { ...page, boundary: { sequence: "1", id: "bad" } },
      { ...page, boundary: { sequence: "1", id, extra: 1 } },
      { ...page, boundary: { sequence: "0" } },
      {
        ...page,
        purpose: "read",
        order: "oldest",
        boundary: { sequence: "0", id },
      },
      { ...page, order: "relevance" },
      ...[-1, 1.1, Number.MAX_SAFE_INTEGER + 1].map((offset) => ({
        ...base,
        resource: "posts",
        purpose: "page",
        order: "relevance",
        offset,
      })),
      {
        ...base,
        resource: "agents",
        purpose: "read",
        order: "activity",
        offset: 0,
      },
      {
        ...base,
        resource: "agents",
        purpose: "page",
        order: "newest",
        offset: 0,
      },
    ])
      invalidCursor(input);
  });

  it("binds cursors to selection/resource/purpose/order but not page size", async () => {
    const search = await Effect.runPromise(decodeSearch({ tags: ["a"] }));
    const fp = await Effect.runPromise(selectionFingerprint(search));
    const pageCursor = Effect.runSync(
      encodeCursor({
        ...base,
        fingerprint: fp,
        resource: "posts",
        purpose: "page",
        order: "newest",
        boundary,
      }),
    );
    await Effect.runPromise(
      decodeSearch({ tags: ["a", "a"], limit: 100, pageCursor }),
    );
    await invalidSearch({ tags: ["b"], pageCursor });
    await invalidSearch({ tags: ["a"], order: "oldest", pageCursor });
    await invalidSearch({ tags: ["a"], readCursor: pageCursor });
    await invalidSearch({ resource: "agents", pageCursor });
    const readCursor = Effect.runSync(
      encodeCursor({
        ...base,
        fingerprint: fp,
        resource: "posts",
        purpose: "read",
        order: "oldest",
        boundary: { sequence: "0" },
      }),
    );
    expect(
      await Effect.runPromise(decodeSearch({ tags: ["a"], readCursor })),
    ).toMatchObject({ order: "oldest" });
    await Effect.runPromise(
      decodeSearch({ tags: ["a"], order: "oldest", readCursor }),
    );
    await invalidSearch({ tags: ["a"], pageCursor: readCursor });
    const agents = await Effect.runPromise(
      decodeSearch({ resource: "agents" }),
    );
    const agentCursor = Effect.runSync(
      encodeCursor({
        ...base,
        fingerprint: await Effect.runPromise(selectionFingerprint(agents)),
        resource: "agents",
        purpose: "page",
        order: "activity",
        offset: 3,
      }),
    );
    await Effect.runPromise(
      decodeSearch({ resource: "agents", pageCursor: agentCursor, limit: 1 }),
    );
    const relevance = await Effect.runPromise(
      decodeSearch({ q: "word", order: "relevance" }),
    );
    const relevanceCursor = Effect.runSync(
      encodeCursor({
        ...base,
        fingerprint: await Effect.runPromise(selectionFingerprint(relevance)),
        resource: "posts",
        purpose: "page",
        order: "relevance",
        offset: 0,
      }),
    );
    await Effect.runPromise(
      decodeSearch({
        q: "word",
        order: "relevance",
        pageCursor: relevanceCursor,
      }),
    );
    await invalidSearch({ q: "word", readCursor: relevanceCursor });
  });

  it("checks every offset addition before loss of integer precision", () => {
    expect(
      Effect.runSync(checkedOffsetAddition(Number.MAX_SAFE_INTEGER - 1, 1)),
    ).toBe(Number.MAX_SAFE_INTEGER);
    expect(Effect.runSync(checkedOffsetAddition(0, 0))).toBe(0);
    for (const [offset, returned] of [
      [Number.MAX_SAFE_INTEGER, 1],
      [-1, 1],
      [1, -1],
      [0.1, 1],
      [1, Infinity],
      [NaN, 1],
    ]) {
      if (offset === undefined || returned === undefined)
        throw new Error("Invalid test fixture");
      expect(
        Either.isLeft(
          Effect.runSync(
            Effect.either(checkedOffsetAddition(offset, returned)),
          ),
        ),
      ).toBe(true);
    }
  });
});

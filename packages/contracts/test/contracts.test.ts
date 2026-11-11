import { Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { PostRecord, SearchInput, SearchResult } from "../src/index.js";
const metadata: unknown = JSON.parse(
  '{"__proto__":{"own":true},"nested":[{"null":null,"flag":false,"n":3}]}',
);
const post = {
  id: "a".repeat(21),
  author_id: "6eae4017-9df1-4bd4-b5c7-f29c58a40d3d",
  author_name: "CaseSensitive",
  body: "---\nauthor: forged\n---\n# Raw Markdown\n",
  metadata,
  reply_to_id: null,
  publication_order: "9007199254740993",
  published_at: "2026-11-11T08:00:00.000Z",
};
describe("shared public /v1 representation", () => {
  it("preserves raw content, own metadata keys, typed data and exact decimal order", () => {
    const value = Schema.decodeUnknownSync(PostRecord)(post);
    expect(value.body).toBe(post.body);
    expect(value.metadata).toEqual(post.metadata);
    expect(Object.hasOwn(value.metadata, "__proto__")).toBe(true);
    expect(value.metadata).not.toHaveProperty("type");
    expect(value.publication_order).toBe("9007199254740993");
    expect(Option.isNone(value.reply_to_id)).toBe(true);
    expect(Schema.encodeSync(PostRecord)(value)).toEqual(post);
  });
  it("shares cursor exclusivity, default limit and strict grammar", () => {
    expect(Schema.decodeUnknownSync(SearchInput)({})).toEqual({ limit: 20 });
    for (const input of [
      { cursor: "a", read_cursor: "b" },
      { cursor: "abc\n" },
      { limit: 0 },
      { limit: 51 },
    ])
      expect(Schema.decodeUnknownEither(SearchInput)(input)._tag).toBe("Left");
  });
  it("round trips the same nullable page cursor and full Post result", () => {
    const wire = {
      posts: [post],
      page_cursor: null,
      read_cursor: "opaque",
      has_more: false,
    };
    const value = Schema.decodeUnknownSync(SearchResult)(wire);
    expect(Option.isNone(value.page_cursor)).toBe(true);
    expect(Schema.encodeSync(SearchResult)(value)).toEqual(wire);
  });
});

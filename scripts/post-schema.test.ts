import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSONSchema, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { PostResult, PublishInput } from "../apps/forum/src/api/contracts.js";
import { mergeSchemaDefinitions } from "../apps/forum/scripts/merge-schema-definitions.js";

const document: unknown = JSON.parse(
  readFileSync("apps/forum/generated/post.schema.json", "utf8"),
);
const resolvePointer = (pointer: string) => {
  assert.ok(pointer.startsWith("#/"));
  let node = document;
  for (const encoded of pointer.slice(2).split("/")) {
    const key = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    assert.ok(
      typeof node === "object" && node !== null && Object.hasOwn(node, key),
    );
    node = Object.getOwnPropertyDescriptor(node, key)?.value;
  }
  assert.notEqual(node, undefined);
  return node;
};
const input = (value: unknown) => Schema.decodeUnknownSync(PublishInput)(value);

describe("source-authoritative Post guidance metadata", () => {
  it("merges equal definitions without mutation and rejects conflicting collisions", () => {
    const original = { Shared: { type: "string" } } as const;
    const other = {
      Shared: { type: "string" },
      Input: { type: "number" },
    } as const;
    expect(mergeSchemaDefinitions(original, other)).toEqual({
      ...original,
      ...other,
    });
    expect(mergeSchemaDefinitions(original, other).Shared).toBe(
      original.Shared,
    );
    expect(original).toEqual({ Shared: { type: "string" } });
    expect(() =>
      mergeSchemaDefinitions(original, { Shared: { type: "number" } }),
    ).toThrow("Conflicting schema definition: Shared");
  });
  it("resolves every local JSON Pointer including the separate generated input definition", () => {
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
      } else if (typeof value === "object" && value !== null)
        for (const [key, child] of Object.entries(value)) {
          if (key === "$ref") {
            assert.equal(typeof child, "string");
            assert.ok(typeof child === "string");
            resolvePointer(child);
          } else visit(child);
        }
    };
    visit(document);
    expect(resolvePointer("#/$defs/PublishInput")).toEqual(
      JSONSchema.make(PublishInput).$defs?.PublishInput,
    );
    expect(resolvePointer("#/$defs/PostResult")).toEqual(
      JSONSchema.make(PostResult).$defs?.PostResult,
    );
  });
  it("distinguishes optional submitted tags and domain default from mandatory complete output", () => {
    expect(input({ body: "Markdown" })).toEqual({ body: "Markdown" });
    // Domain publication, not the optional-input validator, supplies default[].
    expect(input({ body: "Markdown", tags: [] })).toEqual({
      body: "Markdown",
      tags: [],
    });
    const source = JSONSchema.make(PublishInput).$defs?.PublishInput;
    expect(source).toMatchObject({
      required: ["body"],
      additionalProperties: false,
    });
    expect(source).toHaveProperty(
      "description",
      expect.stringContaining("omitted tags become []"),
    );
    expect(resolvePointer("#/$defs/PostResult")).toHaveProperty("required", [
      "id",
      "authorId",
      "reply_to",
      "body",
      "tags",
      "publishedAt",
      "publicationOrder",
    ]);
  });
  it("preserves input rejection, opaque tag bytes and source-owned publication/tag limits", () => {
    expect(() => input({ body: "" })).toThrow();
    expect(() => input({ body: "x", metadata: {} })).toThrow();
    for (const field of [
      "id",
      "authorId",
      "publishedAt",
      "publicationOrder",
      "type",
    ])
      expect(() => input({ body: "x", [field]: "unsupported" })).toThrow();
    expect(
      input({
        body: "x",
        tags: ["experiment:42", "HOLD", "hold", " HOLD", "HOLD"],
      }),
    ).toHaveProperty("tags", [
      "experiment:42",
      "HOLD",
      "hold",
      " HOLD",
      "HOLD",
    ]);
    expect(() =>
      input({ body: "x", tags: Array.from({ length: 33 }, () => "duplicate") }),
    ).toThrow();
    expect(() => input({ body: "x", tags: ["a".repeat(65)] })).toThrow();
    expect(() =>
      input({ body: "x", tags: ["💠".repeat(63) + "💠\u0301"] }),
    ).toThrow();
    expect(input({ body: "x", tags: ["💠".repeat(64)] })).toHaveProperty(
      "tags",
    );
    expect(resolvePointer("#/$defs/PublishInput")).toHaveProperty(
      "description",
      expect.stringContaining("65536 UTF-8 bytes"),
    );
    expect(
      resolvePointer("#/$defs/PublishInput/properties/tags"),
    ).toHaveProperty("maxItems", 32);
    expect(
      resolvePointer("#/$defs/PublishInput/properties/tags/items"),
    ).toMatchObject({ "x-maxUtf8Bytes": 256, "x-maxGraphemeClusters": 64 });
  });
  it("links to supplied local public guides covering both owned behavior areas", () => {
    assert.ok(
      typeof document === "object" &&
        document !== null &&
        "x-documentation" in document,
    );
    expect(document["x-documentation"]).toEqual({
      publication: "/docs/publication/",
      retrieval: "/docs/retrieval/",
    });
    const publication = readFileSync(
      "apps/forum/public/docs/publication/index.html",
      "utf8",
    );
    const retrieval = readFileSync(
      "apps/forum/public/docs/retrieval/index.html",
      "utf8",
    );
    for (const phrase of [
      "65,536",
      "server-established",
      "immutable",
      "256",
      "reply_to",
    ])
      expect(publication).toContain(phrase);
    for (const phrase of [
      "readCursor",
      "tagMatch",
      "unicode61",
      "relevance",
      "pageCursor",
    ])
      expect(retrieval).toContain(phrase);
    expect(
      readFileSync("apps/forum/public/docs/post.schema.json", "utf8"),
    ).toBe(readFileSync("apps/forum/generated/post.schema.json", "utf8"));
  });
});

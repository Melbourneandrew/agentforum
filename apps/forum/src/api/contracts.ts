import { Schema } from "effect";

// Wire schemas are shared by both transports. No normalization of submitted text.
export const Utf8Text = Schema.String.pipe(
  Schema.pattern(/^[^\uD800-\uDFFF]*$/u),
);
export const Nano21 = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9_-]{21}$/));
export const AgentName = Schema.String.pipe(
  Schema.pattern(/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/),
);
export const PublicationOrder = Schema.String.pipe(
  Schema.pattern(/^[1-9][0-9]{0,18}$/),
  Schema.filter((value) => BigInt(value) <= 9223372036854775807n, {
    jsonSchema: { "x-maximumDecimal": "9223372036854775807" },
  }),
);
export const Timestamp = Schema.String.pipe(
  Schema.pattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
);
export const Tag = Utf8Text.pipe(
  Schema.minLength(1),
  Schema.maxLength(256),
  Schema.filter(
    (value) =>
      new TextEncoder().encode(value).length <= 256 &&
      [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(value)]
        .length <= 64,
    { jsonSchema: { "x-maxUtf8Bytes": 256, "x-maxGraphemeClusters": 64 } },
  ),
);
export const Tags = Schema.Array(Tag).pipe(Schema.maxItems(32));
export const RegisterInput = Schema.Struct({
  name: Schema.optional(AgentName),
}).annotations({
  identifier: "RegisterInput",
  parseOptions: { onExcessProperty: "error" },
});
export const PublishInput = Schema.Struct({
  body: Utf8Text.pipe(Schema.minLength(1), Schema.maxLength(65536)),
  reply_to: Schema.optional(Nano21),
  tags: Schema.optional(Tags),
}).annotations({
  identifier: "PublishInput",
  parseOptions: { onExcessProperty: "error" },
  description:
    "Original decoded JSON is limited to 65536 UTF-8 bytes, before normalization. Tags are counted before exact deduplication; omitted tags become [].",
});
export const PostResult = Schema.Struct({
  id: Nano21,
  authorId: Nano21,
  reply_to: Schema.NullOr(Nano21),
  body: Utf8Text,
  tags: Tags,
  publishedAt: Timestamp,
  publicationOrder: PublicationOrder,
}).annotations({ identifier: "PostResult" });
export const RegistrationResult = Schema.Struct({
  id: Nano21,
  name: AgentName,
  apiKey: Schema.NonEmptyString,
}).annotations({
  identifier: "RegistrationResult",
  description:
    "Plaintext credential returned once; a lost response cannot recover it.",
});
export const AgentRecord = Schema.Struct({
  name: AgentName,
  latestPublishingTime: Schema.NullOr(Timestamp),
  posts: Schema.Struct({ resource: Schema.Literal("posts"), author: Nano21 }),
}).annotations({
  identifier: "AgentRecord",
  description:
    "Only local public identity and publishing activity. Null latestPublishingTime means never published; posts is a local search selection, not an external URL.",
});
export const CursorToken = Schema.NonEmptyString.pipe(
  Schema.maxLength(4096),
  Schema.pattern(/^[A-Za-z0-9_-]+$/),
);
export const PostLookupResult = Schema.Struct({
  resource: Schema.Literal("posts"),
  post: PostResult,
});
export const PostPageResult = Schema.Struct({
  resource: Schema.Literal("posts"),
  posts: Schema.Array(PostResult).pipe(Schema.maxItems(100)),
  pageCursor: Schema.NullOr(CursorToken),
  readCursor: CursorToken,
});
export const RelevancePageResult = Schema.Struct({
  resource: Schema.Literal("posts"),
  posts: Schema.Array(PostResult).pipe(Schema.maxItems(100)),
  pageCursor: Schema.NullOr(CursorToken),
});
export const AgentLookupResult = Schema.Struct({
  resource: Schema.Literal("agents"),
  agent: AgentRecord,
});
export const AgentPageResult = Schema.Struct({
  resource: Schema.Literal("agents"),
  agents: Schema.Array(AgentRecord).pipe(Schema.maxItems(100)),
  pageCursor: Schema.NullOr(CursorToken),
});
export const SearchResult = Schema.Union(
  PostLookupResult,
  PostPageResult,
  RelevancePageResult,
  AgentLookupResult,
  AgentPageResult,
).annotations({ identifier: "SearchResult" });
export const decodeTags = (input: unknown) =>
  Schema.decodeUnknown(Tags)(input, { onExcessProperty: "error" });

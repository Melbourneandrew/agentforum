import { Schema } from "effect";
export const AgentName = Schema.String.pipe(
  Schema.pattern(/^(?!.*--)[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/),
  // Keep consecutive hyphens and line terminators out of prepared names.
  Schema.filter((name) => !name.includes("--") && !/[^A-Za-z0-9-]/.test(name)),
);
// Identity validation preserves open JSON properties such as __proto__ rather
// than rebuilding a Record and accidentally dropping or interpreting keys.
export const MetadataObject = Schema.declare(
  (value: unknown): value is Readonly<Record<string, unknown>> =>
    typeof value === "object" && value !== null && !Array.isArray(value),
).annotations({ jsonSchema: { type: "object", additionalProperties: true } });
export const PostId = Schema.String.pipe(
  Schema.length(21),
  Schema.pattern(/^[A-Za-z0-9_-]{21}$/),
);
export const PublicationOrder = Schema.String.pipe(
  Schema.pattern(/^[1-9][0-9]*$/),
  Schema.filter((value) => value.trim() === value),
);
export const Timestamp = Schema.String.pipe(
  Schema.length(24),
  Schema.pattern(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
);
export const PostRecord = Schema.Struct({
  id: PostId,
  author_id: Schema.UUID,
  author_name: AgentName,
  body: Schema.NonEmptyString,
  metadata: MetadataObject,
  reply_to_id: Schema.OptionFromNullOr(PostId),
  publication_order: PublicationOrder,
  published_at: Timestamp,
});
export const CursorToken = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(4096),
  Schema.pattern(/^[A-Za-z0-9_-]+(?![\s\S])/),
);
export const Selection = Schema.Struct({
  id: Schema.optional(PostId),
  reply_to: Schema.optional(PostId),
});
const queryFields = {
  ...Selection.fields,
  limit: Schema.optionalWith(
    Schema.Number.pipe(Schema.int(), Schema.between(1, 50)),
    {
      default: () => 20,
    },
  ),
};
// Three explicit forms keep mutual exclusion in the generated contract, not
// solely in a runtime refinement the pinned JSON Schema generator omits.
export const SearchInput = Schema.Union(
  Schema.Struct({
    ...queryFields,
    cursor: CursorToken,
    read_cursor: Schema.optional(Schema.Never),
  }),
  Schema.Struct({
    ...queryFields,
    read_cursor: CursorToken,
    cursor: Schema.optional(Schema.Never),
  }),
  Schema.Struct({
    ...queryFields,
    cursor: Schema.optional(Schema.Never),
    read_cursor: Schema.optional(Schema.Never),
  }),
);
export const SearchResult = Schema.Struct({
  posts: Schema.Array(PostRecord),
  page_cursor: Schema.OptionFromNullOr(CursorToken),
  read_cursor: CursorToken,
  has_more: Schema.Boolean,
});

import { Schema } from "effect";
import { PostId, PostRecord } from "../posts/contract.js";
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
export class CursorProblem extends Schema.TaggedError<CursorProblem>()(
  "CursorProblem",
  {
    type: Schema.Literal(
      "https://docs.agentforum.site/problems/cursor-unusable",
    ),
    title: Schema.Literal("Cursor cannot be used"),
    status: Schema.Literal(400),
    detail: Schema.String,
    instance: Schema.String,
  },
) {}

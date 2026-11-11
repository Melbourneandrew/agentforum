import { Schema } from "effect";
export {
  CursorToken,
  Selection,
  SearchInput,
  SearchResult,
} from "@agentforum/contracts";
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

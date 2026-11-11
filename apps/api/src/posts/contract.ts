import { Schema } from "effect";
import { AgentName } from "../identity/contract.js";
import { MetadataObject } from "../input/transport.js";
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

import { contractUrls } from "@agentforum/discovery-assets";
import { PostRecord } from "@agentforum/contracts";
import { JSONSchema } from "effect";
import { inputBudgets } from "./input/json.js";
import { maxEncodedGetUrlBytes, PublicationInput } from "./input/transport.js";

// Pure generated schema metadata, not a second validator or runtime contract.
// Source-sensitive UTF-8/JSON budgets cannot be expressed as character counts.
export const postSchemaVersion = "v1";
export const postRequirements = {
  posting:
    "https://factory.8090.ai/project/3daddf58-9749-4459-93c7-f6f0b5672104/requirements/74ab81ac-113a-4870-898a-683e0d59cc28",
  retrieval:
    "https://factory.8090.ai/project/3daddf58-9749-4459-93c7-f6f0b5672104/requirements/c9bc822d-05f0-4651-8349-97fbd1f49b84",
} as const;
export const makePostSchema = () => ({
  ...JSONSchema.make(PublicationInput, { target: "jsonSchema2020-12" }),
  $id: contractUrls.postSchema,
  title: "Agentspace Post submission — v1",
  description:
    "Required raw Markdown body; optional structured reply_to relation to an existing Parent Post ID; optional open JSON metadata object. Published representation is in $defs.PublishedPost. Posting owns submission, validation, server-established fields, limits and immutable lifecycle; Post Retrieval owns retrieval, filtering, search, ordering and result behavior. The current runtime supports chronological retrieval, not the deferred metadata/text/relevance search capabilities.",
  "x-schema-version": postSchemaVersion,
  "x-openapi": contractUrls.openApi,
  "x-authoritative-requirements": postRequirements,
  "x-server-established": {
    owner: postRequirements.posting,
    fields: [
      "id",
      "author_id",
      "author_name",
      "published_at",
      "publication_order",
    ],
    note: "Only the server establishes these attributes. Body and metadata cannot override them. publication_order is a decimal string, never a JavaScript number. reply_to_id is the stored explicit reply_to relation, null when absent. Published metadata is always an object (empty if omitted at submission).",
  },
  "x-metadata-conventions": {
    optionalExamples: ["type", "title", "tags"],
    coordinationPrecedents: [
      "HOLD",
      "VETO",
      "STOP",
      "ownership",
      "assignment",
      "cancellation",
    ],
    description:
      "All are optional Agent-Defined Conventions, not mandatory fields, defaults, a reserved vocabulary, privileged ownership, or platform-enforced coordination semantics. Arbitrary custom properties, nested objects and arrays of objects are allowed within configured budgets. No precedent signal is required.",
  },
  "x-input-budgets": {
    ...inputBudgets,
    encodedAbsoluteGetUrlBytes: maxEncodedGetUrlBytes,
    measurement:
      "Original decoded client JSON document and original lexical metadata object slice, before normalization or server facts. String/key limits are UTF-8 bytes; metadataDepth counts containers including the root metadata object. Duplicate keys, invalid Unicode/NUL and lossy JSON numeric values are rejected by the source-preserving codec, not solely this structural JSON Schema.",
    owner: postRequirements.posting,
  },
  "x-compatibility":
    "No breaking change within /v1. A breaking Post Schema is introduced under a new API path version, and current/superseding versions are identified by the System Discovery Guide.",
  $defs: {
    PublishedPost: JSONSchema.make(PostRecord, { target: "jsonSchema2020-12" }),
  },
});

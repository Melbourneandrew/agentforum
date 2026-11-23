import { Data, Effect, Encoding, Option, Schema } from "effect";
import { decodeStrictJson } from "./json.js";

import {
  AgentName,
  Nano21,
  PublicationOrder,
  Tags,
  Utf8Text,
} from "./contracts.js";

/** Safe, deliberately input-free errors: never carry payloads or cursor text. */
export class InvalidSearch extends Data.TaggedError("InvalidSearch") {}
export class InvalidCursor extends Data.TaggedError("InvalidCursor") {}
export class InvalidTextQuery extends Data.TaggedError("InvalidTextQuery") {}
export class InvalidOffset extends Data.TaggedError("InvalidOffset") {}
export class FingerprintFailure extends Data.TaggedError(
  "FingerprintFailure",
) {}

export const TextClause = Schema.Struct({
  kind: Schema.Literal("word", "phrase"),
  value: Schema.NonEmptyString,
});
export type TextClause = typeof TextClause.Type;

/**
 * Contract grammar only, NOT an FTS tokenizer. Whitespace separates AND clauses;
 * double quotes delimit phrases; no escapes, operators or wildcard syntax.
 * Quotes must surround a complete clause. Phrase whitespace is normalized.
 * Native unicode61 token validation/quoting belongs to WO-38, before execution.
 * In particular punctuation-only, combining-mark and private-use input cannot
 * be classified as native tokenless here; do not use a JS Unicode approximation.
 */
const parseClauses = (input: string): Option.Option<readonly TextClause[]> => {
  if (
    input.length > 2048 ||
    /[\uD800-\uDFFF]/u.test(input) ||
    new TextEncoder().encode(input).length > 2048
  )
    return Option.none();
  const clauses: TextClause[] = [];
  let index = 0;
  const whitespace = (char: string) => /\s/u.test(char);
  while (index < input.length) {
    while (index < input.length && whitespace(input.charAt(index))) index++;
    if (index === input.length) break;
    const quoted = input.charAt(index) === '"';
    if (quoted) index++;
    const start = index;
    while (
      index < input.length &&
      (quoted ? input.charAt(index) !== '"' : !whitespace(input.charAt(index)))
    ) {
      if (!quoted && input.charAt(index) === '"') return Option.none();
      index++;
    }
    if (quoted && index === input.length) return Option.none();
    const value = input.slice(start, index).trim().replace(/\s+/gu, " ");
    if (value.length === 0) return Option.none();
    clauses.push({ kind: quoted ? "phrase" : "word", value });
    if (clauses.length > 32) return Option.none();
    if (quoted) {
      index++;
      if (index < input.length && !whitespace(input.charAt(index)))
        return Option.none();
    }
  }
  return clauses.length === 0 ? Option.none() : Option.some(clauses);
};
export const parseTextQuery = (input: string) =>
  Option.match(parseClauses(input), {
    onNone: () => Effect.fail(new InvalidTextQuery()),
    onSome: Effect.succeed,
  });
const TextQuery = Utf8Text.pipe(
  Schema.filter((value) => Option.isSome(parseClauses(value)), {
    message: () => "Invalid bounded text query syntax",
    jsonSchema: { "x-maxUtf8Bytes": 2048, "x-maxClauses": 32 },
  }),
);
const Limit = Schema.Number.pipe(Schema.int(), Schema.between(1, 100));
const CursorToken = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(4096),
);
const optional = <A, I, R>(schema: Schema.Schema<A, I, R>) =>
  Schema.optionalWith(schema, { as: "Option", exact: true });
const PostSearch = Schema.Struct({
  resource: Schema.optionalWith(Schema.Literal("posts"), {
    default: () => "posts",
    exact: true,
  }),
  author: optional(Nano21),
  parent: optional(Nano21),
  tags: Schema.optionalWith(Tags, { default: () => [], exact: true }),
  tagMatch: Schema.optionalWith(Schema.Literal("all", "any"), {
    default: () => "all",
    exact: true,
  }),
  q: optional(TextQuery),
  order: Schema.optionalWith(Schema.Literal("newest", "oldest", "relevance"), {
    default: () => "newest",
    exact: true,
  }),
  limit: Schema.optionalWith(Limit, { default: () => 50, exact: true }),
  pageCursor: optional(CursorToken),
  readCursor: optional(CursorToken),
});
const AgentSearch = Schema.Struct({
  resource: Schema.Literal("agents"),
  name: optional(AgentName),
  limit: Schema.optionalWith(Limit, { default: () => 50, exact: true }),
  pageCursor: optional(CursorToken),
});
const PostLookup = Schema.Struct({
  resource: Schema.optionalWith(Schema.Literal("posts"), {
    default: () => "posts",
    exact: true,
  }),
  id: Nano21,
});
/** All variants are strict, including when decoded directly through Schema. */
export const SearchInput = Schema.Union(PostLookup, PostSearch, AgentSearch)
  .pipe(
    Schema.filter(
      (input) => {
        if (input.resource === "agents")
          return !(
            Option.isSome(input.name) && Option.isSome(input.pageCursor)
          );
        if ("id" in input) return true;
        return (
          !(
            Option.isSome(input.pageCursor) && Option.isSome(input.readCursor)
          ) &&
          (input.order !== "relevance" ||
            (Option.isSome(input.q) && Option.isNone(input.readCursor)))
        );
      },
      {
        message: () => "Incompatible search modes",
        jsonSchema: {
          "x-crossFieldConstraints":
            "Lookup, page and read modes are distinct; relevance requires q and forbids readCursor.",
        },
      },
    ),
  )
  .annotations({
    identifier: "SearchInput",
    parseOptions: { onExcessProperty: "error" },
  });
export type SearchInput = typeof SearchInput.Type;

export const PublicationSequence = PublicationOrder;
export const ChronologicalBoundary = Schema.Struct({
  sequence: PublicationSequence,
  id: Nano21,
});
export const ReadZero = Schema.Struct({ sequence: Schema.Literal("0") });
export const SafeOffset = Schema.Number.pipe(
  Schema.int(),
  Schema.between(0, Number.MAX_SAFE_INTEGER),
);
const Fingerprint = Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/));
const common = {
  version: Schema.Literal(1),
  api: Schema.Literal("v1"),
  fingerprint: Fingerprint,
};
export const CursorEnvelope = Schema.Union(
  Schema.Struct({
    ...common,
    resource: Schema.Literal("posts"),
    purpose: Schema.Literal("page"),
    order: Schema.Literal("newest", "oldest"),
    boundary: ChronologicalBoundary,
  }),
  Schema.Struct({
    ...common,
    resource: Schema.Literal("posts"),
    purpose: Schema.Literal("read"),
    order: Schema.Literal("oldest"),
    boundary: Schema.Union(ChronologicalBoundary, ReadZero),
  }),
  Schema.Struct({
    ...common,
    resource: Schema.Literal("posts"),
    purpose: Schema.Literal("page"),
    order: Schema.Literal("relevance"),
    offset: SafeOffset,
  }),
  Schema.Struct({
    ...common,
    resource: Schema.Literal("agents"),
    purpose: Schema.Literal("page"),
    order: Schema.Literal("activity"),
    offset: SafeOffset,
  }),
).annotations({
  identifier: "CursorEnvelope",
  parseOptions: { onExcessProperty: "error" },
});
export type CursorEnvelope = typeof CursorEnvelope.Type;
const strict = { onExcessProperty: "error" } as const;

export const decodeCursor = (
  token: string,
): Effect.Effect<CursorEnvelope, InvalidCursor> => {
  if (
    token.length === 0 ||
    token.length > 4096 ||
    !/^[A-Za-z0-9_-]+$/.test(token)
  )
    return Effect.fail(new InvalidCursor());
  return Effect.gen(function* () {
    const bytes = yield* Encoding.decodeBase64Url(token).pipe(
      Effect.mapError(() => new InvalidCursor()),
      Effect.filterOrFail(
        (bytes) => Encoding.encodeBase64Url(bytes) === token,
        () => new InvalidCursor(),
      ),
    );
    const json = yield* decodeStrictJson(bytes).pipe(
      Effect.mapError(() => new InvalidCursor()),
    );
    return yield* Schema.decodeUnknown(CursorEnvelope)(json, strict).pipe(
      Effect.mapError(() => new InvalidCursor()),
    );
  });
};
export const encodeCursor = (input: CursorEnvelope) =>
  Schema.decodeUnknown(CursorEnvelope)(input, strict).pipe(
    Effect.mapError(() => new InvalidCursor()),
    Effect.map((envelope) =>
      Encoding.encodeBase64Url(JSON.stringify(envelope)),
    ),
    Effect.filterOrFail(
      (token) => token.length <= 4096,
      () => new InvalidCursor(),
    ),
  );
export const checkedOffsetAddition = (
  offset: number,
  returned: number,
): Effect.Effect<number, InvalidOffset> =>
  Number.isSafeInteger(offset) &&
  offset >= 0 &&
  Number.isSafeInteger(returned) &&
  returned >= 0 &&
  returned <= Number.MAX_SAFE_INTEGER - offset
    ? Effect.succeed(offset + returned)
    : Effect.fail(new InvalidOffset());

/** Binary UTF-8 order (including astral characters), not locale or UTF-16 order. */
const binaryCompare = (left: string, right: string) => {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  for (const [index, byte] of leftBytes.entries()) {
    const other = rightBytes[index];
    if (other === undefined) return 1;
    if (byte !== other) return byte - other;
  }
  return leftBytes.length - rightBytes.length;
};
export const normalizedSelection = (input: SearchInput) => {
  if (input.resource === "agents")
    return {
      resource: "agents",
      name: Option.getOrElse(
        Option.map(input.name, (name) => name.toLowerCase()),
        () => "",
      ),
    };
  if ("id" in input) return { resource: "posts", id: input.id };
  const tags = [...new Set(input.tags)].sort(binaryCompare);
  const clauses = Option.flatMap(input.q, parseClauses);
  return {
    resource: "posts",
    author: Option.getOrElse(input.author, () => ""),
    parent: Option.getOrElse(input.parent, () => ""),
    tags,
    tagMatch: tags.length === 0 ? "all" : input.tagMatch,
    clauses: Option.getOrElse(clauses, () => []),
  };
};
/** Fixed property order; normalized nested records have fixed property order too. */
export const canonicalSelection = (input: SearchInput) =>
  JSON.stringify(normalizedSelection(input));
export const selectionFingerprint = (input: SearchInput) =>
  Effect.tryPromise({
    try: async () => {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(canonicalSelection(input)),
      );
      return [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
    },
    catch: () => new FingerprintFailure(),
  });
export const searchFingerprint = selectionFingerprint;

export const decodeSearch = (input: unknown) =>
  Effect.gen(function* () {
    const search = yield* Schema.decodeUnknown(SearchInput)(input, strict).pipe(
      Effect.mapError(() => new InvalidSearch()),
    );
    if ("id" in search) return search;
    const page = search.pageCursor;
    const read =
      search.resource === "posts" ? search.readCursor : Option.none<string>();
    const token = Option.orElse(page, () => read);
    if (Option.isSome(token)) {
      const cursor = yield* decodeCursor(token.value).pipe(
        Effect.mapError(() => new InvalidSearch()),
      );
      const fingerprint = yield* selectionFingerprint(search);
      const purpose = Option.isSome(read) ? "read" : "page";
      const order =
        search.resource === "agents"
          ? "activity"
          : purpose === "read"
            ? "oldest"
            : search.order;
      yield* Effect.succeed(cursor).pipe(
        Effect.filterOrFail(
          (cursor) =>
            cursor.resource === search.resource &&
            cursor.purpose === purpose &&
            cursor.order === order &&
            cursor.fingerprint === fingerprint,
          () => new InvalidSearch(),
        ),
      );
    }
    // A checkpoint always resumes ascending, even with default newest browsing.
    if (search.resource === "posts" && Option.isSome(search.readCursor))
      return { ...search, order: "oldest" as const };
    return search;
  });

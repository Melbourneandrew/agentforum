import { Data, Effect, Option, Schema } from "effect";
import { PublishInput, RegisterInput } from "./contracts.js";
import type { ProblemCode } from "./problems.js";

export class InvalidTransport extends Data.TaggedError("InvalidTransport")<{
  readonly status: 400 | 401 | 413 | 415;
  readonly code: ProblemCode;
}> {}
const check = (
  valid: boolean,
  status: 400 | 401 | 413 | 415,
  code: ProblemCode,
) =>
  Effect.void.pipe(
    Effect.filterOrFail(
      () => valid,
      () => new InvalidTransport({ status, code }),
    ),
  );
const invalid = () =>
  new InvalidTransport({ status: 400, code: "invalid-request" });
export const decodeJson = (bytes: Uint8Array) =>
  Effect.try({
    try: (): unknown =>
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    catch: invalid,
  });
// Read at most the policy cap before JSON parsing. Do not trust Content-Length.
const readBody = (request: Request) =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      Option.map(Option.fromNullable(request.body), (body) => body.getReader()),
    ),
    (optionalReader) =>
      Effect.gen(function* () {
        if (Option.isNone(optionalReader)) return new Uint8Array();
        const reader = optionalReader.value;
        const chunks: Uint8Array[] = [];
        let size = 0;
        const read = Effect.tryPromise({
          try: () => reader.read(),
          catch: invalid,
        });
        let part = yield* read;
        while (!part.done) {
          size += part.value.byteLength;
          yield* check(size <= 65536, 413, "payload-too-large");
          chunks.push(part.value);
          part = yield* read;
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return bytes;
      }),
    (optionalReader) =>
      Option.match(optionalReader, {
        onNone: () => Effect.void,
        onSome: (reader) =>
          Effect.sync(() => {
            // Request cancellation, but do not wait for an uncooperative producer
            // or tee sibling before returning an already-determined rejection.
            const cancellation = reader.cancel();
            reader.releaseLock();
            void cancellation.catch(() => undefined);
          }),
      }),
  );
export const readDocument = (request: Request) =>
  Effect.gen(function* () {
    const url = new URL(request.url);
    if (request.method === "GET") {
      yield* check(
        new TextEncoder().encode(request.url).length <= 14336,
        413,
        "get-url-too-large",
      );
      const text = yield* Effect.try({
        try: () => {
          if (url.hash) throw invalid();
          const entries = url.search
            .slice(1)
            .split("&")
            .map((entry) => {
              const index = entry.indexOf("=");
              if (index < 0) throw invalid();
              return [
                decodeURIComponent(entry.slice(0, index).replaceAll("+", " ")),
                decodeURIComponent(entry.slice(index + 1).replaceAll("+", " ")),
              ];
            });
          const entry = entries[0];
          if (
            entries.length !== 1 ||
            entry?.[0] !== "payload" ||
            entry[1] === undefined
          )
            throw invalid();
          return entry[1];
        },
        catch: invalid,
      });
      return yield* decodeJson(new TextEncoder().encode(text));
    }
    yield* check(
      request.method === "POST" && !url.search && !url.hash,
      400,
      "invalid-request",
    );
    const encoding = request.headers.get("Content-Encoding");
    yield* check(
      (encoding === null || encoding.toLowerCase().trim() === "identity") &&
        /^application\/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?\s*$/i.test(
          request.headers.get("Content-Type") ?? "",
        ),
      415,
      "unsupported-media",
    );
    return yield* decodeJson(yield* readBody(request));
  });
export const readBearer = (request: Request) =>
  Effect.gen(function* () {
    const value = request.headers.get("Authorization");
    const token =
      value === null
        ? null
        : /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/i.exec(value)?.[1];
    return yield* Schema.decodeUnknown(Schema.NonEmptyString)(token).pipe(
      Effect.mapError(
        () => new InvalidTransport({ status: 401, code: "unauthorized" }),
      ),
    );
  });
export const decodeRegister = (input: unknown) =>
  Schema.decodeUnknown(RegisterInput)(input, {
    onExcessProperty: "error",
  }).pipe(
    Effect.mapError(invalid),
    Effect.map((value) => ({ name: Option.fromNullable(value.name) })),
  );
export const decodePublish = (input: unknown) =>
  Effect.gen(function* () {
    // Limits describe the submitted list, never its deduplicated representation.
    if (
      Schema.is(Schema.Record({ key: Schema.String, value: Schema.Unknown }))(
        input,
      ) &&
      Array.isArray(input.tags)
    ) {
      yield* check(input.tags.length <= 32, 400, "tag-count-limit");
      for (const tag of input.tags) {
        if (typeof tag !== "string") continue;
        yield* check(
          new TextEncoder().encode(tag).length <= 256,
          400,
          "tag-byte-limit",
        );
        yield* check(
          [
            ...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(
              tag,
            ),
          ].length <= 64,
          400,
          "tag-grapheme-limit",
        );
      }
    }
    const value = yield* Schema.decodeUnknown(PublishInput)(input, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError(invalid));
    return {
      body: value.body,
      parent: Option.fromNullable(value.reply_to),
      tags: [...new Set(value.tags ?? [])],
    };
  });

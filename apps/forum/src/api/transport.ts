import { Data, Effect, Option, Schema } from "effect";
import { PublishInput, RegisterInput } from "./contracts.js";
import type { ProblemCode } from "./problems.js";

export class InvalidTransport extends Data.TaggedError("InvalidTransport")<{
  readonly status: 400 | 401 | 413 | 415;
  readonly code: ProblemCode;
}> {}
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
          if (size > 65536)
            return yield* Effect.fail(
              new InvalidTransport({ status: 413, code: "payload-too-large" }),
            );
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
          Effect.promise(async () => {
            await reader.cancel().catch(() => undefined);
            reader.releaseLock();
          }),
      }),
  );
export const readDocument = (request: Request) =>
  Effect.gen(function* () {
    const url = new URL(request.url);
    if (request.method === "GET") {
      if (new TextEncoder().encode(request.url).length > 14336)
        return yield* Effect.fail(
          new InvalidTransport({ status: 413, code: "get-url-too-large" }),
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
    if (request.method !== "POST" || url.search || url.hash)
      return yield* Effect.fail(invalid());
    const encoding = request.headers.get("Content-Encoding");
    if (
      (encoding !== null && encoding.toLowerCase().trim() !== "identity") ||
      !/^application\/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?\s*$/i.test(
        request.headers.get("Content-Type") ?? "",
      )
    )
      return yield* Effect.fail(
        new InvalidTransport({ status: 415, code: "unsupported-media" }),
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
    if (!token)
      return yield* Effect.fail(
        new InvalidTransport({ status: 401, code: "unauthorized" }),
      );
    return token;
  });
export const decodeRegister = (input: unknown) =>
  Schema.decodeUnknown(RegisterInput)(input, {
    onExcessProperty: "error",
  }).pipe(Effect.mapError(invalid));
export const decodePublish = (input: unknown) =>
  Schema.decodeUnknown(PublishInput)(input, { onExcessProperty: "error" }).pipe(
    Effect.map((value) => ({ ...value, tags: [...new Set(value.tags ?? [])] })),
    Effect.mapError(invalid),
  );

import { Data, Effect, Option, Schema } from "effect";
import { InputProblem } from "./transport.js";
class ProblemBodyDecodeError extends Data.TaggedError(
  "ProblemBodyDecodeError",
) {}
// Only internal declared error bodies are considered; never reflect their text.
export const readProblemBody = <A, I>(
  response: Response,
  schema: Schema.Schema<A, I>,
) =>
  Effect.tryPromise({
    try: async () => {
      if (
        response.headers.get("Content-Type")?.split(";")[0] !==
          "application/problem+json" ||
        response.body === null
      )
        return Option.none<A>();
      const reader = response.body.getReader();
      try {
        let text = "",
          size = 0;
        const decoder = new TextDecoder("utf-8", { fatal: true });
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 8192) return Option.none<A>();
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
        return Schema.decodeUnknownOption(Schema.parseJson(schema))(text);
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
    },
    catch: () => new ProblemBodyDecodeError(),
  }).pipe(Effect.orElseSucceed(() => Option.none<A>()));
export const recognizeInputProblem = (
  value: InputProblem,
  status: number,
  operation: "register" | "search",
  id: string,
): Option.Option<InputProblem> => {
  if (value.status !== status || value.canonical !== `/v1/${operation}`)
    return Option.none();
  if (value.status === 413 && ![14336, 65536, 16384].includes(value.limit ?? 0))
    return Option.none();
  const limit =
    value.status === 400
      ? operation === "register"
        ? 39
        : 50
      : value.status === 413
        ? value.limit
        : undefined;
  const detail =
    value.status === 400
      ? operation === "register"
        ? "Use valid JSON. Optional Agent Names contain 1 to 39 ASCII letters, digits or single hyphens, starting and ending with a letter or digit."
        : "Use a valid JSON search object, a page size from 1 to 50 and at most one page or read cursor. Malformed cursors cannot be used; start a fresh query."
      : value.status === 401
        ? "Supply a valid Authorization Bearer header."
        : value.status === 405
          ? "Use GET or POST; HEAD and OPTIONS never execute this operation."
          : value.status === 415
            ? "Use application/json with UTF-8 and identity content encoding."
            : limit === 14336
              ? "The encoded GET URL exceeds 14336 UTF-8 bytes. Use canonical POST."
              : limit === 16384
                ? "Metadata exceeds 16384 UTF-8 bytes."
                : "The client JSON document exceeds 65536 UTF-8 bytes.";
  return Option.some(
    new InputProblem({
      type: "https://docs.agentforum.site/problems/input-rejected",
      title: "Input rejected",
      status: value.status,
      detail,
      instance: `urn:uuid:${id}`,
      issues: [{ location: [limit === 16384 ? "metadata" : "request"] }],
      canonical: `/v1/${operation}`,
      ...(limit === undefined ? {} : { limit }),
    }),
  );
};

import { Option, Schema } from "effect";

// Strict supported W3C version 00 only; never log these user-supplied values.
const Traceparent = Schema.String.pipe(
  Schema.maxLength(55),
  Schema.pattern(
    /^00-(?!0{32}-)[0-9a-f]{32}-(?!0{16}-)[0-9a-f]{16}-(?:00|01)$/,
  ),
);
const key =
  /^(?:[a-z][a-z0-9_*/-]{0,255}|[a-z0-9][a-z0-9_*/-]{0,240}@[a-z][a-z0-9_*/-]{0,13})$/;
const Tracestate = Schema.String.pipe(
  Schema.maxLength(512),
  Schema.filter((value) => {
    const members = value.split(",");
    if (members.length > 32) return false;
    const keys = new Set<string>();
    for (const member of members) {
      const normalized = member.replace(/^[ \t]+|[ \t]+$/g, "");
      const separator = normalized.indexOf("=");
      const name = normalized.slice(0, separator);
      const content = normalized.slice(separator + 1);
      if (
        separator < 1 ||
        !key.test(name) ||
        keys.has(name) ||
        content.length < 1 ||
        content.length > 256 ||
        !/^[\x20-\x2b\x2d-\x3c\x3e-\x7e]*[\x21-\x2b\x2d-\x3c\x3e-\x7e]$/.test(
          content,
        )
      )
        return false;
      keys.add(name);
    }
    return true;
  }),
);
export const validatePropagation = (headers: Headers) => {
  const parent = headers.get("traceparent");
  if (parent === null || parent.length > 55) return Option.none();
  return Option.flatMap(
    Schema.decodeUnknownOption(Traceparent)(parent),
    (traceparent) => {
      const state = headers.get("tracestate");
      const tracestate =
        state === null || state.length > 512
          ? Option.none<string>()
          : Schema.decodeUnknownOption(Tracestate)(state);
      return Option.some({ traceparent, tracestate });
    },
  );
};
// No propagation into disabled native traces/export, public responses, or D1 SQL.
// A future authorized supported adapter must consume validated context privately;
// validation does not make trace IDs or vendor state safe diagnostic attributes.

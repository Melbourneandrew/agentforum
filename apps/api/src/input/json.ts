import { Data, Effect, Option } from "effect";

export const inputBudgets = {
  decodedJsonBytes: 65_536,
  metadataJsonBytes: 16_384,
  metadataDepth: 8,
  metadataEntries: 64,
  metadataNodes: 256,
  metadataStringBytes: 4_096,
  metadataKeyBytes: 128,
} as const;
export const utf8Size = (text: string) => new TextEncoder().encode(text).length;
export class InputFailure extends Data.TaggedError("InputFailure")<{
  readonly reason:
    | "invalid"
    | "payload"
    | "metadata"
    | "encoding"
    | "media"
    | "method"
    | "authorization";
}> {}
const wellFormed = (text: string) => {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
};
const invalid = () => new InputFailure({ reason: "invalid" });

// This scanner validates source BEFORE JSON.parse loses duplicate keys, number
// lexemes and metadata byte positions. It never reflects client text in errors.
const scan = (source: string, publication: boolean): unknown => {
  let position = 0;
  let nodes = 0;
  const whitespace = () => {
    while (/[\x20\t\r\n]/.test(source[position] ?? "!")) position++;
  };
  const string = (): string => {
    const start = position++;
    for (;;) {
      const char = source[position++];
      if (char === undefined) throw invalid();
      if (char === '"') break;
      if (char === "\\") {
        const escaped = source[position++];
        if (escaped === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(source.slice(position, position + 4)))
            throw invalid();
          position += 4;
        } else if (escaped === undefined || !'"\\/bfnrt'.includes(escaped))
          throw invalid();
      } else if (char.charCodeAt(0) < 32) throw invalid();
    }
    const value: unknown = JSON.parse(source.slice(start, position));
    if (typeof value !== "string") throw invalid();
    // PostgreSQL text/JSONB cannot represent NUL or isolated UTF-16 surrogates.
    if (value.includes("\0") || !wellFormed(value)) throw invalid();
    return value;
  };
  const numericValue = (lexeme: string): number => {
    const value = Number(lexeme);
    if (!Number.isFinite(value)) throw invalid();
    // Compare decimal values, not spelling (1, 1.0 and 1e0 are equivalent).
    const decimal = (text: string) => {
      const [mantissa = "", exponent = "0"] = text.toLowerCase().split("e");
      const [whole = "", fraction = ""] = mantissa.split(".");
      const negative = whole.startsWith("-");
      let digits = (whole.replace("-", "") + fraction).replace(/^0+/, "");
      if (digits === "") return "0";
      let power = Number(exponent) - fraction.length;
      while (digits.endsWith("0")) {
        digits = digits.slice(0, -1);
        power++;
      }
      return `${negative ? "-" : ""}${digits}e${String(power)}`;
    };
    if (decimal(lexeme) !== decimal(String(value))) throw invalid();
    return value;
  };
  const value = (depth: number, metadataDepth: Option.Option<number>): void => {
    whitespace();
    if (depth > 64) throw invalid();
    if (Option.isSome(metadataDepth) && ++nodes > inputBudgets.metadataNodes)
      throw invalid();
    const char = source[position];
    if (char === "{" || char === "[") {
      const object = char === "{";
      const containerDepth = Option.map(metadataDepth, (d) => d + 1);
      if (
        Option.isSome(containerDepth) &&
        containerDepth.value > inputBudgets.metadataDepth
      )
        throw invalid();
      position++;
      whitespace();
      const end = object ? "}" : "]";
      const keys = new Set<string>();
      let count = 0;
      if (source[position] !== end)
        for (;;) {
          if (
            ++count > inputBudgets.metadataEntries &&
            Option.isSome(metadataDepth)
          )
            throw invalid();
          whitespace();
          let key = Option.none<string>();
          if (object) {
            if (source[position] !== '"') throw invalid();
            const name = string();
            if (keys.has(name)) throw invalid();
            keys.add(name);
            if (
              Option.isSome(metadataDepth) &&
              utf8Size(name) > inputBudgets.metadataKeyBytes
            )
              throw invalid();
            key = Option.some(name);
            whitespace();
            if (source[position++] !== ":") throw invalid();
          }
          whitespace();
          const start = position;
          const isMetadata =
            publication && depth === 0 && Option.contains("metadata")(key);
          if (isMetadata && source[position] !== "{") throw invalid();
          value(depth + 1, isMetadata ? Option.some(0) : containerDepth);
          if (
            isMetadata &&
            utf8Size(source.slice(start, position)) >
              inputBudgets.metadataJsonBytes
          )
            throw new InputFailure({ reason: "metadata" });
          whitespace();
          if (source[position] !== ",") break;
          position++;
        }
      if (source[position++] !== end) throw invalid();
    } else if (char === '"') {
      const text = string();
      if (
        Option.isSome(metadataDepth) &&
        utf8Size(text) > inputBudgets.metadataStringBytes
      )
        throw invalid();
    } else {
      const rest = source.slice(position);
      const literal = /^(?:true|false|null)/.exec(rest);
      const number =
        /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(rest);
      if (literal) position += literal[0].length;
      else if (number) {
        numericValue(number[0]);
        position += number[0].length;
      } else throw invalid();
    }
  };
  whitespace();
  if (source[position] !== "{") throw invalid();
  value(0, Option.none());
  whitespace();
  if (position !== source.length) throw invalid();
  const parsed: unknown = JSON.parse(source);
  return parsed;
};
export const parseInputJson = (source: string, publication: boolean) =>
  Effect.try({
    try: () => {
      if (!wellFormed(source)) throw invalid();
      if (utf8Size(source) > inputBudgets.decodedJsonBytes)
        throw new InputFailure({ reason: "payload" });
      return scan(source, publication);
    },
    catch: (error) => (error instanceof InputFailure ? error : invalid()),
  });

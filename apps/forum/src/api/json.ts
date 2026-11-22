import { Data, Effect } from "effect";
import { visit } from "jsonc-parser";

export class InvalidJson extends Data.TaggedError("InvalidJson") {}
// Validate source before JSON.parse discards duplicate members. Names are the
// decoded names, so "body" and "\\u0062ody" conflict in the same object.
// NUL and valid Unicode remain content; no PostgreSQL/metadata policy survives.
export const decodeStrictJson = (bytes: Uint8Array) =>
  Effect.try({
    try: (): unknown => {
      if (bytes.byteLength > 65536) throw new InvalidJson();
      const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const objects: Set<string>[] = [];
      const validString = (value: string) => !/[\uD800-\uDFFF]/u.test(value);
      visit(
        source,
        {
          onObjectBegin: () => {
            objects.push(new Set());
          },
          onObjectProperty: (property) => {
            const keys = objects.at(-1);
            if (!keys || keys.has(property) || !validString(property))
              throw new InvalidJson();
            keys.add(property);
          },
          onObjectEnd: () => {
            objects.pop();
          },
          onLiteralValue: (value: unknown) => {
            if (typeof value === "string" && !validString(value))
              throw new InvalidJson();
          },
          onError: () => {
            throw new InvalidJson();
          },
        },
        {
          allowTrailingComma: false,
          disallowComments: true,
          allowEmptyContent: false,
        },
      );
      return JSON.parse(source);
    },
    catch: () => new InvalidJson(),
  });

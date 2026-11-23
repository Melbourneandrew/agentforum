import type { JSONSchema } from "effect";
import { isDeepStrictEqual } from "node:util";

// Used only by the Node contract generator. Preserve the first authoritative
// definition; identical collisions are harmless, conflicting ones fail closed.
export const mergeSchemaDefinitions = (
  ...sources: readonly Readonly<Record<string, JSONSchema.JsonSchema7>>[]
): Record<string, JSONSchema.JsonSchema7> => {
  const merged: Record<string, JSONSchema.JsonSchema7> = {};
  for (const source of sources)
    for (const [key, definition] of Object.entries(source)) {
      if (Object.hasOwn(merged, key)) {
        if (!isDeepStrictEqual(merged[key], definition))
          throw new Error(`Conflicting schema definition: ${key}`);
      } else
        Object.defineProperty(merged, key, {
          value: definition,
          enumerable: true,
        });
    }
  return merged;
};

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Data, Effect, Schema } from "effect";
import { LocalDescriptor } from "./local-postgres.js";
export class LocalDatabaseCommandError extends Data.TaggedError(
  "LocalDatabaseCommandError",
) {}
export const localDescriptorPath = resolve(".wrangler/local-postgres.json");
export const readLocalDescriptor = Effect.tryPromise({
  try: () => readFile(localDescriptorPath, "utf8"),
  catch: () => new LocalDatabaseCommandError(),
}).pipe(
  Effect.flatMap(Schema.decodeUnknown(Schema.parseJson(LocalDescriptor))),
  Effect.mapError(() => new LocalDatabaseCommandError()),
);
export const localDescriptorLease = (
  input: Schema.Schema.Type<typeof LocalDescriptor>,
) =>
  Effect.acquireRelease(
    Schema.encode(Schema.parseJson(LocalDescriptor))(input).pipe(
      Effect.flatMap((content) =>
        Effect.tryPromise({
          try: async () => {
            await mkdir(resolve(".wrangler"), { recursive: true });
            // Refuse a second or stale session rather than overwrite somebody else's lease.
            await writeFile(localDescriptorPath, content, {
              mode: 0o600,
              flag: "wx",
            });
            return localDescriptorPath;
          },
          catch: () => new LocalDatabaseCommandError(),
        }),
      ),
      Effect.mapError(() => new LocalDatabaseCommandError()),
    ),
    (path) => Effect.promise(() => rm(path)),
  );

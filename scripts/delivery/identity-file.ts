import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { Effect, Option, Schema } from "effect";
import { Journal, failure } from "./model.js";
import { IdentityStore } from "./provision.js";
import type { DeliveryError } from "./model.js";

const inside = (root: string, path: string) => {
  const name = relative(root, path);
  return (
    name === "" ||
    (!name.startsWith(`..${sep}`) && name !== ".." && !name.startsWith(sep))
  );
};
// Installation-specific state is kept OUTSIDE the checkout. A held exclusive
// local lock prevents duplicate creation in concurrent CLI invocations. Release
// serialization across machines/provider Builds belongs to WO-34, not this lock.
export const withIdentityFile = <A, E, R>(
  input: string,
  repository: string,
  use: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | DeliveryError, Exclude<R, IdentityStore>> =>
  Effect.acquireUseRelease(
    Effect.try({
      try: () => {
        const path = resolve(input);
        const parent = realpathSync(dirname(path));
        if (parent !== dirname(path) || inside(realpathSync(repository), path))
          throw new Error("unsafe identity path");
        const lock = `${path}.lock`;
        const descriptor = openSync(lock, "wx", 0o600);
        return { path, lock, descriptor };
      },
      catch: () => failure("configuration", "identity-path-unsafe-or-locked"),
    }),
    ({ path }) => {
      const store: typeof IdentityStore.Service = {
        read: Effect.try({
          try: () => {
            if (!existsSync(path)) {
              // existsSync follows symlinks: lstat also detects dangling links.
              try {
                lstatSync(path);
              } catch (error) {
                if (
                  error instanceof Error &&
                  "code" in error &&
                  error.code === "ENOENT"
                )
                  return Option.none<string>();
                throw error;
              }
              throw new Error("unsafe identity");
            }
            const stat = lstatSync(path);
            if (
              !stat.isFile() ||
              stat.isSymbolicLink() ||
              (stat.mode & 0o077) !== 0
            )
              throw new Error("unsafe identity");
            return Option.some(readFileSync(path, "utf8"));
          },
          catch: () =>
            failure("configuration", "identity-unreadable-or-invalid"),
        }).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeed(Option.none<Journal>()),
              onSome: (text) =>
                Schema.decodeUnknown(Schema.parseJson(Journal))(text, {
                  onExcessProperty: "error",
                }).pipe(Effect.map(Option.some)),
            }),
          ),
          Effect.mapError(() =>
            failure("configuration", "identity-unreadable-or-invalid"),
          ),
        ),
        write: (journal) =>
          Effect.try({
            try: () => {
              const temp = `${path}.pending`;
              const descriptor = openSync(temp, "wx", 0o600);
              try {
                writeFileSync(
                  descriptor,
                  `${JSON.stringify(journal, null, 2)}\n`,
                );
                fsyncSync(descriptor);
              } finally {
                closeSync(descriptor);
              }
              renameSync(temp, path);
              const parent = openSync(dirname(path), "r");
              try {
                fsyncSync(parent);
              } finally {
                closeSync(parent);
              }
            },
            catch: () =>
              failure("provisioning", "identity-write-failed-retain-journal"),
          }),
      };
      return use.pipe(Effect.provideService(IdentityStore, store));
    },
    ({ lock, descriptor }) =>
      Effect.sync(() => {
        closeSync(descriptor);
        unlinkSync(lock);
      }),
  );

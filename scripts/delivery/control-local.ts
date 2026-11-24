// Dedicated disposable LOCAL adapter. No remote option or credential accessor.
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Effect, Schema } from "effect";
import { failure } from "./model.js";
import type { prepareTarget } from "./release-config.js";
import {
  CONTROL_FILE,
  CONTROL_HISTORY,
  CONTROL_V1_SHA256,
  hashControl,
  type ControlDatabase,
} from "./release-control.js";
import type { NativeControlMigrations } from "./control-bootstrap.js";

type Prepared = Effect.Effect.Success<ReturnType<typeof prepareTarget>>;
export const localControls = async (input: {
  readonly prepared: Prepared;
  readonly root: string;
  readonly state: string;
  // This callback receives only explicit native --local commands below. The
  // local qualifier supplies a fresh HOME/env and bounded subprocess lifetime.
  readonly run: (args: string[]) => Promise<string>;
}): Promise<{
  database: typeof ControlDatabase.Service;
  bootstrap: typeof NativeControlMigrations.Service;
}> => {
  const state = resolve(input.state);
  if ((await realpath(state)) !== state || !(await lstat(state)).isDirectory())
    throw failure("configuration", "unsafe-local-control-state");
  const v1 = await readFile(
    join(input.root, "scripts/delivery/control-migrations", CONTROL_FILE),
    "utf8",
  );
  if ((await Effect.runPromise(hashControl(v1))) !== CONTROL_V1_SHA256)
    throw failure("initialization", "control-v1-bytes-mismatch");
  const directory = join(state, "control-v1");
  await mkdir(directory);
  await writeFile(join(directory, CONTROL_FILE), v1, { flag: "wx" });
  const bootstrapConfig = join(state, "control-bootstrap.json");
  // Purpose-specific, never passed to Worker activation. Complete current target
  // is retained; ONLY DB native directory/history fields change.
  await writeFile(
    bootstrapConfig,
    JSON.stringify({
      ...input.prepared.target,
      d1_databases: input.prepared.target.d1_databases.map((db) => ({
        ...db,
        migrations_dir: directory,
        migrations_table: CONTROL_HISTORY,
      })),
    }),
    { flag: "wx" },
  );
  const config = [
    "--config",
    input.prepared.artifact.configPath,
    "--persist-to",
    join(state, "d1"),
  ];
  return {
    database: {
      identity: input.prepared.artifact.identity,
      query: (sql, params) =>
        Effect.gen(function* () {
          let index = 0;
          const command = sql.replace(/\?/g, () => {
            const value = params[index++];
            if (value === undefined)
              throw failure("configuration", "local-control-parameter-missing");
            return value === null
              ? "NULL"
              : typeof value === "number"
                ? String(value)
                : `'${value.replace(/'/g, "''")}'`;
          });
          if (index !== params.length)
            return yield* Effect.fail(
              failure("configuration", "local-control-parameter-count"),
            );
          const text = yield* Effect.tryPromise({
            try: () =>
              input.run([
                "d1",
                "execute",
                "DB",
                "--local",
                "--json",
                "--command",
                command,
                ...config,
              ]),
            catch: () =>
              failure("initialization", "local-control-query-unknown"),
          });
          const results = yield* Schema.decodeUnknown(
            Schema.parseJson(
              Schema.Array(
                Schema.Struct({
                  results: Schema.Array(
                    Schema.Record({
                      key: Schema.String,
                      value: Schema.Unknown,
                    }),
                  ),
                  success: Schema.Literal(true),
                }),
              ).pipe(Schema.itemsCount(1)),
            ),
          )(text).pipe(
            Effect.mapError(() =>
              failure("initialization", "local-control-response-invalid"),
            ),
          );
          return results[0]?.results ?? [];
        }),
    },
    bootstrap: {
      v1,
      applyV1: Effect.tryPromise({
        try: () =>
          input
            .run([
              "d1",
              "migrations",
              "apply",
              "DB",
              "--local",
              "--config",
              bootstrapConfig,
              "--persist-to",
              join(state, "d1"),
            ])
            .then(() => undefined),
        catch: () =>
          failure("initialization", "local-native-bootstrap-unknown"),
      }),
    },
  };
};

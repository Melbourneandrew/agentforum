// Real pinned native Wrangler on disposable LOCAL D1. No credentials/provider,
// no Worker launch or repeat root qualifier. Proves physical verifier against
// native applied history/FTS/trigger bytes rather than handcrafted row fixtures.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect, Either, Schema } from "effect";
import { expect, it } from "vitest";
import { Artifact } from "./release-model.js";
import { Identity, failure } from "./model.js";
import { schemaDigest } from "./release-config.js";
import { inspectInstalled, physicalStates } from "./remote-state.js";
const identity = Schema.decodeUnknownSync(Identity)({
  version: 1,
  accountId: "a".repeat(32),
  workerName: "local-physical-forum",
  databaseName: "local-physical-db",
  databaseId: "11111111-1111-1111-1111-111111111111",
  defaultOrigin: "https://local-physical-forum.fixture.workers.dev",
});
it("native local D1 physical/history qualifies; same names with physical tampering fail", async () => {
  const state = await mkdtemp(join(tmpdir(), "wo34-physical-native-"));
  const config = join(state, "native.json");
  const names = [
    "0000_runtime.sql",
    "20261119101855_forum.sql",
    "20261119101856_publication_guards.sql",
  ];
  const run = (args: readonly string[]) =>
    new Promise<string>((success, reject) => {
      execFile(
        process.execPath,
        [
          resolve("apps/forum/node_modules/wrangler/bin/wrangler.js"),
          ...args,
          "--config",
          config,
          "--persist-to",
          join(state, "d1"),
          "--env-file",
          "/dev/null",
        ],
        {
          cwd: state,
          env: {
            PATH: process.env.PATH ?? "",
            HOME: state,
            XDG_CONFIG_HOME: state,
            CI: "true",
            CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
            WRANGLER_SEND_METRICS: "false",
            WRANGLER_LOG_PATH: join(state, "wrangler.log"),
          },
          timeout: 30_000,
          maxBuffer: 4 * 1024 * 1024,
          encoding: "utf8",
        },
        (error, stdout) => {
          if (error) reject(new Error("local-native-failed"));
          else success(stdout);
        },
      );
    });
  try {
    await writeFile(
      config,
      JSON.stringify({
        name: identity.workerName,
        compatibility_date: "2026-11-02",
        d1_databases: [
          {
            binding: "DB",
            database_name: identity.databaseName,
            database_id: identity.databaseId,
            migrations_dir: resolve("apps/forum/migrations"),
          },
        ],
      }),
    );
    const sources = await Promise.all(
      names.map(async (name) => ({
        path: `apps/forum/migrations/${name}`,
        bytes: await readFile(`apps/forum/migrations/${name}`),
      })),
    );
    const states = await Effect.runPromise(physicalStates(sources));
    const artifact = Schema.decodeUnknownSync(Artifact)({
      identity,
      sourceRevision: "a".repeat(40),
      configPath: config,
      artifactDigest: "b".repeat(64),
      schemaDigest: states.at(-1)?.physicalDigest ?? schemaDigest([]),
      migrations: [],
      compatibleSchemas: [],
    });
    const database = {
      identity,
      query: (sql: string) =>
        Effect.tryPromise({
          try: () =>
            run(["d1", "execute", "DB", "--local", "--json", "--command", sql]),
          catch: () => failure("initialization", "local-query-failed"),
        }).pipe(
          Effect.flatMap(
            Schema.decodeUnknown(
              Schema.parseJson(
                Schema.Array(
                  Schema.Struct({
                    success: Schema.Literal(true),
                    results: Schema.Array(
                      Schema.Record({
                        key: Schema.String,
                        value: Schema.Unknown,
                      }),
                    ),
                  }),
                ),
              ),
            ),
          ),
          Effect.map((result) => {
            return result[0]?.results ?? [];
          }),
          Effect.mapError(() =>
            failure("initialization", "local-query-response-invalid"),
          ),
        ),
    };
    expect(
      (await Effect.runPromise(inspectInstalled(artifact, states, database)))
        .schemaDigest,
    ).toBe(states[0]?.physicalDigest);
    await run(["d1", "migrations", "apply", "DB", "--local"]);
    expect(
      (await Effect.runPromise(inspectInstalled(artifact, states, database)))
        .schemaDigest,
    ).toBe(artifact.schemaDigest);
    await run([
      "d1",
      "execute",
      "DB",
      "--local",
      "--command",
      "CREATE TABLE foreign_drift(id TEXT);",
    ]);
    const result = await Effect.runPromise(
      Effect.either(inspectInstalled(artifact, states, database)),
    );
    expect(Either.isLeft(result) && result.left.code).toBe(
      "physical-state-unqualified",
    );
  } finally {
    await rm(state, { recursive: true, force: true });
  }
}, 60_000);

import { readFileSync } from "node:fs";
import { Effect, Either, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { Identity, failure } from "./model.js";
import { Artifact } from "./release-model.js";
import {
  BUSINESS_MASTER,
  inspectInstalled,
  physicalStates,
} from "./remote-state.js";
import type { ControlDatabase } from "./release-control.js";
const names = [
  "0000_runtime.sql",
  "20261119101855_forum.sql",
  "20261119101856_publication_guards.sql",
];
const sources = names.map((name) => ({
  path: `apps/forum/migrations/${name}`,
  bytes: readFileSync(`apps/forum/migrations/${name}`),
}));
const identity = Schema.decodeUnknownSync(Identity)({
  version: 1,
  accountId: "a".repeat(32),
  workerName: "remote-forum",
  databaseName: "remote-db",
  databaseId: "11111111-1111-1111-1111-111111111111",
  defaultOrigin: "https://remote-forum.owner.workers.dev",
});
const artifact = Schema.decodeUnknownSync(Artifact)({
  identity,
  sourceRevision: "a".repeat(40),
  configPath: "/not-executed/config",
  artifactDigest: "b".repeat(64),
  schemaDigest: "c".repeat(64),
  migrations: [],
  compatibleSchemas: [],
});
const historyDDL = `CREATE TABLE "d1_migrations"(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)`;
describe("real native physical replay, injected remote state", () => {
  it("qualifies EMPTY and every exact prefix from actual accepted SQL, not just filenames", async () => {
    const states = await Effect.runPromise(physicalStates(sources));
    expect(states).toHaveLength(4);
    expect(states[0]?.master).toEqual([]);
    expect(states[1]?.physicalDigest).toBe(states[0]?.physicalDigest); // runtime SELECT1, but distinct history
    expect(states[3]?.master.some((row) => row.name === "post_fts")).toBe(true);
    expect(states[3]?.physicalDigest).not.toBe(states[2]?.physicalDigest);
    for (const state of states) {
      const database: typeof ControlDatabase.Service = {
        identity,
        query: (sql) =>
          Effect.succeed(
            sql === BUSINESS_MASTER
              ? state.master
              : sql.includes("sqlite_master")
                ? state.history.length
                  ? [
                      {
                        name: "d1_migrations",
                        type: "table",
                        tbl_name: "d1_migrations",
                        sql: historyDDL,
                      },
                    ]
                  : []
                : sql.includes("SELECT id,name")
                  ? state.history.map((name, index) => ({
                      id: index + 1,
                      name,
                    }))
                  : sql === "PRAGMA integrity_check"
                    ? [{ integrity_check: "ok" }]
                    : [],
          ),
      };
      expect(
        await Effect.runPromise(inspectInstalled(artifact, states, database)),
      ).toEqual({
        databaseId: identity.databaseId,
        schemaDigest: state.inventory,
      });
    }
  });
  it("filenames do not attest historical SQL: physical drift with exact names still fails", async () => {
    const states = await Effect.runPromise(physicalStates(sources));
    const database: typeof ControlDatabase.Service = {
      identity,
      query: (sql) =>
        Effect.succeed(
          sql === BUSINESS_MASTER
            ? []
            : sql.includes("sqlite_master")
              ? [
                  {
                    name: "d1_migrations",
                    type: "table",
                    tbl_name: "d1_migrations",
                    sql: historyDDL,
                  },
                ]
              : names.map((name, index) => ({ id: index + 1, name })),
        ),
    };
    const result = await Effect.runPromise(
      Effect.either(inspectInstalled(artifact, states, database)),
    );
    expect(Either.isLeft(result) && result.left.code).toBe(
      "physical-state-unqualified",
    );
  });
  it("cannot replay rewritten frozen/unsafe SQL", async () => {
    const result = await Effect.runPromise(
      Effect.either(
        physicalStates([
          {
            path: sources[0]?.path ?? "",
            bytes: Buffer.from("DROP TABLE agents;"),
          },
        ]),
      ),
    );
    expect(Either.isLeft(result) && result.left.code).toBe(
      "physical-replay-unverified",
    );
  });
  it("unreadable installed schema stops instead of guessing empty", async () => {
    const result = await Effect.runPromise(
      Effect.either(
        inspectInstalled(artifact, [], {
          identity,
          query: () => Effect.fail(failure("deployment", "lost")),
        }),
      ),
    );
    expect(Either.isLeft(result) && result.left.code).toBe(
      "business-schema-unreadable",
    );
  });
});

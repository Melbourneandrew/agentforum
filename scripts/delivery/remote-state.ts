// Physical-state proof, not historical SQL-byte attestation. Source inventory
// digests label qualified states only AFTER exact native history + physical match.
import { createHash } from "node:crypto";
import initSqlite from "@sqlite.org/sqlite-wasm";
import { Effect, Schema } from "effect";
import {
  checkSqliteMigrationSources,
  type SqliteMigrationSource,
} from "../sqlite-migrations.js";
import { failure } from "./model.js";
import { schemaDigest } from "./release-config.js";
import {
  CONTROL_HISTORY,
  CONTROL_TABLE,
  type ControlDatabase,
} from "./release-control.js";
import type { Artifact } from "./release-model.js";

const Master = Schema.Array(
  Schema.Struct({
    name: Schema.String,
    type: Schema.String,
    tbl_name: Schema.String,
    sql: Schema.NullOr(Schema.String),
  }),
);
export const BUSINESS_MASTER = `SELECT name,type,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND tbl_name NOT IN ('${CONTROL_TABLE}','${CONTROL_HISTORY}','d1_migrations','_cf_KV') ORDER BY name`;
const normalize = (sql: string) =>
  sql
    .replace(/\bIF NOT EXISTS\s+/g, "")
    .trim()
    .replace(/;$/, "")
    .replace(
      /('(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\])|(\s+)/g,
      (match, quoted: string | undefined) => quoted ?? (match ? " " : ""),
    );
const canonical = (rows: typeof Master.Type) =>
  JSON.stringify(
    rows.map((row) => ({
      ...row,
      sql: row.sql === null ? null : normalize(row.sql),
    })),
  );
export interface PhysicalState {
  readonly inventory: string;
  readonly history: readonly string[];
  readonly master: typeof Master.Type;
  readonly physicalDigest: string;
}
export const physicalStates = (sources: readonly SqliteMigrationSource[]) =>
  Effect.tryPromise({
    try: async () => {
      // Same pinned native parser/authorizer and Wrangler chunk replay as CI.
      await checkSqliteMigrationSources(sources);
      const sqlite = await initSqlite();
      const db = new sqlite.oo1.DB(":memory:");
      const history: { name: string; digest: string }[] = [];
      const states: PhysicalState[] = [];
      const capture = () => {
        const master = Schema.decodeUnknownSync(Master)(
          db.exec({
            sql: BUSINESS_MASTER,
            rowMode: "object",
            returnValue: "resultRows",
          }),
        );
        states.push({
          inventory: schemaDigest(history),
          history: history.map((entry) => entry.name),
          master,
          physicalDigest: createHash("sha256")
            .update(canonical(master))
            .digest("hex"),
        });
      };
      try {
        db.exec("PRAGMA foreign_keys=ON");
        capture();
        for (const source of sources) {
          db.exec(Buffer.from(source.bytes).toString("utf8"));
          history.push({
            name: source.path.slice("apps/forum/migrations/".length),
            digest: createHash("sha256").update(source.bytes).digest("hex"),
          });
          capture();
        }
        return states;
      } finally {
        db.close();
      }
    },
    catch: () => failure("build", "physical-replay-unverified"),
  });

// The native history DDL is independent of business SQL. A malformed or foreign
// history is never silently treated as empty. Only the empty first install may
// have no history table; prefixes still require an exact physical-state match.
const historySQL = `CREATE TABLE "d1_migrations"(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)`;
export const inspectInstalled = (
  artifact: Artifact,
  states: readonly PhysicalState[],
  database: typeof ControlDatabase.Service,
) =>
  Effect.gen(function* () {
    const master = yield* database.query(BUSINESS_MASTER, []).pipe(
      Effect.flatMap(Schema.decodeUnknown(Master)),
      Effect.mapError(() =>
        failure("initialization", "business-schema-unreadable"),
      ),
    );
    const table = yield* database
      .query(
        "SELECT name,type,tbl_name,sql FROM sqlite_master WHERE tbl_name='d1_migrations' ORDER BY name",
        [],
      )
      .pipe(
        Effect.flatMap(Schema.decodeUnknown(Master)),
        Effect.mapError(() =>
          failure("initialization", "business-history-unreadable"),
        ),
      );
    let history: readonly string[] = [];
    if (table.length) {
      const ddl = table.find((row) => row.name === "d1_migrations");
      if (
        !ddl?.sql ||
        normalize(ddl.sql) !== normalize(historySQL) ||
        table.some(
          (row) =>
            row.type !== "table" &&
            !(
              row.name === "sqlite_autoindex_d1_migrations_1" &&
              row.sql === null &&
              row.type === "index"
            ),
        )
      )
        return yield* Effect.fail(
          failure("initialization", "business-history-schema-mismatch"),
        );
      const applied = yield* database
        .query("SELECT id,name FROM d1_migrations ORDER BY id", [])
        .pipe(
          Effect.flatMap(
            Schema.decodeUnknown(
              Schema.Array(
                Schema.Struct({
                  id: Schema.Number.pipe(Schema.int(), Schema.positive()),
                  name: Schema.String,
                }),
              ),
            ),
          ),
          Effect.mapError(() =>
            failure("initialization", "business-history-invalid"),
          ),
        );
      if (applied.some((row, index) => row.id !== index + 1))
        return yield* Effect.fail(
          failure("initialization", "business-history-sequence-mismatch"),
        );
      history = applied.map((row) => row.name);
    }
    const state = states.find(
      (value) =>
        JSON.stringify(value.history) === JSON.stringify(history) &&
        canonical(value.master) === canonical(master),
    );
    if (!state || (!table.length && history.length))
      return yield* Effect.fail(
        failure("initialization", "physical-state-unqualified"),
      );
    if ((yield* database.query("PRAGMA foreign_key_check", [])).length)
      return yield* Effect.fail(
        failure("initialization", "business-foreign-keys-invalid"),
      );
    const integrity = yield* database.query("PRAGMA integrity_check", []).pipe(
      Effect.flatMap(
        Schema.decodeUnknown(
          Schema.Array(
            Schema.Struct({ integrity_check: Schema.Literal("ok") }),
          ).pipe(Schema.itemsCount(1)),
        ),
      ),
      Effect.mapError(() =>
        failure("initialization", "business-integrity-unverified"),
      ),
    );
    if (!integrity.length)
      return yield* Effect.fail(
        failure("initialization", "business-integrity-unverified"),
      );
    return {
      databaseId: artifact.identity.databaseId,
      schemaDigest: state.inventory,
    };
  });

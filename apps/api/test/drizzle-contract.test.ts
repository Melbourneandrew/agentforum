import { describe, expect, expectTypeOf, it } from "vitest";
import { Client } from "pg";
import { SQL, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase as CommonJsDatabase } from "drizzle-orm/node-postgres" with {
  "resolution-mode": "require",
};
import { integer, pgTable, text } from "drizzle-orm/pg-core";
import { pgRole } from "drizzle-orm/pg-core/roles";
import { pgPolicy } from "drizzle-orm/pg-core/policies";
import { gelRole } from "drizzle-orm/gel-core/roles";
import { gelPolicy } from "drizzle-orm/gel-core/policies";
import { PgRelationalQuery } from "drizzle-orm/pg-core/query-builders/query";
import { GelRelationalQuery } from "drizzle-orm/gel-core/query-builders/query";
import { SQLiteRelationalQuery } from "drizzle-orm/sqlite-core/query-builders/query";
import { MySqlDeleteBase } from "drizzle-orm/mysql-core/query-builders/delete";
import { SingleStoreDeleteBase } from "drizzle-orm/singlestore-core/query-builders/delete";
import { MySqlSelectQueryBuilderBase } from "drizzle-orm/mysql-core/query-builders/select";
import { SingleStoreSelectQueryBuilderBase } from "drizzle-orm/singlestore-core/query-builders/select";
import { SQLiteSelectQueryBuilderBase } from "drizzle-orm/sqlite-core/query-builders/select";
import {
  singlestoreEnum,
  text as singlestoreText,
} from "drizzle-orm/singlestore-core";
import type { MySqlSetOperatorExcludedMethods } from "drizzle-orm/mysql-core/query-builders/select.types";
import type { SingleStoreSetOperatorExcludedMethods } from "drizzle-orm/singlestore-core/query-builders/select.types";
import type { SQLiteSetOperatorExcludedMethods } from "drizzle-orm/sqlite-core/query-builders/select.types";

describe("pinned Drizzle declaration/runtime contract in workerd", () => {
  it("builds parameterized PostgreSQL queries without starting I/O", async () => {
    const client = new Client({
      connectionString: "postgresql://fixture@127.0.0.1:1/not_a_database",
      pipeline: false,
    });
    try {
      const fixture = pgTable("adapter_contract_fixture", {
        id: integer().primaryKey(),
        value: text().notNull(),
      });
      const db = drizzle({ client, schema: { fixture } });
      const hostile = "'); DROP TABLE adapter_contract_fixture; --";
      const insertion = db
        .insert(fixture)
        .values({ id: 7, value: hostile })
        .toSQL();
      expect(insertion.sql).not.toContain(hostile);
      expect(insertion.params).toEqual([7, hostile]);
      const selection = db.query.fixture.findMany({ where: eq(fixture.id, 7) });
      expect(selection.getSQL()).toBeInstanceOf(SQL);
      expect(selection.toSQL().params).toEqual([7]);
      expectTypeOf<CommonJsDatabase["select"]>().toBeFunction();
    } finally {
      await client.end();
    }
  });

  it("restores only getSQL methods actually present on shipped prototypes", () => {
    for (const prototype of [
      PgRelationalQuery.prototype,
      GelRelationalQuery.prototype,
      SQLiteRelationalQuery.prototype,
      MySqlDeleteBase.prototype,
      SingleStoreDeleteBase.prototype,
      MySqlSelectQueryBuilderBase.prototype,
      SingleStoreSelectQueryBuilderBase.prototype,
      SQLiteSelectQueryBuilderBase.prototype,
    ]) {
      expect(typeof prototype.getSQL).toBe("function");
    }
  });

  it("describes the actual optional role and policy constructor properties", () => {
    for (const role of [
      pgRole("adapter_fixture", {
        createDb: false,
        createRole: undefined,
        inherit: true,
      }),
      gelRole("adapter_fixture", {
        createDb: false,
        createRole: undefined,
        inherit: true,
      }),
    ]) {
      expect(role.createDb).toBe(false);
      expect(role.createRole).toBeUndefined();
      expect(role.inherit).toBe(true);
      expect(Object.hasOwn(role, "createRole")).toBe(true);
    }
    for (const policy of [
      pgPolicy("fixture", { as: undefined, for: "select" }),
      gelPolicy("fixture", { as: undefined, for: "select" }),
    ]) {
      expect(policy.as).toBeUndefined();
      expect(Object.hasOwn(policy, "as")).toBe(true);
      expect(policy.for).toBe("select");
    }
  });

  it("keeps public set-operation exclusions and does not invent private keys", () => {
    expectTypeOf<"where">().toExtend<MySqlSetOperatorExcludedMethods>();
    expectTypeOf<"session">().not.toExtend<MySqlSetOperatorExcludedMethods>();
    expectTypeOf<"where">().toExtend<SingleStoreSetOperatorExcludedMethods>();
    expectTypeOf<"session">().not.toExtend<SingleStoreSetOperatorExcludedMethods>();
    expectTypeOf<"where">().toExtend<SQLiteSetOperatorExcludedMethods>();
    expectTypeOf<"config">().not.toExtend<SQLiteSetOperatorExcludedMethods>();
  });

  it("matches the real generated-column method and never pretends enum generation works", () => {
    expect(singlestoreText("fixture").generatedAlwaysAs(sql`1`)).toBeDefined();
    expect(() =>
      singlestoreEnum("fixture", ["one", "two"]).generatedAlwaysAs(sql`1`),
    ).toThrow("Method not implemented.");
  });
});

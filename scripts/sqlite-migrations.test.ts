import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkSqliteMigrationConfiguration,
  checkSqliteMigrationHistory,
  checkSqliteMigrationSources,
  checkSqliteMigrations,
  readGitSqliteMigrationSnapshot,
  readSqliteMigrationSnapshot,
  SqliteMigrationError,
  type SqliteMigrationSnapshot,
  type SqliteMigrationSource,
} from "./sqlite-migrations.js";

const root = resolve(import.meta.dirname, "..");
const directory = "apps/forum/migrations";
const journalPath = `${directory}/meta/_journal.json`;
const runtimePath = `${directory}/0000_runtime.sql`;
const generatedPath = `${directory}/20261119101855_forum.sql`;
const guardsPath = `${directory}/20261119101856_publication_guards.sql`;
// These exact final bytes are committed on the working branch. The policy pins
// them independently; reading fixtures cannot authorize a changed migration.
const reviewedGuards = await readFile(join(root, guardsPath));
const runtimeBytes = await readFile(join(root, runtimePath));
const generatedBytes = await readFile(join(root, generatedPath));
const source = (
  sql: string,
  timestamp = "20270101000000",
): SqliteMigrationSource => ({
  path: `${directory}/${timestamp}_extra.sql`,
  bytes: Buffer.from(sql),
});
const approvedSources: readonly SqliteMigrationSource[] = [
  { path: runtimePath, bytes: runtimeBytes },
  { path: generatedPath, bytes: generatedBytes },
  { path: guardsPath, bytes: reviewedGuards },
];
const rejectsSql = async (sql: string) => {
  await expect(
    checkSqliteMigrationSources([source(sql)]),
  ).rejects.toBeInstanceOf(SqliteMigrationError);
};

const temporary: string[] = [];
const temp = async () => {
  const path = await mkdtemp(join(tmpdir(), "agentforum-sqlite-safety-"));
  temporary.push(path);
  return path;
};
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
const jsonBytes = (value: unknown) =>
  Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const id = (index: number) =>
  `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`;
const fixtureSnapshot = (
  tags: readonly string[] = [],
): SqliteMigrationSnapshot => {
  const files = new Map<string, Uint8Array>([[runtimePath, runtimeBytes]]);
  if (tags.length > 0) {
    const entries = tags.map((tag, index) => {
      files.set(
        `${directory}/${tag}.sql`,
        Buffer.from(`CREATE TABLE table_${String(index)}(value TEXT);\n`),
      );
      files.set(
        `${directory}/meta/${tag.slice(0, 14)}_snapshot.json`,
        jsonBytes({
          version: "6",
          dialect: "sqlite",
          id: id(index + 1),
          prevId: id(index),
          tables: {},
        }),
      );
      return {
        idx: index,
        version: "6",
        when: index + 1,
        tag,
        breakpoints: true,
      };
    });
    files.set(
      journalPath,
      jsonBytes({ version: "7", dialect: "sqlite", entries }),
    );
  }
  return { files };
};
const tags = [
  "20270101000000_first",
  "20270102000000_second",
  "20270103000000_third",
];
const copied = (snapshot: SqliteMigrationSnapshot) =>
  new Map(
    [...snapshot.files].map(([path, bytes]) => [path, Buffer.from(bytes)]),
  );
const writeSnapshot = async (
  path: string,
  snapshot: SqliteMigrationSnapshot,
) => {
  for (const [relative, bytes] of snapshot.files) {
    const target = join(path, relative);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
};
const git = (path: string, args: readonly string[]) =>
  execFileSync("git", [...args], {
    cwd: path,
    encoding: "utf8",
    timeout: 10_000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const commitFixture = async (snapshot: SqliteMigrationSnapshot) => {
  const path = await temp();
  await writeSnapshot(path, snapshot);
  await writeFile(
    join(path, "wrangler.jsonc"),
    JSON.stringify({
      d1_databases: [{ binding: "DB", migrations_dir: directory }],
    }),
  );
  git(path, ["init", "--quiet"]);
  git(path, ["add", "."]);
  git(path, [
    "-c",
    "user.name=Migration Safety Test",
    "-c",
    "user.email=migration-safety@example.invalid",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "--quiet",
    "-m",
    "test: establish trusted migration base",
  ]);
  return { path, base: git(path, ["rev-parse", "HEAD"]) };
};

describe("native SQLite boundaries and pinned Wrangler batches", () => {
  it("actually parses/replays the reviewed schema, FTS5, CASE/END triggers and rebuild", async () => {
    expect(createHash("sha256").update(reviewedGuards).digest("hex")).toBe(
      "1bfe8b74d7137dc33cd7eb5185cbe1a4cf8c2457d1da02e44a8322059cafcf77",
    );
    expect(createHash("sha256").update(generatedBytes).digest("hex")).toBe(
      "25feb6495bf7b57fb2b6f79caec2423f97ff73352b2866d35751d43db45e1ce7",
    );
    const result = await checkSqliteMigrationSources(approvedSources);
    expect(result.migrations).toBe(3);
    expect(result.statements).toBeGreaterThan(20);
  });

  it("allows only new tables and indexes on tables created in the same file", async () => {
    await expect(
      checkSqliteMigrationSources([
        source(
          "CREATE TABLE t(id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT CHECK(length(value)>0)); CREATE UNIQUE INDEX ix ON t(value); CREATE TABLE child(parent INTEGER REFERENCES t(id));",
        ),
      ]),
    ).resolves.toEqual({ migrations: 1, statements: 3 });
  });

  it.each([
    "CREATE TABLE \"semi;colon\"(x TEXT DEFAULT 'it''s;quoted'); CREATE INDEX ix ON \"semi;colon\"(x);",
    "/* ; DROP TABLE t; */ CREATE TABLE [a;b]([x;y] TEXT DEFAULT '/*;*/'); -- ; DELETE FROM t;\n CREATE INDEX [i;x] ON [a;b]([x;y]);",
    "CREATE TABLE `a;b`(x TEXT DEFAULT '--> statement-breakpoint; literal');\r\nCREATE INDEX ix ON `a;b`(x); -- tail;\r\n",
    "CREATE TABLE t(x TEXT DEFAULT '😀;é'); CREATE INDEX ix ON t(x); /* tail ; */",
    "CREATE TABLE t(x TEXT DEFAULT 'a\\;b'); CREATE INDEX ix ON t(x); -- tail without newline",
  ])("respects real boundaries in quotes/comments/UTF-8: %s", async (sql) => {
    await expect(
      checkSqliteMigrationSources([source(sql)]),
    ).resolves.toMatchObject({ statements: 2 });
  });

  it("detects the pinned runner's transaction trimming even inside a string", async () => {
    await rejectsSql(
      "CREATE TABLE t(x TEXT DEFAULT 'BEGIN TRANSACTION; COMMIT;');",
    );
  });

  it.each([
    "CREATE TABLE safe(x); DROP TABLE safe;",
    "CREATE TABLE safe(x); -- comment\nDELETE FROM safe;",
    "CREATE TABLE safe(x); /* comment */ UPDATE safe SET x=1;",
    "CREATE TABLE safe(x); INSERT INTO safe VALUES ('secret-marker');",
    "CREATE TABLE safe(x); this is not SQL;",
    "CREATE TABLE safe(x); /* ; */ SELECT 1;",
  ])("does not silently ignore trailing SQL: %s", rejectsSql);

  it.each([
    "CREATE TABLE t(x TEXT DEFAULT 'unterminated);",
    "CREATE TABLE t(x); CREATE TRIGGER bad AFTER INSERT ON t BEGIN SELECT 1;",
    "CREATE TABLE t(x TEXT DEFAULT ?);",
    "CREATE TABLE t(x)",
    "-- only a comment",
    "; ; /* no executable statements */",
  ])(
    "rejects malformed, bound, empty or non-runner-compatible input: %s",
    rejectsSql,
  );

  it("rejects embedded NUL and invalid UTF-8 instead of truncating or replacing", async () => {
    for (const bytes of [
      Buffer.from("CREATE TABLE t(x);\0 DROP TABLE t;"),
      Buffer.from([0xc3, 0x28]),
      Buffer.alloc(1024 * 1024 + 1, 32),
    ]) {
      await expect(
        checkSqliteMigrationSources([{ ...source(""), bytes }]),
      ).rejects.toBeInstanceOf(SqliteMigrationError);
    }
  });

  it("bounds migration count before native allocation", async () => {
    await expect(
      checkSqliteMigrationSources(
        Array.from({ length: 1001 }, (_, index) =>
          source("CREATE TABLE t(x);", String(index).padStart(14, "0")),
        ),
      ),
    ).rejects.toBeInstanceOf(SqliteMigrationError);
  });

  it("bounds statement count using actual native statement boundaries", async () => {
    const sql = Array.from(
      { length: 2001 },
      (_, index) => `CREATE TABLE t_${String(index)}(x);`,
    ).join("\n");
    await expect(
      checkSqliteMigrationSources([source(sql)]),
    ).rejects.toMatchObject({ stage: "policy" });
  });

  it("rejects duplicate paths rather than replaying a migration twice", async () => {
    await expect(
      checkSqliteMigrationSources([
        source("CREATE TABLE t(x);"),
        source("CREATE TABLE other(x);"),
      ]),
    ).rejects.toBeInstanceOf(SqliteMigrationError);
  });
});

describe("fail-closed semantic authorization", () => {
  it.each([
    "CREATE TABLE t(x); INSERT OR REPLACE INTO t VALUES (1);",
    "CREATE TABLE t(x); REPLACE INTO t VALUES (1);",
    "CREATE TABLE t(x); WITH values_to_delete AS (SELECT 1) DELETE FROM t;",
    "CREATE TABLE t(x); ALTER TABLE t ADD COLUMN y TEXT;",
    "CREATE TABLE t(x); ALTER TABLE t RENAME TO renamed;",
    "CREATE TABLE t(x); DROP TABLE t;",
    "CREATE TABLE t(x); CREATE INDEX ix ON t(x); DROP INDEX ix;",
    "CREATE TABLE t AS SELECT 1 AS x;",
    "CREATE TEMP TABLE t(x);",
    "CREATE VIEW v AS SELECT 1;",
    "CREATE TABLE t(x); CREATE TRIGGER tr AFTER INSERT ON t BEGIN DELETE FROM t; END;",
    "CREATE VIRTUAL TABLE t USING fts5(body);",
    "CREATE TABLE t(x); BEGIN; COMMIT;",
    "CREATE TABLE t(x); BEGIN TRANSACTION; COMMIT;",
    "SAVEPOINT x; RELEASE x;",
    "PRAGMA foreign_keys=OFF;",
    "PRAGMA writable_schema=ON;",
    "PRAGMA unknown_safety_setting=1;",
    "PRAGMA integrity_check;",
    "ATTACH DATABASE ':memory:' AS attached;",
    "DETACH DATABASE main;",
    "VACUUM INTO ':memory:';",
    "ANALYZE;",
    "SELECT load_extension('do-not-load');",
    "EXPLAIN CREATE TABLE t(x);",
    "CREATE TABLE t(x); INSERT INTO sqlite_master VALUES ('table','bad','bad',0,'bad');",
    "CREATE TABLE d1_migrations(x);",
    "CREATE TABLE t(x DEFAULT (randomblob(100)));",
  ])("rejects disallowed operations using SQLite semantics: %s", rejectsSql);

  it("rejects indexes against existing tables, including another schema's initial tables", async () => {
    await expect(
      checkSqliteMigrationSources([
        source("CREATE TABLE existing(x);"),
        source("CREATE INDEX ix ON existing(x);", "20270102000000"),
      ]),
    ).rejects.toBeInstanceOf(SqliteMigrationError);
    await expect(
      checkSqliteMigrationSources([
        ...approvedSources,
        source("CREATE INDEX steal ON agents(name);"),
      ]),
    ).rejects.toBeInstanceOf(SqliteMigrationError);
  });

  it("rejects no-op IF NOT EXISTS masking an existing table", async () => {
    await expect(
      checkSqliteMigrationSources([
        source("CREATE TABLE existing(x);"),
        source("CREATE TABLE IF NOT EXISTS existing(y);", "20270102000000"),
      ]),
    ).rejects.toBeInstanceOf(SqliteMigrationError);
  });

  it("uses SQLite's ASCII-insensitive identifier identity for quoted names", async () => {
    await expect(
      checkSqliteMigrationSources([
        source('CREATE TABLE "MiXeD"(x); CREATE INDEX ix ON mixed(x);'),
      ]),
    ).resolves.toEqual({ migrations: 1, statements: 2 });
    await expect(
      checkSqliteMigrationSources([
        source("CREATE TABLE existing(x);"),
        source('CREATE TABLE IF NOT EXISTS "EXISTING"(y);', "20270102000000"),
      ]),
    ).rejects.toBeInstanceOf(SqliteMigrationError);
  });

  it("limits fresh-table authority to a single file", async () => {
    await expect(
      checkSqliteMigrationSources([
        source("CREATE TABLE one(x); CREATE INDEX one_ix ON one(x);"),
        source(
          "CREATE TABLE two(x); CREATE INDEX two_ix ON two(x);",
          "20270102000000",
        ),
      ]),
    ).resolves.toEqual({ migrations: 2, statements: 4 });
  });

  it("does not expose raw SQL or dependency errors", async () => {
    try {
      await checkSqliteMigrationSources([
        source(
          "CREATE TABLE t(x); INSERT INTO t VALUES ('credential-sensitive-marker');",
        ),
      ]);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SqliteMigrationError);
      expect(error instanceof Error ? error.message : "").not.toContain(
        "credential-sensitive-marker",
      );
    }
  });
});

describe("exact reviewed-file exceptions", () => {
  it.each([
    "  SELECT CASE WHEN typeof(NEW.ordinal) != 'integer' THEN RAISE(ABORT,'forum_immutable_tag') END;\n",
    "  SELECT CASE WHEN typeof(NEW.tag_count) != 'integer' OR NEW.tag_count NOT BETWEEN 0 AND 32 THEN RAISE(ABORT,'forum_invalid_tag_count') END;\n",
  ])("rejects removal of either reviewed integer guard: %s", async (line) => {
    const changed = reviewedGuards.toString("utf8").replace(line, "");
    expect(changed).not.toBe(reviewedGuards.toString("utf8"));
    await expect(
      checkSqliteMigrationSources([
        ...approvedSources.slice(0, 2),
        { path: guardsPath, bytes: Buffer.from(changed) },
      ]),
    ).rejects.toMatchObject({ stage: "policy" });
  });

  it("rejects removal of the reviewed tag cardinality seal", async () => {
    const line =
      "  SELECT CASE WHEN NEW.ordinal >= (SELECT tag_count FROM posts WHERE id=NEW.post_id) THEN RAISE(ABORT,'forum_immutable_tag') END;\n";
    const guardsWithoutSeal = reviewedGuards.toString("utf8").replace(line, "");
    expect(guardsWithoutSeal).not.toBe(reviewedGuards.toString("utf8"));
    await expect(
      checkSqliteMigrationSources([
        ...approvedSources.slice(0, 2),
        { path: guardsPath, bytes: Buffer.from(guardsWithoutSeal) },
      ]),
    ).rejects.toMatchObject({ stage: "policy" });
  });

  it("does not grant the final guard exception to a superseded path", async () => {
    await expect(
      checkSqliteMigrationSources([
        ...approvedSources.slice(0, 2),
        {
          path: `${directory}/20261119100604_publication_guards.sql`,
          bytes: reviewedGuards,
        },
      ]),
    ).rejects.toBeInstanceOf(SqliteMigrationError);
  });

  it("accepts the historic SELECT 1 only at its exact path/hash", async () => {
    await expect(
      checkSqliteMigrationSources([approvedSources[0] ?? source("")]),
    ).resolves.toEqual({ migrations: 1, statements: 1 });
    await expect(
      checkSqliteMigrationSources([
        {
          path: runtimePath,
          bytes: Buffer.concat([runtimeBytes, Buffer.from("\n")]),
        },
      ]),
    ).rejects.toBeInstanceOf(SqliteMigrationError);
    await expect(
      checkSqliteMigrationSources([source(runtimeBytes.toString("utf8"))]),
    ).rejects.toBeInstanceOf(SqliteMigrationError);
  });

  it("does not fall back to generic DDL when a reviewed file's hash changes", async () => {
    await expect(
      checkSqliteMigrationSources([
        {
          path: generatedPath,
          bytes: Buffer.from("CREATE TABLE harmless(x);"),
        },
      ]),
    ).rejects.toBeInstanceOf(SqliteMigrationError);
    await expect(
      checkSqliteMigrationSources([
        ...approvedSources.slice(0, 2),
        {
          path: guardsPath,
          bytes: Buffer.concat([
            reviewedGuards,
            Buffer.from("\nDROP TABLE agents;\n"),
          ]),
        },
      ]),
    ).rejects.toBeInstanceOf(SqliteMigrationError);
  });

  it("rejects changed bytes, copied triggers and annotations claiming an exemption", async () => {
    await expect(
      checkSqliteMigrationSources([
        ...approvedSources.slice(0, 2),
        {
          path: guardsPath,
          bytes: Buffer.from(
            reviewedGuards
              .toString("utf8")
              .replace("BEFORE DELETE ON posts", "AFTER DELETE ON posts"),
          ),
        },
      ]),
    ).rejects.toBeInstanceOf(SqliteMigrationError);
    await expect(
      checkSqliteMigrationSources([
        ...approvedSources.slice(0, 2),
        source(reviewedGuards.toString("utf8")),
      ]),
    ).rejects.toBeInstanceOf(SqliteMigrationError);
    await rejectsSql(
      "-- approved bootstrap exception\nCREATE TABLE t(x); CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1; END;",
    );
  });
});

describe("strict append-only SQL/journal/snapshot history", () => {
  it("accepts pre-Drizzle runtime and true append-only histories", () => {
    expect(() => {
      checkSqliteMigrationHistory(fixtureSnapshot(), fixtureSnapshot(tags));
    }).not.toThrow();
    expect(() => {
      checkSqliteMigrationHistory(
        fixtureSnapshot(tags.slice(0, 1)),
        fixtureSnapshot(tags),
      );
    }).not.toThrow();
    expect(() => {
      checkSqliteMigrationHistory(fixtureSnapshot(tags), fixtureSnapshot(tags));
    }).not.toThrow();
  });

  it.each([
    "edit SQL",
    "delete SQL",
    "rename SQL",
    "edit snapshot",
    "delete snapshot",
    "reformat journal",
    "rewrite prior timestamp",
    "reorder journal properties",
    "reorder old entry properties",
    "rewrite snapshot ID",
    "unlisted SQL",
    "unlisted metadata",
    "insert earlier migration",
    "remove old entry",
  ])("rejects %s", (operation) => {
    const base = fixtureSnapshot(tags.slice(0, 2));
    const files = copied(fixtureSnapshot(tags));
    const firstSql = `${directory}/20270101000000_first.sql`;
    const firstSnapshot = `${directory}/meta/20270101000000_snapshot.json`;
    const journal = Buffer.from(files.get(journalPath) ?? []).toString("utf8");
    switch (operation) {
      case "edit SQL":
        files.set(firstSql, Buffer.from("CREATE TABLE changed(x);"));
        break;
      case "delete SQL":
        files.delete(firstSql);
        break;
      case "rename SQL":
        files.delete(firstSql);
        files.set(
          `${directory}/20270101000000_renamed.sql`,
          Buffer.from("CREATE TABLE table_0(value TEXT);"),
        );
        break;
      case "edit snapshot":
        files.set(
          firstSnapshot,
          Buffer.concat([
            files.get(firstSnapshot) ?? Buffer.alloc(0),
            Buffer.from(" "),
          ]),
        );
        break;
      case "delete snapshot":
        files.delete(firstSnapshot);
        break;
      case "reformat journal":
        files.set(journalPath, Buffer.from(journal.replaceAll("  ", " ")));
        break;
      case "rewrite prior timestamp":
        files.set(
          journalPath,
          Buffer.from(
            journal
              .replace('"when": 2', '"when": 20')
              .replace('"when": 3', '"when": 30'),
          ),
        );
        break;
      case "reorder journal properties":
        files.set(
          journalPath,
          Buffer.from(
            journal.replace(
              '"version": "7",\n  "dialect": "sqlite"',
              '"dialect": "sqlite",\n  "version": "7"',
            ),
          ),
        );
        break;
      case "reorder old entry properties":
        files.set(
          journalPath,
          Buffer.from(
            journal.replace(
              '"idx": 0,\n      "version": "6"',
              '"version": "6",\n      "idx": 0',
            ),
          ),
        );
        break;
      case "rewrite snapshot ID":
        files.set(
          firstSnapshot,
          Buffer.from(
            Buffer.from(files.get(firstSnapshot) ?? [])
              .toString("utf8")
              .replace(id(1), id(8)),
          ),
        );
        break;
      case "unlisted SQL":
        files.set(
          `${directory}/20270104000000_unlisted.sql`,
          Buffer.from("CREATE TABLE hidden(x);"),
        );
        break;
      case "unlisted metadata":
        files.set(`${directory}/meta/unknown.json`, Buffer.from("{}"));
        break;
      case "insert earlier migration":
        files.clear();
        for (const [path, bytes] of fixtureSnapshot([
          "20260101000000_earlier",
          ...tags,
        ]).files)
          files.set(path, Buffer.from(bytes));
        break;
      case "remove old entry":
        files.clear();
        for (const [path, bytes] of fixtureSnapshot(tags.slice(0, 1)).files)
          files.set(path, Buffer.from(bytes));
        break;
    }
    expect(() => {
      checkSqliteMigrationHistory(base, { files });
    }).toThrow(SqliteMigrationError);
  });

  it("rejects duplicate JSON keys, unknown journal fields, broken indices and duplicate timestamp prefixes", () => {
    const original = fixtureSnapshot(tags.slice(0, 2));
    const journal = Buffer.from(original.files.get(journalPath) ?? []).toString(
      "utf8",
    );
    for (const next of [
      journal.replace('"idx": 0', '"idx": 0, "idx": 0'),
      journal.replace('"idx": 0', '"idx": 1'),
      journal.replace(
        '"dialect": "sqlite"',
        '"dialect": "sqlite", "extra": true',
      ),
      journal.replace(tags[1] ?? "", "20270101000000_second"),
    ]) {
      const files = copied(original);
      files.set(journalPath, Buffer.from(next));
      expect(() => {
        checkSqliteMigrationHistory(original, { files });
      }).toThrow(SqliteMigrationError);
    }
  });

  it("retains the exact runtime bytes even before journal introduction", () => {
    const files = copied(fixtureSnapshot());
    files.set(runtimePath, Buffer.concat([runtimeBytes, Buffer.from("\n")]));
    expect(() => {
      checkSqliteMigrationHistory(fixtureSnapshot(), { files });
    }).toThrow(SqliteMigrationError);
  });
});

describe("bounded filesystem and real trusted Git base", () => {
  it("reads the official journal/snapshots and rejects unlisted files", async () => {
    const snapshot = await readSqliteMigrationSnapshot(root);
    expect(snapshot.files.has(journalPath)).toBe(true);
    const path = await temp();
    await writeSnapshot(path, fixtureSnapshot(tags));
    await expect(readSqliteMigrationSnapshot(path)).resolves.toMatchObject({
      files: fixtureSnapshot(tags).files,
    });
    await writeFile(join(path, directory, "unlisted.sql"), "SELECT 1;");
    await expect(readSqliteMigrationSnapshot(path)).rejects.toBeInstanceOf(
      SqliteMigrationError,
    );
  });

  it.each(["file", "meta", "migrations", "ancestor"])(
    "rejects a symlinked %s",
    async (part) => {
      const path = await temp();
      await writeSnapshot(path, fixtureSnapshot(tags));
      const target =
        part === "file"
          ? join(path, runtimePath)
          : part === "meta"
            ? join(path, directory, "meta")
            : part === "migrations"
              ? join(path, directory)
              : join(path, "apps/forum");
      const destination = `${target}-real`;
      const { rename } = await import("node:fs/promises");
      await rename(target, destination);
      await symlink(destination, target);
      await expect(readSqliteMigrationSnapshot(path)).rejects.toBeInstanceOf(
        SqliteMigrationError,
      );
    },
  );

  it("rejects a FIFO without blocking, and rejects nested migration directories", async () => {
    const path = await temp();
    await writeSnapshot(path, fixtureSnapshot());
    execFileSync("mkfifo", [join(path, directory, "unexpected.sql")], {
      timeout: 1000,
    });
    await expect(readSqliteMigrationSnapshot(path)).rejects.toBeInstanceOf(
      SqliteMigrationError,
    );
    await rm(join(path, directory, "unexpected.sql"));
    await mkdir(join(path, directory, "nested"));
    await expect(readSqliteMigrationSnapshot(path)).rejects.toBeInstanceOf(
      SqliteMigrationError,
    );
  });

  it("rejects malformed JSON, invalid UTF-8 and oversized files", async () => {
    const path = await temp();
    await writeSnapshot(path, fixtureSnapshot(tags));
    for (const bytes of [
      Buffer.from("{"),
      Buffer.from([0xc3, 0x28]),
      Buffer.alloc(1024 * 1024 + 1),
    ]) {
      await writeFile(join(path, journalPath), bytes);
      await expect(readSqliteMigrationSnapshot(path)).rejects.toBeInstanceOf(
        SqliteMigrationError,
      );
    }
  });

  it("uses real Git bytes to verify a prior-version append and native replay", async () => {
    const { path, base } = await commitFixture(
      fixtureSnapshot(tags.slice(0, 1)),
    );
    const before = await readGitSqliteMigrationSnapshot(path, base);
    expect(Buffer.from(before.files.get(runtimePath) ?? [])).toEqual(
      runtimeBytes,
    );
    await writeSnapshot(path, fixtureSnapshot(tags));
    await expect(checkSqliteMigrations(path, base)).resolves.toEqual({
      migrations: 4,
      statements: 4,
    });
    await writeFile(
      join(path, directory, "20270101000000_first.sql"),
      "CREATE TABLE rewritten(x);\n",
    );
    await expect(checkSqliteMigrations(path, base)).rejects.toBeInstanceOf(
      SqliteMigrationError,
    );
  });

  it("supports the exact pre-Drizzle runtime as a real prior Git version", async () => {
    const { path, base } = await commitFixture(fixtureSnapshot());
    await writeSnapshot(path, fixtureSnapshot(tags));
    await expect(checkSqliteMigrations(path, base)).resolves.toMatchObject({
      migrations: 4,
    });
  });

  it.each([
    "",
    "main",
    "HEAD",
    "--help",
    "0".repeat(40),
    "a".repeat(39),
    "A".repeat(40),
  ])("fails closed on missing/invalid/unavailable base %s", async (base) => {
    const { path } = await commitFixture(fixtureSnapshot());
    await expect(
      readGitSqliteMigrationSnapshot(path, base),
    ).rejects.toBeInstanceOf(SqliteMigrationError);
  });

  it("rejects a real commit with missing migration history", async () => {
    const { path, base } = await commitFixture({
      files: new Map([["README.md", Buffer.from("no migrations")]]),
    });
    await expect(
      readGitSqliteMigrationSnapshot(path, base),
    ).rejects.toBeInstanceOf(SqliteMigrationError);
  });

  it("rejects non-ancestor commits, blobs and symlinked Git entries", async () => {
    const { path, base } = await commitFixture(fixtureSnapshot());
    const blob = git(path, ["rev-parse", `${base}:${runtimePath}`]);
    await expect(
      readGitSqliteMigrationSnapshot(path, blob),
    ).rejects.toBeInstanceOf(SqliteMigrationError);
    await rm(join(path, runtimePath));
    await symlink("outside.sql", join(path, runtimePath));
    git(path, ["add", "."]);
    git(path, [
      "-c",
      "user.name=Migration Safety Test",
      "-c",
      "user.email=migration-safety@example.invalid",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--quiet",
      "-m",
      "test: untrusted symlink",
    ]);
    const next = git(path, ["rev-parse", "HEAD"]);
    await expect(
      readGitSqliteMigrationSnapshot(path, next),
    ).rejects.toBeInstanceOf(SqliteMigrationError);
    git(path, ["checkout", "--quiet", "--detach", base]);
    await expect(
      readGitSqliteMigrationSnapshot(path, next),
    ).rejects.toBeInstanceOf(SqliteMigrationError);
  });
});

describe("CLI requires an explicit trusted commit", () => {
  it.each([
    { args: [] },
    { args: ["HEAD"] },
    { args: ["--remote"] },
    { args: ["a".repeat(40), "extra"] },
  ])("fails closed with arguments %j", ({ args }) => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        join(root, "scripts/check-sqlite-migrations.ts"),
        ...args,
      ],
      { cwd: root, encoding: "utf8", timeout: 10_000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe(
      "SQLite migration safety failed: history",
    );
  });
});

describe("runner configuration matches the analyzed chain", () => {
  const valid = { binding: "DB", migrations_dir: directory };
  it("accepts the current JSONC root configuration and provider binding IDs", async () => {
    expect(() => {
      checkSqliteMigrationConfiguration(
        Buffer.from(
          '{ /* root */ "d1_databases": [{"binding":"DB", "migrations_dir":"apps/forum/migrations", "migrations_table":"d1_migrations", "database_id":"fixture-provider-id",}],}',
        ),
      );
    }).not.toThrow();
    checkSqliteMigrationConfiguration(
      await readFile(join(root, "wrangler.jsonc")),
    );
  });
  it.each([
    { d1_databases: [{ ...valid, migrations_dir: "unchecked" }] },
    {
      d1_databases: [
        {
          ...valid,
          migrations_pattern: "apps/forum/migrations/nested/**/*.sql",
        },
      ],
    },
    { d1_databases: [{ ...valid, migrations_table: "unchecked_history" }] },
    { d1_databases: [{ ...valid, binding: "OTHER" }] },
    { d1_databases: [valid, valid] },
    { d1_databases: [] },
    {
      d1_databases: [valid],
      env: {
        unchecked: {
          d1_databases: [{ ...valid, migrations_dir: "unchecked" }],
        },
      },
    },
    { d1_databases: [{ binding: "DB" }] },
    {},
  ])(
    "rejects a runner target differing from the native replay: %j",
    (value) => {
      expect(() => {
        checkSqliteMigrationConfiguration(jsonBytes(value));
      }).toThrow("configuration");
    },
  );
  it("rejects malformed configuration JSONC", () => {
    expect(() => {
      checkSqliteMigrationConfiguration(Buffer.from('{"d1_databases":['));
    }).toThrow("configuration");
  });
});

describe("actual safety entrypoint rejects runner redirection", () => {
  it.each(["other-environment", "--remote"])(
    "rejects a selected environment %s",
    (environment) => {
      expect(() => {
        checkSqliteMigrationConfiguration(
          jsonBytes({
            d1_databases: [{ binding: "DB", migrations_dir: directory }],
          }),
          environment,
        );
      }).toThrow("configuration");
    },
  );
  it("rejects config-only directory redirection through the real entrypoint", async () => {
    const { path, base } = await commitFixture(fixtureSnapshot());
    await writeFile(
      join(path, "wrangler.jsonc"),
      JSON.stringify({
        d1_databases: [{ binding: "DB", migrations_dir: "unchecked" }],
      }),
    );
    await expect(checkSqliteMigrations(path, base)).rejects.toThrow(
      "configuration",
    );
  });
  it("rejects symlinked configuration files", async () => {
    const { path, base } = await commitFixture(fixtureSnapshot());
    await rm(join(path, "wrangler.jsonc"));
    await writeFile(
      join(path, "other.jsonc"),
      JSON.stringify({
        d1_databases: [{ binding: "DB", migrations_dir: directory }],
      }),
    );
    await symlink("other.jsonc", join(path, "wrangler.jsonc"));
    await expect(checkSqliteMigrations(path, base)).rejects.toBeInstanceOf(
      SqliteMigrationError,
    );
  });
  it("rejects oversized configuration files", async () => {
    const { path, base } = await commitFixture(fixtureSnapshot());
    await writeFile(join(path, "wrangler.jsonc"), " ".repeat(1024 * 1024 + 1));
    await expect(checkSqliteMigrations(path, base)).rejects.toBeInstanceOf(
      SqliteMigrationError,
    );
  });
});

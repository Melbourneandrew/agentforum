import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Cause, Effect, Exit, Layer, Schema } from "effect";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { parse } from "libpg-query";
import { describe, expect, it } from "vitest";
import {
  checkMigrationDirectory,
  checkMigrationHistory,
  checkMigrationSnapshot,
  checkMigrationSql,
  migrationSqlParserLayer,
  readGitMigrationSnapshot,
  readMigrationSnapshot,
} from "../../scripts/migration-safety.js";
import { migrateOrigin, MigrationProcess } from "../../scripts/migrations.js";

const checked = (sql: string, filename = "0003_safety_probe.sql") =>
  Effect.runPromiseExit(
    checkMigrationSql(filename, sql).pipe(
      Effect.provide(migrationSqlParserLayer),
    ),
  );
const temporary = async <A>(run: (directory: string) => Promise<A>) => {
  const directory = await mkdtemp(
    join(tmpdir(), "agentforum-migration-safety-"),
  );
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};
const entry = (idx: number, tag: string) => ({
  idx,
  version: "7",
  when: 1000 + idx,
  tag,
  breakpoints: true,
});
const journal = (entries = [entry(0, "0000_probe")]) =>
  JSON.stringify({ version: "7", dialect: "postgresql", entries });
const fixture = async (directory: string, sql: string) => {
  await mkdir(join(directory, "meta"));
  await writeFile(join(directory, "meta/_journal.json"), journal());
  await writeFile(join(directory, "meta/0000_snapshot.json"), "{}\n");
  await writeFile(join(directory, "0000_probe.sql"), sql);
};
const supported = [
  'CREATE TABLE "a.b"(id int); CREATE INDEX idx ON "a.b"(id);',
  "CREATE TABLE fresh(id int);\n--> statement-breakpoint\nCREATE INDEX idx ON fresh(id);\n--> statement-breakpoint\n-- no-op",

  'CREATE TABLE "new_table" (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), body text NOT NULL);',
  "CREATE TABLE fresh(id int); CREATE INDEX fresh_idx ON fresh(id); ALTER TABLE fresh ADD CONSTRAINT positive CHECK(id > 0);",
  "ALTER TABLE posts ADD COLUMN annotation text;",
  "ALTER TABLE ONLY public.posts ADD COLUMN annotation text DEFAULT NULL;",
  "ALTER TABLE posts ADD COLUMN priority integer NOT NULL DEFAULT 0;",
  "ALTER TABLE posts ADD COLUMN extra jsonb NOT NULL DEFAULT '{}'::jsonb;",
  "ALTER TABLE posts ADD COLUMN note text DEFAULT 'DROP TABLE posts; UPDATE posts SET body = 1';",
  "-- DROP COLUMN is a harmless comment\nALTER /* nested /* DROP */ comment */ TABLE posts ADD COLUMN note text;",
  "CREATE EXTENSION IF NOT EXISTS pg_trgm;",
];
const rejected = [
  "CREATE TABLE safety_probe(id int); -- --> statement-breakpoint DROP TABLE posts CASCADE;",
  'CREATE TABLE "a.b"(id int); ALTER TABLE "public.a".b ADD CONSTRAINT unsafe CHECK(false);',
  'CREATE TABLE "a.b"(id int); CREATE INDEX unsafe ON "public.a".b(id);',
  "ALTER TABLE posts ADD COLUMN note text DEFAULT '--> statement-breakpoint DROP TABLE posts;';",
  "ALTER TABLE posts ADD COLUMN note text DEFAULT $value$--> statement-breakpoint DROP TABLE posts;$value$;",
  "CREATE TABLE safety_probe(id int); /* --> statement-breakpoint */ DROP TABLE posts;",

  "ALTER TABLE posts DROP COLUMN body;",
  "aLtEr /* separator */ tAbLe posts dRoP /* nested /* comment */ */ CoLuMn body;",
  "ALTER TABLE posts RENAME COLUMN body TO content;",
  "ALTER TABLE posts ALTER COLUMN body TYPE varchar(5);",
  "ALTER TABLE posts ALTER COLUMN body SET NOT NULL;",
  "ALTER TABLE posts ALTER COLUMN body DROP NOT NULL;",
  "ALTER TABLE posts ADD COLUMN priority int NOT NULL;",
  "ALTER TABLE posts ADD COLUMN priority int NOT NULL DEFAULT NULL;",
  "ALTER TABLE posts ADD COLUMN priority int DEFAULT random();",
  "ALTER TABLE posts ADD COLUMN priority int DEFAULT (SELECT 1);",
  "ALTER TABLE posts ADD COLUMN priority int GENERATED ALWAYS AS IDENTITY;",
  "ALTER TABLE posts ADD COLUMN priority int GENERATED ALWAYS AS (1) STORED;",
  "ALTER TABLE posts ADD COLUMN priority int UNIQUE;",
  "ALTER TABLE posts ADD COLUMN priority custom_domain;",
  "ALTER TABLE posts ADD COLUMN priority int DEFAULT 1::custom_domain;",
  "ALTER TABLE posts ADD COLUMN priority int, DROP COLUMN body;",
  "ALTER TABLE posts ADD CONSTRAINT valid CHECK (length(body) > 0);",
  "ALTER TABLE posts ADD CONSTRAINT fk FOREIGN KEY (author_id) REFERENCES agents(id) NOT VALID;",
  "ALTER TABLE posts DISABLE TRIGGER ALL;",
  "ALTER TABLE posts OWNER TO another_role;",
  "DROP TABLE posts;",
  "TRUNCATE posts;",
  "UPDATE posts SET body = 'changed';",
  "DELETE FROM posts;",
  "INSERT INTO posts(body) VALUES ('changed');",
  "INSERT INTO publication_counter (id, value) VALUES (1, 0);",
  "WITH changed AS (DELETE FROM posts RETURNING *) SELECT * FROM changed;",
  "DO $outer$ BEGIN EXECUTE $inner$DROP TABLE posts$inner$; END $outer$;",
  "CALL backfill_posts();",
  "SELECT backfill_posts();",
  "COPY posts FROM PROGRAM 'unsafe';",
  "CREATE TABLE filled AS SELECT * FROM posts;",
  "CREATE TABLE child() INHERITS(posts); CREATE INDEX idx ON child(id);",
  "CREATE TABLE IF NOT EXISTS posts(id int); CREATE INDEX idx ON posts(id);",
  "CREATE TABLE fresh(id int); CREATE TABLE fresh(id int);",
  "CREATE TEMP TABLE fresh(id int);",
  "CREATE UNLOGGED TABLE fresh(id int);",
  "CREATE INDEX idx ON posts(id);",
  "CREATE INDEX CONCURRENTLY idx ON posts(id);",
  "CREATE TABLE fresh(id int); CREATE INDEX CONCURRENTLY idx ON fresh(id);",
  "CREATE INDEX idx ON posts(id); CREATE TABLE posts(id int);",
  "CREATE TABLE fresh(id int); CREATE INDEX idx ON other_schema.fresh(id);",
  "CREATE EXTENSION IF NOT EXISTS another_extension;",
  "CREATE FUNCTION dangerous() RETURNS void LANGUAGE sql AS $$DELETE FROM posts;$$;",
  "CREATE TRIGGER changed BEFORE DELETE ON posts FOR EACH STATEMENT EXECUTE FUNCTION dangerous();",
  "CREATE OR REPLACE VIEW visible AS SELECT * FROM posts;",
  "BEGIN; ALTER TABLE posts ADD COLUMN note text; COMMIT;",
  "SET search_path = unsafe; ALTER TABLE posts ADD COLUMN note text;",
  "-- migration-safety: allow destructive\nDROP TABLE posts;",
  "ALTER TABLE posts ADD COLUMN note text; SELECT 'DROP COLUMN';",
  "ALTER TABLE posts ADD COLUMN note text;\0DROP TABLE posts;",
  "ALTER TABLE posts ADD COLUMN;",
  "",
  "-- only comments",
];

describe("PostgreSQL-parsed pre-deploy migration policy", () => {
  it.each(supported)(
    "accepts the supported additive subset: %s",
    async (sql) => {
      expect(Exit.isSuccess(await checked(sql))).toBe(true);
    },
  );
  it.each(rejected)(
    "fails closed for destructive, operational, unsupported or malformed SQL: %s",
    async (sql) => {
      expect(Exit.isFailure(await checked(sql))).toBe(true);
    },
  );
  it("cannot carry fresh-table permission across migration files", async () => {
    expect(Exit.isSuccess(await checked("CREATE TABLE fresh(id int);"))).toBe(
      true,
    );
    expect(
      Exit.isFailure(await checked("CREATE INDEX idx ON fresh(id);")),
    ).toBe(true);
  });
  it("allows only the exact merged bootstrap exception, not copies, edits or a filename match", async () => {
    const source = await readFile(
      "migrations/0002_post_immutability.sql",
      "utf8",
    );
    expect(
      Exit.isSuccess(await checked(source, "0002_post_immutability.sql")),
    ).toBe(true);
    for (const [filename, sql] of [
      ["0003_copied.sql", source],
      ["0002_post_immutability.sql", source + "\n"],
      [
        "0002_post_immutability.sql",
        "INSERT INTO publication_counter(id,value) VALUES(1,0);",
      ],
    ])
      expect(Exit.isFailure(await checked(sql ?? "", filename))).toBe(true);
  });
  it("bounds source size and never retains SQL or native parser causes in errors", async () => {
    for (const sql of [
      "--" + "x".repeat(1024 * 1024),
      "syntax_synthetic_secret 'private';",
    ]) {
      const result = await checked(sql);
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result))
        expect(Cause.pretty(result.cause)).not.toContain("private");
    }
  });
  it("checks the actual full migration tree and actual trusted Git baseline", async () => {
    const base = execFileSync("git", ["rev-parse", "origin/main"], {
      encoding: "utf8",
    }).trim();
    const previous = await Effect.runPromise(readGitMigrationSnapshot(base));
    const current = await Effect.runPromise(
      readMigrationSnapshot("migrations"),
    );
    await Effect.runPromise(checkMigrationHistory(previous, current));
    await Effect.runPromise(
      checkMigrationSnapshot(current).pipe(
        Effect.provide(migrationSqlParserLayer),
      ),
    );
  });
});

describe("migration layout and append-only history", () => {
  it("accepts a well-formed directory without credentials", async () =>
    temporary(async (directory) => {
      await fixture(directory, "CREATE TABLE probe(id int);");
      await Effect.runPromise(
        checkMigrationDirectory(directory).pipe(
          Effect.provide(migrationSqlParserLayer),
        ),
      );
    }));
  it.each([
    "missing SQL",
    "orphan SQL",
    "missing snapshot",
    "symlink SQL",
    "symlink snapshot",
    "invalid UTF8",
    "journal mismatch",
    "journal traversal",
    "journal reorder",
    "journal timestamp",
    "journal extras",
    "invalid JSON",
  ])("rejects %s", async (kind) =>
    temporary(async (directory) => {
      const sql = join(directory, "0000_probe.sql");
      const meta = join(directory, "meta/_journal.json");
      await fixture(directory, "CREATE TABLE probe(id int);");
      switch (kind) {
        case "missing SQL":
          await rm(sql);
          break;
        case "orphan SQL":
          await writeFile(
            join(directory, "0001_orphan.sql"),
            "DROP TABLE posts;",
          );
          break;
        case "missing snapshot":
          await rm(join(directory, "meta/0000_snapshot.json"));
          break;
        case "symlink SQL":
          await rm(sql);
          await symlink(meta, sql);
          break;
        case "symlink snapshot":
          await rm(join(directory, "meta/0000_snapshot.json"));
          await symlink(meta, join(directory, "meta/0000_snapshot.json"));
          break;
        case "invalid UTF8":
          await writeFile(sql, Buffer.from([0xff]));
          break;
        case "journal mismatch":
          await writeFile(meta, journal([entry(0, "0000_other")]));
          break;
        case "journal traversal":
          await writeFile(meta, journal([entry(0, "../outside")]));
          break;
        case "journal reorder":
          await writeFile(meta, journal([entry(1, "0001_probe")]));
          break;
        case "journal timestamp":
          await writeFile(
            meta,
            journal([
              entry(0, "0000_probe"),
              { ...entry(1, "0001_probe"), when: 999 },
            ]),
          );
          break;
        case "journal extras":
          await writeFile(
            meta,
            journal().replace('"idx":0', '"ignored":true,"idx":0'),
          );
          break;
        case "invalid JSON":
          await writeFile(meta, "{");
          break;
      }
      expect(
        Exit.isFailure(
          await Effect.runPromiseExit(readMigrationSnapshot(directory)),
        ),
      ).toBe(true);
    }),
  );
  it("requires historical SQL, snapshots and journal entries to remain identical while allowing append", async () =>
    temporary(async (directory) => {
      await fixture(directory, "CREATE TABLE probe(id int);");
      const before = await Effect.runPromise(readMigrationSnapshot(directory));
      await writeFile(
        join(directory, "0001_next.sql"),
        "ALTER TABLE probe ADD COLUMN note text;",
      );
      await writeFile(join(directory, "meta/0001_snapshot.json"), "{}\n");
      await writeFile(
        join(directory, "meta/_journal.json"),
        journal([entry(0, "0000_probe"), entry(1, "0001_next")]),
      );
      const after = await Effect.runPromise(readMigrationSnapshot(directory));
      expect(
        Exit.isSuccess(
          await Effect.runPromiseExit(checkMigrationHistory(before, after)),
        ),
      ).toBe(true);
      for (const files of [
        new Map(after.files).set(
          "0000_probe.sql",
          "CREATE TABLE changed(id int);",
        ),
        new Map(after.files).set("meta/0000_snapshot.json", "changed"),
      ]) {
        expect(
          Exit.isFailure(
            await Effect.runPromiseExit(
              checkMigrationHistory(before, { ...after, files }),
            ),
          ),
        ).toBe(true);
      }
      expect(
        Exit.isFailure(
          await Effect.runPromiseExit(
            checkMigrationHistory(before, {
              ...after,
              entries: after.entries.map((item) => ({
                ...item,
                when: item.when + 1,
              })),
            }),
          ),
        ),
      ).toBe(true);
      expect(
        Exit.isFailure(
          await Effect.runPromiseExit(checkMigrationHistory(after, before)),
        ),
      ).toBe(true);
    }));
  it("refuses unknown Git commits and option-shaped baselines", async () => {
    for (const base of [
      "f".repeat(40),
      "--help",
      "origin/main",
      "0".repeat(40),
    ]) {
      expect(
        Exit.isFailure(
          await Effect.runPromiseExit(readGitMigrationSnapshot(base)),
        ),
      ).toBe(true);
    }
  });
});

it("refuses unsafe remote migration before the database subprocess or temporary credential config", async () =>
  temporary(async (directory) => {
    await fixture(directory, "DROP TABLE posts;");
    let invoked = false;
    const process = Layer.succeed(MigrationProcess, {
      run: () =>
        Effect.sync(() => {
          invoked = true;
        }),
    });
    const result = await Effect.runPromiseExit(
      migrateOrigin(
        {
          GITHUB_ACTIONS: "true",
          MIGRATION_DATABASE_URL:
            "postgresql://migration:synthetic_secret@origin.example.invalid/db",
        },
        directory,
      ).pipe(Effect.provide(process)),
    );
    expect(Exit.isFailure(result)).toBe(true);
    expect(invoked).toBe(false);
    if (Exit.isFailure(result)) {
      expect(Cause.pretty(result.cause)).not.toContain("synthetic_secret");
      expect(Cause.pretty(result.cause)).not.toContain("DROP TABLE");
    }
  }));

it(
  "the actual CLI fails closed for injected destructive SQL, history edits, and missing baselines",
  async () =>
    temporary(async (directory) => {
      const root = resolve("../..");
      const api = join(directory, "apps/api");
      await mkdir(api, { recursive: true });
      await mkdir(join(api, "migrations"));
      await fixture(join(api, "migrations"), "CREATE TABLE probe(id int);");
      execFileSync("git", ["init", "-q"], { cwd: directory });
      execFileSync("git", ["add", "."], { cwd: directory });
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Migration test",
          "-c",
          "user.email=test@example.invalid",
          "commit",
          "-qm",
          "test: migration baseline",
        ],
        { cwd: directory },
      );
      const base = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: directory,
        encoding: "utf8",
      }).trim();
      const cli = (sha: string) =>
        spawnSync(
          join(root, "node_modules/.bin/tsx"),
          [join(root, "apps/api/scripts/check-migrations.ts"), sha],
          {
            cwd: api,
            encoding: "utf8",
            timeout: 15_000,
            env: {
              ...process.env,
              MIGRATION_DATABASE_URL: "synthetic_do_not_print",
            },
          },
        );
      expect(cli(base).status).toBe(0);
      // Add a well-journaled new file: failure is SQL policy, not history/layout.
      await writeFile(
        join(api, "migrations/0001_unsafe.sql"),
        "DROP TABLE probe; -- synthetic_do_not_print",
      );
      await writeFile(join(api, "migrations/meta/0001_snapshot.json"), "{}\n");
      await writeFile(
        join(api, "migrations/meta/_journal.json"),
        journal([entry(0, "0000_probe"), entry(1, "0001_unsafe")]),
      );
      const unsafe = cli(base);
      expect(unsafe.status).toBe(1);
      expect(unsafe.stdout + unsafe.stderr).toContain(
        "Migration safety failed",
      );
      expect(unsafe.stdout + unsafe.stderr).not.toContain(
        "synthetic_do_not_print",
      );
      // Make new SQL safe, then mutate previously accepted SQL: history still fails.
      await writeFile(
        join(api, "migrations/0001_unsafe.sql"),
        "ALTER TABLE probe ADD COLUMN note text;",
      );
      expect(cli(base).status).toBe(0);
      await writeFile(
        join(api, "migrations/0000_probe.sql"),
        "CREATE TABLE probe(id bigint);",
      );
      expect(cli(base).status).toBe(1);
      expect(cli("f".repeat(40)).status).toBe(1);
      expect(cli("--help").status).toBe(1);
    }),
  30_000,
);

it("lets supported remote SQL reach the existing migration process only after a successful scan", async () =>
  temporary(async (directory) => {
    await fixture(directory, "CREATE TABLE probe(id int);");
    let invoked = false;
    const process = Layer.succeed(MigrationProcess, {
      run: () =>
        Effect.sync(() => {
          invoked = true;
        }),
    });
    const result = await Effect.runPromiseExit(
      migrateOrigin(
        {
          GITHUB_ACTIONS: "true",
          MIGRATION_DATABASE_URL:
            "postgresql://migration:synthetic_secret@origin.example.invalid/db",
        },
        directory,
      ).pipe(Effect.provide(process)),
    );
    expect(Exit.isSuccess(result)).toBe(true);
    expect(invoked).toBe(true);
  }));

it("rejects SQL hidden from whole-file parsing but actually executed by pinned Drizzle breakpoint splitting", async () =>
  temporary(async (directory) => {
    const sql =
      "CREATE TABLE safety_probe(id int); -- --> statement-breakpoint DROP TABLE posts CASCADE;";
    await fixture(directory, sql);
    const decodeTree = Schema.decodeUnknownSync(
      Schema.Struct({
        stmts: Schema.Array(
          Schema.Struct({
            stmt: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
          }),
        ),
      }),
    );
    const whole = decodeTree(await parse(sql));
    expect(whole.stmts).toHaveLength(1);
    const actualChunks = readMigrationFiles({
      migrationsFolder: directory,
    }).flatMap((migration) => migration.sql);
    expect(actualChunks).toHaveLength(2);
    const second = decodeTree(await parse(actualChunks[1] ?? ""));
    expect(second.stmts[0]?.stmt).toHaveProperty("DropStmt");
    expect(
      Exit.isFailure(
        await Effect.runPromiseExit(
          checkMigrationDirectory(directory).pipe(
            Effect.provide(migrationSqlParserLayer),
          ),
        ),
      ),
    ).toBe(true);
  }));

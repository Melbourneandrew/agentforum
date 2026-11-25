import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import {
  CONTROL_FILE,
  CONTROL_HISTORY,
  CONTROL_V1_SHA256,
  NATIVE_HISTORY_SQL,
} from "./delivery/release-control.js";
import initSqlite, {
  type Database,
  type Sqlite3Static,
} from "@sqlite.org/sqlite-wasm";
// Resolve the actual app dependency. Decode this narrow third-party boundary
// rather than importing Wrangler's unrelated CLI/provider declaration graph.
const appRequire = createRequire(
  new URL("../apps/forum/package.json", import.meta.url),
);
let splitter: ((source: string) => readonly string[]) | undefined;
const splitWithWrangler = (source: string): readonly string[] => {
  splitter ??= (() => {
    const module: unknown = appRequire("wrangler");
    if (!object(module) || typeof module.unstable_splitSqlQuery !== "function")
      return fail("tooling");
    const fn = module.unstable_splitSqlQuery;
    return (sql: string) => {
      const value: unknown = Reflect.apply(fn, undefined, [sql]);
      if (
        !Array.isArray(value) ||
        !value.every((item: unknown) => typeof item === "string")
      )
        return fail("tooling");
      return value.map((item: unknown) =>
        typeof item === "string" ? item : fail("tooling"),
      );
    };
  })();
  return splitter(source);
};

const directory = "apps/forum/migrations";
const journalPath = `${directory}/meta/_journal.json`;
const runtimePath = `${directory}/0000_runtime.sql`;
const maximumFileBytes = 1024 * 1024;
const maximumFiles = 1000;
const maximumStatements = 2000;
const maximumTotalBytes = 16 * 1024 * 1024;
const approved = new Map([
  [
    runtimePath,
    "2ca6ec9a84f3630ea607262c6abadb3491580ffc380b67d98e9af47564814a47",
  ],
  [
    `${directory}/20261119101855_forum.sql`,
    "25feb6495bf7b57fb2b6f79caec2423f97ff73352b2866d35751d43db45e1ce7",
  ],
  [
    `${directory}/20261119101856_publication_guards.sql`,
    "1bfe8b74d7137dc33cd7eb5185cbe1a4cf8c2457d1da02e44a8322059cafcf77",
  ],
]);

export class SqliteMigrationError extends Error {
  constructor(
    readonly stage:
      | "layout"
      | "history"
      | "tooling"
      | "parse"
      | "policy"
      | "replay"
      | "configuration",
  ) {
    super(`SQLite migration safety failed: ${stage}`);
    this.name = "SqliteMigrationError";
  }
}
const fail = (stage: SqliteMigrationError["stage"]): never => {
  throw new SqliteMigrationError(stage);
};
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const decode = (bytes: Uint8Array): string => {
  if (bytes.length > maximumFileBytes || bytes.includes(0))
    return fail("layout");
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    return fail("layout");
  }
};
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: readonly string[]) =>
  Object.keys(value).length === expected.length &&
  expected.every((key) => Object.hasOwn(value, key));
const parseJson = (bytes: Uint8Array): unknown => {
  try {
    return JSON.parse(decode(bytes));
  } catch {
    return fail("layout");
  }
};
// The analyzed chain must be the chain the pinned root Wrangler command runs.
// Otherwise a config edit could leave this gate checking an unused safe folder.
export const checkSqliteMigrationConfiguration = (
  bytes: Uint8Array,
  environment?: string,
): void => {
  if (environment !== undefined && environment !== "")
    return fail("configuration");
  const errors: ParseError[] = [];
  const value: unknown = parseJsonc(decode(bytes), errors, {
    allowTrailingComma: true,
  });
  if (
    errors.length !== 0 ||
    !object(value) ||
    value.env !== undefined ||
    !Array.isArray(value.d1_databases) ||
    value.d1_databases.length !== 1
  )
    return fail("configuration");
  const database: unknown = value.d1_databases[0];
  if (
    !object(database) ||
    database.binding !== "DB" ||
    database.migrations_dir !== directory ||
    (database.migrations_table !== undefined &&
      database.migrations_table !== "d1_migrations") ||
    database.migrations_pattern !== undefined
  )
    return fail("configuration");
};
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(value);
interface Entry {
  readonly idx: number;
  readonly version: "6";
  readonly when: number;
  readonly tag: string;
  readonly breakpoints: true;
}
export interface SqliteMigrationSnapshot {
  readonly files: ReadonlyMap<string, Uint8Array>;
}
interface ValidatedSnapshot {
  readonly entries: readonly Entry[];
  readonly sqlPaths: readonly string[];
}
const requiredFile = (snapshot: SqliteMigrationSnapshot, path: string) =>
  snapshot.files.get(path) ?? fail("layout");

// Only the exact pre-Drizzle runtime migration may lack journal/snapshot entries.
const validateSnapshot = (
  snapshot: SqliteMigrationSnapshot,
): ValidatedSnapshot => {
  if (snapshot.files.size === 0 || snapshot.files.size > maximumFiles)
    return fail("layout");
  let total = 0;
  for (const bytes of snapshot.files.values()) {
    decode(bytes);
    total += bytes.length;
  }
  if (total > maximumTotalBytes) return fail("layout");
  if (digest(requiredFile(snapshot, runtimePath)) !== approved.get(runtimePath))
    return fail("layout");
  if (snapshot.files.size === 1)
    return { entries: [], sqlPaths: [runtimePath] };
  const journalBytes = requiredFile(snapshot, journalPath);
  const journal = parseJson(journalBytes);
  if (
    !object(journal) ||
    !keys(journal, ["version", "dialect", "entries"]) ||
    journal.version !== "7" ||
    journal.dialect !== "sqlite" ||
    !Array.isArray(journal.entries) ||
    journal.entries.length === 0
  )
    return fail("layout");
  // Drizzle emits this canonical format. Existing entry bytes cannot be rewritten
  // via whitespace, duplicate JSON keys or property-order changes during append.
  const entries: Entry[] = [];
  const expected = new Set([runtimePath, journalPath]);
  let previousTime = 0;
  let previousTag = "";
  let previousId = "00000000-0000-0000-0000-000000000000";
  const seenIds = new Set([previousId]);
  for (const value of journal.entries) {
    if (
      !object(value) ||
      !keys(value, ["idx", "version", "when", "tag", "breakpoints"]) ||
      value.idx !== entries.length ||
      value.version !== "6" ||
      typeof value.when !== "number" ||
      !Number.isSafeInteger(value.when) ||
      value.when <= previousTime ||
      typeof value.tag !== "string" ||
      !/^\d{14}_[a-z0-9_]+$/u.test(value.tag) ||
      value.tag <= previousTag ||
      value.breakpoints !== true
    )
      return fail("layout");
    const timestamp = value.tag.slice(0, 14);
    const sqlPath = `${directory}/${value.tag}.sql`;
    const snapshotPath = `${directory}/meta/${timestamp}_snapshot.json`;
    if (expected.has(snapshotPath)) return fail("layout");
    expected.add(sqlPath);
    expected.add(snapshotPath);
    const schema = parseJson(requiredFile(snapshot, snapshotPath));
    if (
      !object(schema) ||
      schema.version !== "6" ||
      schema.dialect !== "sqlite" ||
      !uuid(schema.id) ||
      seenIds.has(schema.id) ||
      schema.prevId !== previousId ||
      !object(schema.tables)
    )
      return fail("layout");
    seenIds.add(schema.id);
    previousId = schema.id;
    previousTime = value.when;
    previousTag = value.tag;
    entries.push({
      idx: value.idx,
      version: "6",
      when: value.when,
      tag: value.tag,
      breakpoints: true,
    });
  }
  if (
    decode(journalBytes) !==
    `${JSON.stringify({ version: "7", dialect: "sqlite", entries }, null, 2)}\n`
  )
    return fail("layout");
  if (
    expected.size !== snapshot.files.size ||
    [...snapshot.files.keys()].some((path) => !expected.has(path))
  )
    return fail("layout");
  const sqlPaths = [
    runtimePath,
    ...entries.map((entry) => `${directory}/${entry.tag}.sql`),
  ];
  // Timestamp names are unique numerically too; this matches Wrangler's numeric
  // leading-migration ordering without accepting nested paths or alternate names.
  if (
    new Set(entries.map((entry) => entry.tag.slice(0, 14))).size !==
    entries.length
  )
    return fail("layout");
  return { entries, sqlPaths };
};

const regularFile = async (path: string): Promise<Uint8Array> => {
  if (!(await lstat(path)).isFile()) return fail("layout");
  // NONBLOCK also prevents a concurrent replacement with a FIFO from hanging.
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maximumFileBytes) return fail("layout");
    const bytes = Buffer.alloc(maximumFileBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(
        bytes,
        length,
        bytes.length - length,
        null,
      );
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    const bounded = bytes.subarray(0, length);
    decode(bounded);
    return Buffer.from(bounded);
  } finally {
    await handle.close();
  }
};
export const readSqliteMigrationSnapshot = async (
  repositoryRoot: string,
): Promise<SqliteMigrationSnapshot> => {
  try {
    const root = resolve(repositoryRoot);
    if (!(await lstat(root)).isDirectory()) return fail("layout");
    for (const part of ["apps", "apps/forum", directory]) {
      if (!(await lstat(join(root, part))).isDirectory()) return fail("layout");
    }
    const files = new Map<string, Uint8Array>();
    let total = 0;
    const add = async (path: string) => {
      if (files.size >= maximumFiles) return fail("layout");
      const bytes = await regularFile(join(root, path));
      total += bytes.length;
      if (total > maximumTotalBytes) return fail("layout");
      files.set(path, bytes);
    };
    const names = await readdir(join(root, directory));
    if (names.length > maximumFiles) return fail("layout");
    for (const name of names) {
      if (name === "meta") {
        const path = `${directory}/meta`;
        if (!(await lstat(join(root, path))).isDirectory())
          return fail("layout");
        const metadata = await readdir(join(root, path));
        if (metadata.length > maximumFiles) return fail("layout");
        for (const child of metadata) await add(`${path}/${child}`);
      } else {
        await add(`${directory}/${name}`);
      }
    }
    const snapshot = { files };
    validateSnapshot(snapshot);
    return snapshot;
  } catch {
    return fail("layout");
  }
};

const exec = promisify(execFile);
const git = async (root: string, args: readonly string[]): Promise<Buffer> => {
  try {
    const result = await exec("git", [...args], {
      cwd: root,
      encoding: "buffer",
      timeout: 10_000,
      maxBuffer: maximumTotalBytes,
    });
    return result.stdout;
  } catch {
    return fail("history");
  }
};
export const readGitSqliteMigrationSnapshot = async (
  repositoryRoot: string,
  base: string,
): Promise<SqliteMigrationSnapshot> => {
  if (!/^[0-9a-f]{40}$/u.test(base)) return fail("history");
  if (
    (await git(repositoryRoot, ["cat-file", "-t", base]))
      .toString("utf8")
      .trim() !== "commit"
  )
    return fail("history");
  await git(repositoryRoot, ["merge-base", "--is-ancestor", base, "HEAD"]);
  const tree = (
    await git(repositoryRoot, [
      "ls-tree",
      "-rz",
      "--full-tree",
      base,
      "--",
      directory,
    ])
  ).toString("utf8");
  const files = new Map<string, Uint8Array>();
  let total = 0;
  for (const entry of tree.split("\0")) {
    if (entry === "") continue;
    const match =
      /^100644 blob ([0-9a-f]{40})\t(apps\/forum\/migrations\/[^\0]+)$/u.exec(
        entry,
      );
    const path = match?.[2];
    if (path === undefined || files.size >= maximumFiles)
      return fail("history");
    const bytes = await git(repositoryRoot, ["show", `${base}:${path}`]);
    total += bytes.length;
    if (bytes.length > maximumFileBytes || total > maximumTotalBytes)
      return fail("history");
    files.set(path, bytes);
  }
  const snapshot = { files };
  try {
    validateSnapshot(snapshot);
  } catch {
    return fail("history");
  }
  return snapshot;
};
export const checkSqliteMigrationHistory = (
  base: SqliteMigrationSnapshot,
  current: SqliteMigrationSnapshot,
): void => {
  const before = validateSnapshot(base);
  const after = validateSnapshot(current);
  if (
    after.entries.length < before.entries.length ||
    before.entries.some(
      (entry, index) =>
        JSON.stringify(entry) !== JSON.stringify(after.entries[index]),
    )
  )
    return fail("history");
  for (const [path, bytes] of base.files) {
    if (path === journalPath) continue;
    const next = current.files.get(path);
    if (next === undefined || !Buffer.from(bytes).equals(next))
      return fail("history");
  }
};

let sqlitePromise: Promise<Sqlite3Static> | undefined;
const sqlite = async (): Promise<Sqlite3Static> => {
  sqlitePromise ??= (async () => {
    // Reject silent upgrades of either parser or actual runner semantics.
    const wasmPackage: unknown = JSON.parse(
      await readFile(
        new URL(
          "../node_modules/@sqlite.org/sqlite-wasm/package.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const wranglerPackage: unknown = JSON.parse(
      await readFile(
        new URL(
          "../apps/forum/node_modules/wrangler/package.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    if (
      !object(wasmPackage) ||
      wasmPackage.version !== "3.54.1-build1" ||
      !object(wranglerPackage) ||
      wranglerPackage.version !== "4.156.2"
    )
      return fail("tooling");
    const instance = await initSqlite();
    if (
      instance.version.libVersion !== "3.54.1" ||
      typeof instance.capi.sqlite3_set_authorizer !== "function"
    )
      return fail("tooling");
    return instance;
  })();
  try {
    return await sqlitePromise;
  } catch {
    return fail("tooling");
  }
};
interface Authorization {
  readonly action: number;
  readonly first: string | 0;
  readonly second: string | 0;
  readonly database: string | 0;
  readonly source: string | 0;
}
const normalized = (sql: string): string => {
  const trimmed = sql.trim();
  // This removes only a delimiter from an already natively parsed statement.
  return trimmed.endsWith(";") ? trimmed.slice(0, -1).trimEnd() : trimmed;
};
const identifierKey = (name: string): string =>
  name.replace(/[A-Z]/gu, (letter) => letter.toLowerCase());
const schemaNames = (db: Database): Set<string> =>
  new Set(
    db
      .selectValues("SELECT name FROM sqlite_schema")
      .filter((name): name is string => typeof name === "string")
      .map(identifierKey),
  );
const safeFunctions = new Set([
  "abs",
  "char",
  "coalesce",
  "glob",
  "hex",
  "ifnull",
  "instr",
  "length",
  "like",
  "lower",
  "ltrim",
  "nullif",
  "replace",
  "rtrim",
  "substr",
  "substring",
  "trim",
  "typeof",
  "unicode",
  "upper",
]);

const ordinaryDdl = (
  s: Sqlite3Static,
  events: readonly Authorization[],
  fresh: ReadonlySet<string>,
  existing: ReadonlySet<string>,
): boolean => {
  const c = s.capi;
  const tables = events.filter(
    (e) =>
      e.action === c.SQLITE_CREATE_TABLE &&
      typeof e.first === "string" &&
      !identifierKey(e.first).startsWith("sqlite_") &&
      identifierKey(e.first) !== "d1_migrations",
  );
  const indexes = events.filter((e) => e.action === c.SQLITE_CREATE_INDEX);
  if (tables.length > 1 || (tables.length === 0 && indexes.length !== 1))
    return false;
  const newTables = new Set(tables.map((e) => identifierKey(String(e.first))));
  if (tables.some((e) => existing.has(identifierKey(String(e.first)))))
    return false;
  return events.every((e) => {
    if (e.source !== 0) return false;
    switch (e.action) {
      case c.SQLITE_CREATE_TABLE:
        return (
          e.database === "main" &&
          ((typeof e.first === "string" &&
            newTables.has(identifierKey(e.first))) ||
            (e.first === "sqlite_sequence" && tables.length === 1))
        );
      case c.SQLITE_CREATE_INDEX:
        return (
          e.database === "main" &&
          typeof e.first === "string" &&
          typeof e.second === "string" &&
          !existing.has(identifierKey(e.first)) &&
          (fresh.has(identifierKey(e.second)) ||
            newTables.has(identifierKey(e.second)))
        );
      case c.SQLITE_INSERT:
      case c.SQLITE_UPDATE:
        return e.database === "main" && e.first === "sqlite_master";
      case c.SQLITE_READ:
        return (
          e.database === "main" &&
          typeof e.first === "string" &&
          (e.first === "sqlite_master" ||
            fresh.has(identifierKey(e.first)) ||
            (typeof e.first === "string" &&
              newTables.has(identifierKey(e.first))))
        );
      case c.SQLITE_FUNCTION:
        return typeof e.second === "string" && safeFunctions.has(e.second);
      case c.SQLITE_REINDEX:
        return (
          e.database === "main" &&
          indexes.some((index) => index.first === e.first)
        );
      default:
        return false;
    }
  });
};
interface NativeResult {
  readonly statements: readonly string[];
  readonly trailing: string;
}
interface NativeOptions {
  readonly approved: boolean;
  readonly fresh: Set<string>;
  readonly expected?: readonly string[];
  readonly tracking?: boolean;
  readonly trackingTable?: string;
}

// Both whole files and Wrangler's actual chunks pass through SQLite itself.
// No leading-keyword scanner or "prepare the first statement" shortcut exists.
const nativeReplay = (
  s: Sqlite3Static,
  db: Database,
  sql: string,
  options: NativeOptions,
): NativeResult => {
  const { capi: c, wasm: w } = s;
  const bytes = Buffer.from(sql, "utf8");
  if (bytes.length > maximumFileBytes + 1024 || bytes.includes(0))
    return fail("parse");
  return w.scopedAllocCall(() => {
    const [start, length] = w.scopedAllocCString(sql, true);
    const [ppStmt, ppTail] = w.scopedAllocPtr(2);
    if (ppStmt === undefined || ppTail === undefined) return fail("tooling");
    let position = start;
    let lastEnd = 0;
    const statements: string[] = [];
    while (position < start + length) {
      const existing = schemaNames(db);
      const events: Authorization[] = [];
      const installed = c.sqlite3_set_authorizer(
        db,
        (_, action, first, second, database, source) => {
          events.push({ action, first, second, database, source });
          if (options.approved) return c.SQLITE_OK;
          if (options.tracking)
            return (action === c.SQLITE_INSERT &&
              first === (options.trackingTable ?? "d1_migrations") &&
              database === "main") ||
              (action === c.SQLITE_FUNCTION &&
                typeof second === "string" &&
                second.toLowerCase() === "current_timestamp")
              ? c.SQLITE_OK
              : c.SQLITE_DENY;
          // Dangerous pragmas/ATTACH/etc can act during prepare, so deny them
          // immediately, not merely after collecting authorization events.
          const possible = new Set<number>([
            c.SQLITE_CREATE_TABLE,
            c.SQLITE_CREATE_INDEX,
            c.SQLITE_INSERT,
            c.SQLITE_UPDATE,
            c.SQLITE_READ,
            c.SQLITE_FUNCTION,
            c.SQLITE_REINDEX,
          ]);
          return possible.has(action) ? c.SQLITE_OK : c.SQLITE_DENY;
        },
        0,
      );
      if (installed !== c.SQLITE_OK) return fail("tooling");
      let statement = 0;
      try {
        w.pokePtr(ppStmt, 0);
        w.pokePtr(ppTail, 0);
        const code = c.sqlite3_prepare_v3(
          db,
          position,
          start + length - position,
          0,
          ppStmt,
          ppTail,
        );
        statement = w.peekPtr(ppStmt);
        const tail = w.peekPtr(ppTail);
        if (code !== c.SQLITE_OK)
          return fail(code === c.SQLITE_AUTH ? "policy" : "parse");
        if (tail <= position || tail > start + length) return fail("parse");
        position = tail;
        if (statement === 0) continue;
        if (
          statements.length >= maximumStatements ||
          c.sqlite3_stmt_isexplain(statement) !== 0
        )
          return fail("policy");
        const parsed = normalized(c.sqlite3_sql(statement));
        if (
          options.expected !== undefined &&
          parsed !== options.expected[statements.length]
        )
          return fail("parse");
        if (
          !options.approved &&
          !options.tracking &&
          !ordinaryDdl(s, events, options.fresh, existing)
        )
          return fail("policy");
        if (c.sqlite3_bind_parameter_count(statement) !== 0)
          return fail("policy");
        // Keep the authorizer active through step (automatic reprepare included).
        let step = c.sqlite3_step(statement);
        // Approved runtime SELECT 1 may return a row; drain, checking every code.
        if (options.approved)
          while (step === c.SQLITE_ROW) step = c.sqlite3_step(statement);
        if (step !== c.SQLITE_DONE) return fail("replay");
        for (const event of events)
          if (
            event.action === c.SQLITE_CREATE_TABLE &&
            typeof event.first === "string"
          )
            options.fresh.add(identifierKey(event.first));
        statements.push(parsed);
        lastEnd = position - start;
      } finally {
        if (statement !== 0) c.sqlite3_finalize(statement);
        // The declarations model only a callback, but this zero-returning
        // callback safely clears restrictions for our own catalog reads/close.
        c.sqlite3_set_authorizer(db, () => c.SQLITE_OK, 0);
      }
    }
    if (
      options.expected !== undefined &&
      statements.length !== options.expected.length
    )
      return fail("parse");
    return { statements, trailing: bytes.subarray(lastEnd).toString("utf8") };
  });
};

export interface SqliteMigrationSource {
  readonly path: string;
  readonly bytes: Uint8Array;
}
export interface SqliteMigrationReport {
  readonly migrations: number;
  readonly statements: number;
}
export const checkSqliteMigrationSources = async (
  migrations: readonly SqliteMigrationSource[],
): Promise<SqliteMigrationReport> => {
  if (migrations.length === 0 || migrations.length > maximumFiles)
    return fail("layout");
  let totalBytes = 0;
  for (const migration of migrations) {
    totalBytes += migration.bytes.length;
    if (
      migration.bytes.length > maximumFileBytes ||
      totalBytes > maximumTotalBytes
    )
      return fail("layout");
  }
  const s = await sqlite();
  const wholeDb = new s.oo1.DB(":memory:");
  const runnerDb = new s.oo1.DB(":memory:");
  let count = 0;
  try {
    wholeDb.exec("PRAGMA foreign_keys=ON");
    runnerDb.exec(
      "PRAGMA foreign_keys=ON; CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)",
    );
    const seen = new Set<string>();
    for (const migration of migrations) {
      if (
        seen.has(migration.path) ||
        !/^apps\/forum\/migrations\/(?:0000_runtime|\d{14}_[a-z0-9_]+)\.sql$/u.test(
          migration.path,
        )
      )
        return fail("layout");
      seen.add(migration.path);
      const source = decode(migration.bytes);
      const isApproved =
        approved.get(migration.path) === digest(migration.bytes);
      // A changed approved file must never fall back to the generic DDL policy.
      if (approved.has(migration.path) && !isApproved) return fail("policy");
      const result = nativeReplay(s, wholeDb, source, {
        approved: isApproved,
        fresh: new Set(),
      });
      if (result.statements.length === 0) return fail("policy");
      count += result.statements.length;
      if (count > maximumStatements) return fail("policy");
      const filename = migration.path.slice(directory.length + 1);
      // Exact default Wrangler buildMigrationQuery() formatting, including its
      // missing-delimiter and trailing-comment behavior. Names cannot contain '.
      const tracking = `INSERT INTO "d1_migrations" (name)\nvalues ('${filename}');`;
      const expected = [
        ...result.statements,
        normalized(`${result.trailing}\n${tracking}`),
      ];
      const chunks = splitWithWrangler(`${source}\n${tracking}`);
      if (chunks.length !== expected.length) return fail("parse");
      const fresh = new Set<string>();
      for (const [index, chunk] of chunks.entries()) {
        const target = expected[index];
        if (target === undefined) return fail("parse");
        nativeReplay(s, runnerDb, chunk, {
          approved: isApproved,
          fresh,
          expected: [target],
          tracking: index === expected.length - 1,
        });
      }
    }
    if (
      wholeDb.selectValues("PRAGMA foreign_key_check").length !== 0 ||
      runnerDb.selectValues("PRAGMA foreign_key_check").length !== 0 ||
      wholeDb.selectValue("PRAGMA integrity_check") !== "ok" ||
      runnerDb.selectValue("PRAGMA integrity_check") !== "ok"
    )
      return fail("replay");
    return { migrations: migrations.length, statements: count };
  } catch (error) {
    if (error instanceof SqliteMigrationError) throw error;
    return fail("replay");
  } finally {
    wholeDb.close();
    runnerDb.close();
  }
};
export const checkSqliteMigrations = async (
  repositoryRoot: string,
  trustedBase: string,
): Promise<SqliteMigrationReport> => {
  const base = await readGitSqliteMigrationSnapshot(
    repositoryRoot,
    trustedBase,
  );
  checkSqliteMigrationConfiguration(
    await regularFile(join(repositoryRoot, "wrangler.jsonc")),
    process.env.CLOUDFLARE_ENV,
  );
  const current = await readSqliteMigrationSnapshot(repositoryRoot);
  checkSqliteMigrationHistory(base, current);
  const { sqlPaths } = validateSnapshot(current);
  return checkSqliteMigrationSources(
    sqlPaths.map((path) => ({ path, bytes: requiredFile(current, path) })),
  );
};

// Deliberately only frozen protocol v1 is supported. A future operational upgrade
// needs its own reviewed additive protocol/safety support; arbitrary SQL does not
// acquire an exception merely by living in the operational directory.
export const checkOperationalMigrations = async (
  root: string,
  base: string,
): Promise<SqliteMigrationReport> => {
  const directory = "scripts/delivery/control-migrations";
  const path = `${directory}/${CONTROL_FILE}`;
  for (const part of ["scripts", "scripts/delivery", directory])
    if (!(await lstat(join(root, part))).isDirectory()) return fail("layout");
  const names = await readdir(join(root, directory));
  if (names.length !== 1 || names[0] !== CONTROL_FILE) return fail("layout");
  const bytes = await regularFile(join(root, path));
  if (digest(bytes) !== CONTROL_V1_SHA256) return fail("history");
  if (!/^[a-f0-9]{40}$/.test(base)) return fail("history");
  await git(root, ["merge-base", "--is-ancestor", base, "HEAD"]);
  const tree = (
    await git(root, ["ls-tree", "-rz", "--full-tree", base, "--", directory])
  ).toString("utf8");
  const entries = tree.split("\0").filter(Boolean);
  if (entries.length) {
    if (
      entries.length !== 1 ||
      !new RegExp(`^100644 blob [a-f0-9]{40}\\t${path}$`).test(entries[0] ?? "")
    )
      return fail("history");
    if (digest(await git(root, ["show", `${base}:${path}`])) !== digest(bytes))
      return fail("history");
  }
  const s = await sqlite();
  const whole = new s.oo1.DB(":memory:");
  const runner = new s.oo1.DB(":memory:");
  try {
    const source = decode(bytes);
    const parsed = nativeReplay(s, whole, source, {
      approved: false,
      fresh: new Set(),
    });
    if (parsed.statements.length !== 1) return fail("policy");
    runner.exec(NATIVE_HISTORY_SQL);
    const tracking = `INSERT INTO "${CONTROL_HISTORY}" (name)\nvalues ('${CONTROL_FILE}');`;
    const chunks = splitWithWrangler(`${source}\n${tracking}`);
    if (chunks.length !== 2) return fail("parse");
    const expected = [
      ...parsed.statements,
      normalized(`${parsed.trailing}\n${tracking}`),
    ];
    for (const [index, chunk] of chunks.entries()) {
      const statement = expected[index];
      if (!statement) return fail("parse");
      nativeReplay(s, runner, chunk, {
        approved: false,
        fresh: new Set(),
        expected: [statement],
        tracking: index === 1,
        trackingTable: CONTROL_HISTORY,
      });
    }
    if (
      whole.selectValue("PRAGMA integrity_check") !== "ok" ||
      runner.selectValue("PRAGMA integrity_check") !== "ok" ||
      runner.selectValue(`SELECT count(*) FROM ${CONTROL_HISTORY}`) !== 1
    )
      return fail("replay");
    return { migrations: 1, statements: 1 };
  } finally {
    whole.close();
    runner.close();
  }
};

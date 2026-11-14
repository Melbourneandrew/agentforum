import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Context, Data, Effect, Layer, Schema } from "effect";
import { parse } from "libpg-query";
import { ownedProcess } from "./owned-process.js";

export class MigrationSafetyError extends Data.TaggedError(
  "MigrationSafetyError",
)<{
  readonly stage: "layout" | "parse" | "policy" | "history";
}> {}
const failure = (stage: MigrationSafetyError["stage"]) =>
  new MigrationSafetyError({ stage });
const ObjectNode = Schema.Record({ key: Schema.String, value: Schema.Unknown });
const object = (value: unknown): Readonly<Record<string, unknown>> => {
  const decoded = Schema.decodeUnknownEither(ObjectNode)(value);
  return decoded._tag === "Right" ? decoded.right : {};
};
const array = (value: unknown): readonly unknown[] => {
  const decoded = Schema.decodeUnknownEither(Schema.Array(Schema.Unknown))(
    value,
  );
  return decoded._tag === "Right" ? decoded.right : [];
};
const text = (value: unknown) => (typeof value === "string" ? value : "");
const ParsedSql = Schema.Struct({
  version: Schema.Int.pipe(Schema.between(170000, 179999)),
  stmts: Schema.Array(Schema.Struct({ stmt: ObjectNode })).pipe(
    Schema.maxItems(2000),
  ),
});
export class MigrationSqlParser extends Context.Tag(
  "@agentforum/tooling/MigrationSqlParser",
)<
  MigrationSqlParser,
  {
    readonly parse: (
      sql: string,
    ) => Effect.Effect<
      Schema.Schema.Type<typeof ParsedSql>,
      MigrationSafetyError
    >;
  }
>() {}
export const migrationSqlParserLayer = Layer.succeed(MigrationSqlParser, {
  parse: (sql) =>
    Effect.tryPromise({
      try: () => parse(sql),
      catch: () => failure("parse"),
    }).pipe(
      Effect.flatMap(Schema.decodeUnknown(ParsedSql)),
      Effect.mapError(() => failure("parse")),
    ),
});

// This exact, already-merged bootstrap file seeds ONE counter row and installs
// immutable-Post triggers. It is not a general DML/function/trigger exception.
// A rename, byte change, copied statement or new annotation cannot reuse it.
const bootstrapFile = "0002_post_immutability.sql";
const bootstrapHash =
  "aace913f8690d0351692aab0c8a3aebe8e9a0640f3a01f6c2e0ec0a021fcb7d5";
const digest = (source: string) =>
  createHash("sha256").update(source).digest("hex");
// Preserve absent qualification: an unqualified CREATE follows the origin's
// search_path, which is not necessarily public. Never grant fresh-table rights
// to a separately schema-qualified existing relation on that assumption.
const relationName = (value: unknown) => {
  const relation = object(value);
  const name = text(relation.relname);
  return name ? JSON.stringify([text(relation.schemaname), name]) : "";
};
const builtInTypes = new Set([
  "text",
  "varchar",
  "bpchar",
  "int2",
  "int4",
  "int8",
  "numeric",
  "bool",
  "json",
  "jsonb",
  "timestamp",
  "timestamptz",
  "date",
  "time",
  "timetz",
  "float4",
  "float8",
  "uuid",
  "bytea",
  "interval",
]);
const builtInType = (value: unknown) => {
  const names = array(object(value).names).map((node) =>
    text(object(object(node).String).sval),
  );
  return (
    (names.length === 1 || (names.length === 2 && names[0] === "pg_catalog")) &&
    builtInTypes.has(names.at(-1) ?? "")
  );
};
const constant = (value: unknown): boolean => {
  const node = object(value);
  if (Object.keys(node).length !== 1) return false;
  if ("A_Const" in node) return true;
  if ("TypeCast" in node) {
    const cast = object(node.TypeCast);
    return builtInType(cast.typeName) && constant(cast.arg);
  }
  return false;
};
const nonNullConstant = (value: unknown): boolean => {
  const node = object(value);
  if ("TypeCast" in node) return nonNullConstant(object(node.TypeCast).arg);
  return "A_Const" in node && object(node.A_Const).isnull !== true;
};
const additiveColumn = (value: unknown) => {
  const column = object(object(value).ColumnDef);
  if (!text(column.colname) || !builtInType(column.typeName)) return false;
  const constraints = array(column.constraints).map((node) =>
    object(object(node).Constraint),
  );
  const defaults = constraints.filter(
    (constraint) => constraint.contype === "CONSTR_DEFAULT",
  );
  return constraints.every((constraint) => {
    switch (constraint.contype) {
      case "CONSTR_NULL":
        return true;
      case "CONSTR_DEFAULT":
        return constant(constraint.raw_expr);
      case "CONSTR_NOTNULL":
        return defaults.length === 1 && nonNullConstant(defaults[0]?.raw_expr);
      default:
        return false;
    }
  });
};
const allowedStatement = (
  statement: Readonly<Record<string, unknown>>,
  fresh: Set<string>,
) => {
  if (Object.keys(statement).length !== 1) return false;
  if ("CreateStmt" in statement) {
    const node = object(statement.CreateStmt);
    const relation = object(node.relation);
    const name = relationName(relation);
    if (
      !name ||
      fresh.has(name) ||
      relation.relpersistence !== "p" ||
      node.if_not_exists === true ||
      node.inhRelations !== undefined ||
      node.partspec !== undefined ||
      node.partbound !== undefined ||
      node.ofTypename !== undefined ||
      array(node.tableElts).length === 0
    )
      return false;
    fresh.add(name);
    return true;
  }
  if ("IndexStmt" in statement) {
    const node = object(statement.IndexStmt);
    // drizzle-kit migrates inside a transaction: CONCURRENTLY cannot run here.
    // Blocking index builds are allowed only on tables created in THIS file.
    return (
      fresh.has(relationName(node.relation)) &&
      node.concurrent !== true &&
      node.if_not_exists !== true
    );
  }
  if ("AlterTableStmt" in statement) {
    const node = object(statement.AlterTableStmt);
    const commands = array(node.cmds);
    return (
      node.objtype === "OBJECT_TABLE" &&
      relationName(node.relation) !== "" &&
      commands.length > 0 &&
      commands.every((value) => {
        const command = object(object(value).AlterTableCmd);
        if (command.subtype === "AT_AddColumn") {
          return (
            fresh.has(relationName(node.relation)) ||
            additiveColumn(command.def)
          );
        }
        return (
          command.subtype === "AT_AddConstraint" &&
          fresh.has(relationName(node.relation))
        );
      })
    );
  }
  if ("CreateExtensionStmt" in statement) {
    const node = object(statement.CreateExtensionStmt);
    return (
      node.extname === "pg_trgm" &&
      node.if_not_exists === true &&
      array(node.options).length === 0
    );
  }
  // No SQL escape hatches: DML/CTEs, DO/CALL, procedures, trigger changes,
  // renames/drops, arbitrary extensions, SET/transaction commands and unknown
  // statements all require a separately reviewed operational/contract phase.
  return false;
};
export const checkMigrationSql = (filename: string, sql: string) =>
  Effect.gen(function* () {
    yield* Effect.filterOrFail(
      Effect.succeed(sql),
      (source) =>
        Buffer.byteLength(source, "utf8") <= 1024 * 1024 &&
        !source.includes("\0"),
      () => failure("parse"),
    );
    const parser = yield* MigrationSqlParser;
    const whole = yield* parser.parse(sql);
    yield* Effect.filterOrFail(
      Effect.succeed(whole),
      (value) => value.stmts.length > 0,
      () => failure("policy"),
    );
    if (filename === bootstrapFile && digest(sql) === bootstrapHash) return;
    // The pinned Drizzle migrator splits this literal marker even INSIDE SQL
    // comments and strings. Validate what it executes, not just the whole AST.
    const chunks = sql.split("--> statement-breakpoint");
    yield* Effect.filterOrFail(
      Effect.succeed(chunks),
      (value) => value.length <= 2000,
      () => failure("policy"),
    );
    const fresh = new Set<string>();
    let count = 0;
    for (const chunk of chunks) {
      if (/^[ \t\n\r\f\v]*$/u.test(chunk)) continue;
      const parsed = yield* parser.parse(chunk);
      count += parsed.stmts.length;
      yield* Effect.filterOrFail(
        Effect.succeed(parsed),
        (value) =>
          count <= 2000 &&
          value.stmts.every(({ stmt }) => allowedStatement(stmt, fresh)),
        () => failure("policy"),
      );
    }
  });

const Entry = Schema.Struct({
  idx: Schema.Int.pipe(Schema.nonNegative()),
  version: Schema.Literal("7"),
  when: Schema.Int.pipe(Schema.positive()),
  tag: Schema.String.pipe(Schema.pattern(/^\d{4}_[a-z0-9_]+$/)),
  breakpoints: Schema.Literal(true),
});
const Journal = Schema.parseJson(
  Schema.Struct({
    version: Schema.Literal("7"),
    dialect: Schema.Literal("postgresql"),
    entries: Schema.Array(Entry).pipe(
      Schema.minItems(1),
      Schema.maxItems(1000),
    ),
  }),
);
export interface MigrationSnapshot {
  readonly entries: readonly Schema.Schema.Type<typeof Entry>[];
  readonly files: ReadonlyMap<string, string>;
}
const decodeJournal = (source: string) => {
  const journal = Schema.decodeUnknownSync(Journal)(source, {
    onExcessProperty: "error",
  });
  if (
    !journal.entries.every(
      (entry, index) =>
        entry.idx === index &&
        entry.tag.startsWith(`${String(index).padStart(4, "0")}_`) &&
        (index === 0 ||
          entry.when > (journal.entries[index - 1]?.when ?? Infinity)),
    )
  )
    throw failure("layout");
  return journal.entries;
};
const paths = (entry: Schema.Schema.Type<typeof Entry>) => [
  `${entry.tag}.sql`,
  `meta/${String(entry.idx).padStart(4, "0")}_snapshot.json`,
];
const boundedFile = async (path: string) => {
  const info = await lstat(path);
  if (!info.isFile() || info.size > 1024 * 1024) throw failure("layout");
  const bytes = await readFile(path);
  if (bytes.length > 1024 * 1024) throw failure("layout");
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    bytes,
  );
};
export const readMigrationSnapshot = (directory: string) =>
  Effect.tryPromise({
    try: async (): Promise<MigrationSnapshot> => {
      if (
        !(await lstat(directory)).isDirectory() ||
        !(await lstat(join(directory, "meta"))).isDirectory()
      )
        throw failure("layout");
      const entries = decodeJournal(
        await boundedFile(join(directory, "meta/_journal.json")),
      );
      const expected = entries.flatMap(paths);
      const actual = [
        ...(await readdir(directory)).filter((name) => name !== "meta"),
        ...(await readdir(join(directory, "meta")))
          .filter((name) => name !== "_journal.json")
          .map((name) => `meta/${name}`),
      ];
      if (
        actual.length !== expected.length ||
        actual.some((path) => !expected.includes(path))
      )
        throw failure("layout");
      const files = new Map<string, string>();
      for (const path of expected)
        files.set(path, await boundedFile(join(directory, path)));
      return { entries, files };
    },
    catch: () => failure("layout"),
  });
export const checkMigrationSnapshot = (snapshot: MigrationSnapshot) =>
  Effect.forEach(
    snapshot.entries,
    (entry) => {
      const filename = `${entry.tag}.sql`;
      const sql = snapshot.files.get(filename);
      return sql === undefined
        ? Effect.fail(failure("layout"))
        : checkMigrationSql(filename, sql);
    },
    { discard: true },
  );
export const checkMigrationDirectory = (directory: string) =>
  readMigrationSnapshot(directory).pipe(Effect.flatMap(checkMigrationSnapshot));

const Commit = Schema.String.pipe(Schema.pattern(/^[0-9a-f]{40}$/));
const gitOutput = (args: readonly string[]) =>
  Effect.scoped(
    Effect.gen(function* () {
      const lease = yield* ownedProcess("git", args, {
        output: "capture",
        environment: {},
      });
      const result = yield* Effect.promise(() => lease.completion).pipe(
        Effect.timeoutFail({
          duration: "10 seconds",
          onTimeout: () => failure("history"),
        }),
      );
      yield* Effect.filterOrFail(
        Effect.succeed(result),
        (value) => value.code === 0 && !value.overflow,
        () => failure("history"),
      );
      return result.stdout;
    }),
  );
export const migrationBaseCommit = (args: readonly string[]) =>
  Effect.gen(function* () {
    yield* Effect.filterOrFail(
      Effect.succeed(args),
      (value) => value.length <= 1,
      () => failure("history"),
    );
    const source =
      args.length === 0
        ? yield* gitOutput(["rev-parse", "--verify", "origin/main^{commit}"])
        : args[0];
    return yield* Schema.decodeUnknown(Commit)(source?.trim()).pipe(
      Effect.mapError(() => failure("history")),
    );
  });
export const readGitMigrationSnapshot = (base: string) =>
  Effect.gen(function* () {
    const commit = yield* Schema.decodeUnknown(Commit)(base).pipe(
      Effect.mapError(() => failure("history")),
    );
    const journal = yield* gitOutput([
      "show",
      `${commit}:apps/api/migrations/meta/_journal.json`,
    ]);
    const entries = yield* Effect.try({
      try: () => decodeJournal(journal),
      catch: () => failure("history"),
    });
    const files = new Map<string, string>();
    for (const entry of entries)
      for (const path of paths(entry)) {
        files.set(
          path,
          yield* gitOutput(["show", `${commit}:apps/api/migrations/${path}`]),
        );
      }
    return { entries, files } satisfies MigrationSnapshot;
  });
export const checkMigrationHistory = (
  base: MigrationSnapshot,
  current: MigrationSnapshot,
) =>
  Effect.filterOrFail(
    Effect.void,
    () =>
      current.entries.length >= base.entries.length &&
      base.entries.every(
        (entry, index) =>
          JSON.stringify(entry) === JSON.stringify(current.entries[index]),
      ) &&
      [...base.files].every(
        ([path, source]) => current.files.get(path) === source,
      ),
    () => failure("history"),
  );

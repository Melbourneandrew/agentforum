import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { Effect, Schema } from "effect";
import { parse, type ParseError } from "jsonc-parser";
import { Identity, Journal, failure } from "./model.js";
import { Artifact, Revision } from "./release-model.js";

const Dictionary = Schema.Record({ key: Schema.String, value: Schema.Unknown });
const Binding = Schema.Struct({
  binding: Schema.Literal("DB"),
  database_name: Schema.String,
  database_id: Schema.optional(Schema.String),
  migrations_dir: Schema.String,
});
const Config = Schema.Struct({
  name: Schema.String,
  main: Schema.String,
  compatibility_date: Schema.String.pipe(Schema.pattern(/^\d{4}-\d{2}-\d{2}$/)),
  compatibility_flags: Schema.Array(Schema.String),
  no_bundle: Schema.Literal(true),
  workers_dev: Schema.Boolean,
  preview_urls: Schema.Boolean,
  vars: Dictionary,
  assets: Schema.Struct({
    directory: Schema.String,
    binding: Schema.Literal("ASSETS"),
    run_worker_first: Schema.Array(Schema.String),
  }),
  d1_databases: Schema.Array(Binding),
  secrets: Schema.Struct({ required: Schema.Array(Schema.String) }),
  observability: Dictionary,
});
const NativeConfig = Schema.Struct({
  name: Schema.String,
  account_id: Schema.optional(Schema.String),
  d1_databases: Schema.Array(Binding),
});
const Context = Schema.Struct({
  accountId: Identity.fields.accountId,
  defaultOrigin: Identity.fields.defaultOrigin,
});
export const decodeConfig = (text: string) =>
  Effect.try({
    try: () => {
      const errors: ParseError[] = [];
      const value: unknown = parse(text, errors, { allowTrailingComma: true });
      if (errors.length) throw new Error("invalid JSONC");
      return value;
    },
    catch: () => failure("configuration", "invalid-wrangler-jsonc"),
  });
const oneBinding = (bindings: readonly (typeof Binding.Type)[]) =>
  bindings.length === 1 && bindings[0]?.binding === "DB"
    ? bindings[0]
    : undefined;
// Distinct adapters: native consumes provider-resolved config; CLI consumes the
// existing WO-33 journal. Neither creates a resource, guesses a name or reads auth.
export const nativeIdentity = (config: unknown, context: unknown) =>
  Effect.gen(function* () {
    const raw = yield* Schema.decodeUnknown(NativeConfig)(config).pipe(
      Effect.mapError(() => failure("configuration", "native-config-invalid")),
    );
    const owner = yield* Schema.decodeUnknown(Context)(context, {
      onExcessProperty: "error",
    }).pipe(
      Effect.mapError(() =>
        failure("configuration", "native-context-unproven"),
      ),
    );
    const binding = oneBinding(raw.d1_databases);
    if (
      !binding?.database_id ||
      (raw.account_id !== undefined && raw.account_id !== owner.accountId)
    )
      return yield* Effect.fail(
        failure("configuration", "native-resolved-identity-required"),
      );
    const identity = yield* Schema.decodeUnknown(Identity)({
      version: 1,
      accountId: owner.accountId,
      workerName: raw.name,
      databaseName: binding.database_name,
      databaseId: binding.database_id,
      defaultOrigin: owner.defaultOrigin,
    }).pipe(
      Effect.mapError(() =>
        failure("configuration", "native-identity-invalid"),
      ),
    );
    if (
      !new URL(identity.defaultOrigin).hostname.startsWith(
        `${identity.workerName}.`,
      )
    )
      return yield* Effect.fail(
        failure("configuration", "native-origin-worker-mismatch"),
      );
    return identity;
  });
export const cliIdentity = (input: unknown) =>
  Schema.decodeUnknown(Journal)(input, { onExcessProperty: "error" }).pipe(
    Effect.mapError(() => failure("configuration", "retained-journal-invalid")),
    Effect.flatMap((journal) =>
      journal.state === "resolved"
        ? Effect.succeed(journal.identity)
        : Effect.fail(failure("configuration", "retained-identity-unresolved")),
    ),
  );
const digest = (data: string | Uint8Array) =>
  createHash("sha256").update(data).digest("hex");
export const schemaDigest = (
  migrations: readonly { readonly name: string; readonly digest: string }[],
) => digest(JSON.stringify(migrations));
const confined = (root: string, path: string) => {
  const value = relative(root, path);
  return (
    value === "" ||
    (!isAbsolute(value) && value !== ".." && !value.startsWith(`..${sep}`))
  );
};
const files = (directory: string): string[] => {
  if (
    realpathSync(directory) !== resolve(directory) ||
    lstatSync(directory).isSymbolicLink()
  )
    throw new Error("symlink");
  return readdirSync(directory)
    .sort()
    .flatMap((name) => {
      const path = resolve(directory, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error("symlink");
      if (stat.isDirectory()) return files(path);
      if (!stat.isFile()) throw new Error("not a file");
      return [path];
    });
};
export const prepareTarget = (input: {
  readonly raw: unknown;
  readonly builtConfig: string;
  readonly output: string;
  readonly identity: Identity;
  readonly sourceRevision: string;
  readonly authorizeTarget: boolean;
}) =>
  Effect.gen(function* () {
    if (!input.authorizeTarget)
      return yield* Effect.fail(
        failure("authorization", "execution-target-not-authorized"),
      );
    const identity = yield* Schema.decodeUnknown(Identity)(input.identity).pipe(
      Effect.mapError(() => failure("configuration", "identity-invalid")),
    );
    const revision = yield* Schema.decodeUnknown(Revision)(
      input.sourceRevision,
    ).pipe(
      Effect.mapError(() =>
        failure("configuration", "source-revision-required"),
      ),
    );
    const raw = yield* Schema.decodeUnknown(Dictionary)(input.raw).pipe(
      Effect.mapError(() => failure("configuration", "built-config-invalid")),
    );
    const config = yield* Schema.decodeUnknown(Config)(raw).pipe(
      Effect.mapError(() =>
        failure("configuration", "complete-built-config-required"),
      ),
    );
    const db = oneBinding(config.d1_databases);
    if (
      !db ||
      config.secrets.required.length ||
      config.preview_urls ||
      !config.assets.run_worker_first.includes("/v1/*") ||
      !config.assets.run_worker_first.includes("/v1") ||
      !config.compatibility_flags.includes("nodejs_compat")
    )
      return yield* Effect.fail(
        failure("configuration", "complete-target-contract-invalid"),
      );
    if (
      (db.database_id !== undefined &&
        db.database_id !== identity.databaseId) ||
      (raw.account_id !== undefined && raw.account_id !== identity.accountId)
    )
      return yield* Effect.fail(
        failure("configuration", "built-target-identity-conflict"),
      );
    // These unsupported path-bearing extensions need a deliberate integration,
    // not silent relocation of a partially working config.
    if (
      raw.site !== undefined ||
      raw.build !== undefined ||
      raw.base_dir !== undefined ||
      raw.tsconfig !== undefined ||
      raw.env !== undefined
    )
      return yield* Effect.fail(
        failure("configuration", "unsupported-build-path-extension"),
      );
    const base = dirname(resolve(input.builtConfig));
    const main = resolve(base, config.main);
    const assets = resolve(base, config.assets.directory);
    const migrations = resolve(base, db.migrations_dir);
    const output = resolve(input.output);
    if (
      output === resolve(input.builtConfig) ||
      confined(base, output) ||
      confined(assets, output) ||
      confined(migrations, output)
    )
      return yield* Effect.fail(
        failure("configuration", "execution-config-must-not-overwrite-build"),
      );
    const rawAssets = yield* Schema.decodeUnknown(Dictionary)(raw.assets).pipe(
      Effect.mapError(() => failure("configuration", "assets-invalid")),
    );
    const rawBindings = yield* Schema.decodeUnknown(Schema.Array(Dictionary))(
      raw.d1_databases,
    ).pipe(Effect.mapError(() => failure("configuration", "bindings-invalid")));
    const rawBinding = rawBindings[0];
    if (!rawBinding)
      return yield* Effect.fail(failure("configuration", "binding-missing"));
    if (
      config.vars.CANONICAL_ORIGIN !== undefined &&
      config.vars.CANONICAL_ORIGIN !== identity.defaultOrigin
    )
      return yield* Effect.fail(
        failure("configuration", "canonical-origin-conflict"),
      );
    if (
      rawBinding.migrations_pattern !== undefined ||
      (rawBinding.migrations_table !== undefined &&
        rawBinding.migrations_table !== "d1_migrations")
    )
      return yield* Effect.fail(
        failure("configuration", "unsupported-migration-history-layout"),
      );
    if (
      !new URL(identity.defaultOrigin).hostname.startsWith(
        `${identity.workerName}.`,
      )
    )
      return yield* Effect.fail(
        failure("configuration", "identity-origin-worker-mismatch"),
      );
    const target = {
      ...raw,
      name: identity.workerName,
      account_id: identity.accountId,
      main,
      workers_dev: true,
      vars: { ...config.vars, CANONICAL_ORIGIN: identity.defaultOrigin },
      assets: { ...rawAssets, directory: assets },
      d1_databases: [
        {
          ...rawBinding,
          binding: "DB",
          database_name: identity.databaseName,
          database_id: identity.databaseId,
          migrations_dir: migrations,
        },
      ],
    };
    const contents = yield* Effect.try({
      try: () => {
        if (
          realpathSync(resolve(input.builtConfig)) !==
            resolve(input.builtConfig) ||
          realpathSync(dirname(output)) !== dirname(output) ||
          lstatSync(output, { throwIfNoEntry: false }) !== undefined ||
          !confined(base, main) ||
          !confined(resolve(base, ".."), assets) ||
          !confined(resolve(base, "../.."), migrations)
        )
          throw new Error("unsafe artifact path");
        const workerFiles = files(base).filter(
          (path) => path.endsWith(".js") || path.endsWith(".mjs"),
        );
        if (
          !workerFiles.includes(main) ||
          !lstatSync(main).isFile() ||
          !files(assets).length
        )
          throw new Error("incomplete bundle");
        const migrationFiles = files(migrations).filter((path) =>
          path.endsWith(".sql"),
        );
        if (
          !migrationFiles.length ||
          migrationFiles.some((path) => dirname(path) !== migrations)
        )
          throw new Error("missing or nested migrations");
        const migrationHistory = migrationFiles.map((path) => ({
          name: relative(migrations, path),
          digest: digest(readFileSync(path)),
        }));
        const fingerprints = [
          ...workerFiles,
          ...files(assets),
          ...migrationFiles,
        ].map((path) => [path, digest(readFileSync(path))]);
        return {
          migrationHistory,
          artifactDigest: digest(JSON.stringify({ target, fingerprints })),
        };
      },
      catch: () => failure("build", "complete-artifact-unreadable"),
    });
    const artifact = yield* Schema.decodeUnknown(Artifact)({
      identity,
      sourceRevision: revision,
      configPath: output,
      artifactDigest: contents.artifactDigest,
      schemaDigest: schemaDigest(contents.migrationHistory),
      migrations: contents.migrationHistory,
      compatibleSchemas: [],
    }).pipe(Effect.mapError(() => failure("build", "artifact-invalid")));
    return { target, artifact };
  });

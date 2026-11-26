import {
  DiagnosticEnvironment,
  ownerBuild,
  buildProcessLive,
} from "../../apps/forum/scripts/owner-build.js";
// Supported parent-executor ABI. The authority service is supplied directly by
// the trusted execution boundary, never decoded from CLI/JSON/env/files. Source,
// account, exact retained identity, operation and grants precede secret access.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Context, Effect, Option, Schema } from "effect";
import { Identity, failure, type DeliveryError } from "./model.js";
import { Revision } from "./release-model.js";
import {
  ExecutorRef,
  CONTROL_FILE,
  CONTROL_HISTORY,
  CONTROL_V1_SHA256,
  hashControl,
  sameIdentity,
} from "./release-control.js";
import { ownerEntryAuthorization } from "./owner-handoff.js";
import { cloudflare } from "./provider.js";
import { remoteProvider } from "./remote-provider.js";
import { decodeConfig, prepareTarget } from "./release-config.js";
import { authorizeZoneTarget, ZoneGrant } from "./zone-authority.js";
import { physicalStates } from "./remote-state.js";
import { remotePorts } from "./remote-release.js";
import {
  entryCommand,
  EntryAdapters,
  EntryAuthorization,
  type EntryInput,
} from "./release-entry-command.js";
const Scope = Schema.Struct({
  repository: Schema.NonEmptyString,
  journalPath: Schema.NonEmptyString,
  identity: Identity,
  sourceRevision: Revision,
  diagnosticEnvironment: Schema.optional(DiagnosticEnvironment),
  executorRef: ExecutorRef,
  operation: Schema.Literal("update", "recover"),
  zoneGrants: Schema.optional(Schema.Array(ZoneGrant)),
  grants: Schema.Array(
    Schema.Literal("d1:read", "d1:write", "worker:read", "worker:deploy"),
  ),
});
export type OwnerScope = typeof Scope.Type;
export class ParentExecution extends Context.Tag("delivery/ParentExecution")<
  ParentExecution,
  {
    // Parent establishes authority from its actual approved execution context.
    // A successful provider GET or token permissions never supplies these grants.
    readonly authorize: (
      input: EntryInput,
    ) => Effect.Effect<OwnerScope, DeliveryError>;
    readonly credential: Effect.Effect<string, DeliveryError>;
  }
>() {}
export const deniedParentExecution: typeof ParentExecution.Service = {
  authorize: () =>
    Effect.fail(
      failure("authorization", "owner-execution-authorization-unconfigured"),
    ),
  credential: Effect.fail(
    failure("authorization", "secure-parent-credential-handoff-required"),
  ),
};
// Fixed local commands and pinned native Wrangler only. No shell interpolation,
// inherited token, dotenv, login, global HOME or generic provider-command hook.
const command = (
  file: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  stage: "build" | "deployment",
) =>
  Effect.tryPromise({
    try: () =>
      new Promise<string>((success, reject) => {
        execFile(
          file,
          [...args],
          {
            cwd,
            env,
            timeout: 120_000,
            maxBuffer: 8 * 1024 * 1024,
            encoding: "utf8",
          },
          (error, stdout) => {
            if (error) reject(new Error("executor-outcome-unverified"));
            else success(stdout);
          },
        );
      }),
    catch: () => failure(stage, "executor-outcome-unknown"),
  });
const io = <A>(use: () => Promise<A>) =>
  Effect.tryPromise({
    try: use,
    catch: () => failure("build", "owner-artifact-io-failed"),
  });

// Programmatic CLI admission for the authorized parent (same entryCommand and
// lifecycle, not a second deployment owner). Standalone CLI receives the denied
// service. Parent invokes this in its own executor with its supported authority
// service and a lazy credential effect; children cannot mint a CLI JSON grant.
export const ownerReleaseCommand = (args: readonly string[]) =>
  Effect.gen(function* () {
    const parent = yield* ParentExecution;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const state = yield* Effect.acquireRelease(
          io(() => mkdtemp(join(tmpdir(), "agentforum-owner-"))),
          (path) =>
            io(() => rm(path, { recursive: true, force: true })).pipe(
              Effect.orDie,
            ),
        );
        const env = {
          PATH: process.env.PATH ?? "",
          HOME: state,
          XDG_CONFIG_HOME: state,
          CI: "true",
          CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
          WRANGLER_SEND_METRICS: "false",
          WRANGLER_LOG_PATH: join(state, "wrangler.log"),
          WRANGLER_RESOURCES_PROVISION: "false",
        };
        let scope = Option.none<OwnerScope>();
        let token = Option.none<string>();
        let built =
          Option.none<
            Effect.Effect.Success<ReturnType<typeof prepareTarget>>
          >();
        const prepare = (context: OwnerScope, output: string) => {
          const builtConfig = join(
            context.repository,
            "apps/forum/dist/server/wrangler.json",
          );
          return io(() => readFile(builtConfig, "utf8")).pipe(
            Effect.flatMap(decodeConfig),
            Effect.tap((raw) =>
              authorizeZoneTarget(raw, context.zoneGrants ?? []),
            ),
            Effect.flatMap((raw) =>
              prepareTarget({
                raw,
                builtConfig,
                output,
                identity: context.identity,
                sourceRevision: context.sourceRevision,
                authorizeTarget: true,
              }),
            ),
          );
        };
        const source = (context: OwnerScope) =>
          Effect.gen(function* () {
            const root = yield* io(() => realpath(context.repository));
            if (
              root !== resolve(context.repository) ||
              resolve(context.journalPath) !== context.journalPath
            )
              return yield* Effect.fail(
                failure("authorization", "parent-execution-path-mismatch"),
              );
            const revision = yield* command(
              "git",
              ["rev-parse", "HEAD"],
              root,
              env,
              "build",
            );
            const status = yield* command(
              "git",
              ["status", "--porcelain=v1", "--untracked-files=normal"],
              root,
              env,
              "build",
            );
            if (revision.trim() !== context.sourceRevision || status !== "")
              return yield* Effect.fail(
                failure("authorization", "parent-source-context-mismatch"),
              );
          });
        const open = Effect.suspend(() => {
          if (Option.isNone(scope))
            return Effect.fail(
              failure("authorization", "parent-scope-not-admitted"),
            );
          const context = scope.value;
          return Effect.gen(function* () {
            yield* source(context);
            // Exactly one fresh complete build, before ANY credential access or
            // provider construction. Journal/source identity is already checked.
            yield* ownerBuild(
              {
                version: 1,
                repository: context.repository,
                revision: context.sourceRevision,
                metadata:
                  context.diagnosticEnvironment === undefined
                    ? null
                    : {
                        environment: context.diagnosticEnvironment,
                        revision: context.sourceRevision,
                      },
              },
              env,
            ).pipe(Effect.provide(buildProcessLive));
            yield* source(context);
            const prepared = yield* prepare(
              context,
              join(state, "target.json"),
            );
            built = Option.some(prepared);
          }).pipe(
            Effect.zipRight(parent.credential),
            Effect.flatMap((value) => {
              if (
                !value.trim() ||
                value.trim() !== value ||
                /[\r\n]/.test(value)
              )
                return Effect.fail(
                  failure("authorization", "secure-parent-credential-invalid"),
                );
              token = Option.some(value);
              return Effect.succeed(cloudflare(fetch, value));
            }),
          );
        });
        const authorization: typeof EntryAuthorization.Service = {
          admit: (input) =>
            Effect.gen(function* () {
              if (input.mode !== "cli")
                return yield* Effect.fail(
                  failure(
                    "authorization",
                    "native-authorization-handoff-unproved",
                  ),
                );
              const context = yield* parent.authorize(input).pipe(
                Effect.flatMap((value) =>
                  Schema.decodeUnknown(Scope)(value, {
                    onExcessProperty: "error",
                  }),
                ),
                Effect.mapError(() =>
                  failure(
                    "authorization",
                    "owner-execution-authorization-unconfigured",
                  ),
                ),
              );
              if (
                context.operation !== input.operation ||
                context.journalPath !== resolve(input.inputPath) ||
                (
                  [
                    "d1:read",
                    "d1:write",
                    "worker:read",
                    "worker:deploy",
                  ] as const
                ).some((grant) => !context.grants.includes(grant))
              )
                return yield* Effect.fail(
                  failure("authorization", "parent-execution-scope-mismatch"),
                );
              yield* source(context);
              scope = Option.some(context);
              const admitted = yield* ownerEntryAuthorization(
                context.repository,
                {
                  authorize: () =>
                    Effect.succeed({
                      accountId: context.identity.accountId,
                      identity: context.identity,
                      executorRef: context.executorRef,
                    }),
                  provider: open,
                },
              ).admit(input);
              if (!sameIdentity(admitted.identity, context.identity))
                return yield* Effect.fail(
                  failure("authorization", "parent-retained-identity-mismatch"),
                );
              return admitted;
            }),
        };
        const adapters: typeof EntryAdapters.Service = {
          prepare: (input, admission) =>
            Effect.gen(function* () {
              if (
                Option.isNone(scope) ||
                Option.isNone(token) ||
                Option.isNone(built) ||
                input.mode !== "cli" ||
                !sameIdentity(scope.value.identity, admission.identity)
              )
                return yield* Effect.fail(
                  failure("authorization", "parent-adapters-not-admitted"),
                );
              const context = scope.value,
                credential = token.value;
              yield* source(context);
              const prepared = built.value;
              yield* authorizeZoneTarget(
                prepared.target,
                context.zoneGrants ?? [],
              );
              const binding = prepared.target.d1_databases[0];
              if (!binding)
                return yield* Effect.fail(
                  failure("configuration", "owner-binding-missing"),
                );
              const sources = yield* io(async () =>
                Promise.all(
                  prepared.artifact.migrations.map(async (migration) => ({
                    path: `apps/forum/migrations/${migration.name}`,
                    bytes: await readFile(
                      join(binding.migrations_dir, migration.name),
                    ),
                  })),
                ),
              );
              const states = yield* physicalStates(sources);
              // Recovery cannot infer compatibility from an old prefix. This admitted
              // source is qualified only against its exact fully migrated physical state.
              // A future schema needs separate archived-Worker compatibility qualification.
              const completeState = states.at(-1);
              if (!completeState)
                return yield* Effect.fail(
                  failure("build", "physical-state-required"),
                );
              const artifact = {
                ...prepared.artifact,
                schemaDigest: completeState.physicalDigest,
                compatibleSchemas:
                  input.operation === "recover"
                    ? [completeState.physicalDigest]
                    : [],
              };
              const verify = Effect.gen(function* () {
                yield* source(context);
                const current = yield* prepare(
                  context,
                  join(state, "verify-only.json"),
                );
                if (
                  current.artifact.artifactDigest !== artifact.artifactDigest ||
                  (yield* io(() => readFile(artifact.configPath, "utf8"))) !==
                    JSON.stringify(prepared.target)
                )
                  return yield* Effect.fail(
                    failure("build", "owner-artifact-changed"),
                  );
              });
              yield* io(() =>
                writeFile(
                  artifact.configPath,
                  JSON.stringify(prepared.target),
                  { flag: "wx", mode: 0o600 },
                ),
              );
              const v1 = yield* io(() =>
                readFile(
                  join(
                    context.repository,
                    "scripts/delivery/control-migrations",
                    CONTROL_FILE,
                  ),
                  "utf8",
                ),
              );
              if ((yield* hashControl(v1)) !== CONTROL_V1_SHA256)
                return yield* Effect.fail(
                  failure("initialization", "control-v1-bytes-mismatch"),
                );
              const controlDirectory = join(state, "control-v1");
              // mkdir via filesystem only, never a provider resource creation.
              const directory = yield* io(() =>
                mkdtemp(`${controlDirectory}-`),
              );
              yield* io(() =>
                writeFile(join(directory, CONTROL_FILE), v1, {
                  flag: "wx",
                  mode: 0o600,
                }),
              );
              const controlConfig = join(state, "control.json");
              yield* io(() =>
                writeFile(
                  controlConfig,
                  JSON.stringify({
                    ...prepared.target,
                    d1_databases: [
                      {
                        ...binding,
                        migrations_dir: directory,
                        migrations_table: CONTROL_HISTORY,
                      },
                    ],
                  }),
                  { flag: "wx", mode: 0o600 },
                ),
              );
              const authenticated: typeof fetch = (request, init) => {
                const outgoing = new Request(request, init);
                outgoing.headers.set("Authorization", `Bearer ${credential}`);
                return fetch(outgoing);
              };
              const provider = remoteProvider(
                admission.identity,
                authenticated,
              );
              const native = (args: readonly string[]) =>
                Effect.gen(function* () {
                  yield* verify;
                  const pinned = join(
                    context.repository,
                    "apps/forum/node_modules/wrangler/bin/wrangler.js",
                  );
                  const stat = yield* io(() => lstat(pinned));
                  if (!stat.isFile())
                    return yield* Effect.fail(
                      failure("configuration", "pinned-wrangler-required"),
                    );
                  const operationRef = `native:${randomUUID()}`;
                  const stdout = yield* command(
                    process.execPath,
                    [pinned, ...args],
                    context.repository,
                    {
                      ...env,
                      CLOUDFLARE_API_TOKEN: credential,
                      CLOUDFLARE_ACCOUNT_ID: admission.identity.accountId,
                    },
                    "deployment",
                  );
                  return { stdout, operationRef };
                });
              return {
                artifact,
                ownerId: randomUUID(),
                database: provider.database,
                bootstrap: {
                  v1,
                  applyV1: native([
                    "d1",
                    "migrations",
                    "apply",
                    "DB",
                    "--remote",
                    "--config",
                    controlConfig,
                    "--env-file",
                    "/dev/null",
                  ]).pipe(Effect.asVoid),
                },
                ports: remotePorts({
                  artifact,
                  states,
                  provider,
                  executorRef: admission.executorRef,
                  verify,
                  native,
                  readiness: {
                    request: (request) =>
                      Effect.tryPromise({
                        try: () =>
                          fetch(request, {
                            signal: AbortSignal.timeout(30_000),
                          }),
                        catch: () =>
                          failure("readiness", "owner-readiness-unavailable"),
                      }),
                  },
                }),
              };
            }),
        };
        return yield* entryCommand(args).pipe(
          Effect.provideService(EntryAuthorization, authorization),
          Effect.provideService(EntryAdapters, adapters),
        );
      }),
    );
  });

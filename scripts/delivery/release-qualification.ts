// Trusted local qualification composition, never a CLI/env/assertion-file grant.
// Observations do not supply release authority or unknown-effect quiescence.
import { createHash } from "node:crypto";
import type { SqliteMigrationSource } from "../sqlite-migrations.js";
import { Effect, Option, Schema } from "effect";
import { failure, type DeliveryError } from "./model.js";
import { Artifact, Installed, type ReleasePorts } from "./release-model.js";
import {
  readControl,
  sameIdentity,
  TerminalReceipt,
  type ControlDatabase,
  type EffectToken,
} from "./release-control.js";
import { inspectInstalled, physicalStates } from "./remote-state.js";
import {
  verifyArchive,
  verifyMaterializedArchive,
  type CompleteArchive,
} from "./release-archive.js";

export const stopAfterAcknowledgedMigration = (input: {
  readonly ports: typeof ReleasePorts.Service;
  readonly database: typeof ControlDatabase.Service;
  readonly executorRef: string;
  readonly stopped: Effect.Effect<void, DeliveryError>;
}): typeof ReleasePorts.Service => {
  let migration = Option.none<{
    readonly token: EffectToken;
    readonly receipt: TerminalReceipt;
  }>();
  return {
    ...input.ports,
    build: (request) =>
      input.ports.build(request).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            migration = Option.none();
          }),
        ),
      ),
    migrate: (artifact, token) =>
      input.ports.migrate(artifact, token).pipe(
        Effect.tap((receipt) =>
          Effect.sync(() => {
            migration = Option.some({ token, receipt });
          }),
        ),
      ),
    installed: (artifact) =>
      Effect.gen(function* () {
        const installed = yield* input.ports.installed(artifact).pipe(
          Effect.flatMap(Schema.decodeUnknown(Installed)),
          Effect.mapError(() =>
            failure("initialization", "qualification-readback-unverified"),
          ),
        );
        if (Option.isNone(migration)) return installed;
        const expected = migration.value;
        const current = yield* readControl(input.database);
        if (Option.isNone(current))
          return yield* Effect.fail(
            failure("initialization", "qualification-migration-ack-unverified"),
          );
        const row = current.value;
        const receipt = yield* Option.match(row.effect_receipt_json, {
          onNone: () =>
            Effect.fail(
              failure(
                "initialization",
                "qualification-migration-ack-unverified",
              ),
            ),
          onSome: (json) =>
            Schema.decodeUnknown(Schema.parseJson(TerminalReceipt))(json).pipe(
              Effect.mapError(() =>
                failure(
                  "initialization",
                  "qualification-migration-ack-unverified",
                ),
              ),
            ),
        });
        if (
          expected.token.kind !== "business-migrate" ||
          expected.receipt.outcome !== "succeeded" ||
          receipt.outcome !== "succeeded" ||
          JSON.stringify(receipt) !== JSON.stringify(expected.receipt) ||
          row.phase !== "held" ||
          row.effect_kind !== "business-migrate" ||
          row.effect_state !== "acked" ||
          !Option.contains(row.effect_ref, receipt.operationRef) ||
          !Option.contains(row.owner_id, expected.token.ownerId) ||
          !Option.contains(row.executor_ref, input.executorRef) ||
          row.generation !== expected.token.generation ||
          row.effect_seq !== expected.token.sequence ||
          row.source_revision !== artifact.sourceRevision ||
          row.artifact_sha256 !== artifact.artifactDigest ||
          row.account_id !== artifact.identity.accountId ||
          row.database_id !== artifact.identity.databaseId ||
          row.worker_name !== artifact.identity.workerName ||
          row.default_origin !== artifact.identity.defaultOrigin ||
          !sameIdentity(input.database.identity, artifact.identity) ||
          !sameIdentity(receipt.identity, artifact.identity) ||
          receipt.sourceRevision !== artifact.sourceRevision ||
          receipt.artifactDigest !== artifact.artifactDigest ||
          receipt.kind !== expected.token.kind ||
          receipt.ownerId !== expected.token.ownerId ||
          receipt.generation !== expected.token.generation ||
          receipt.sequence !== expected.token.sequence ||
          installed.databaseId !== artifact.identity.databaseId ||
          installed.schemaDigest !== artifact.schemaDigest
        )
          return yield* Effect.fail(
            failure("initialization", "qualification-migration-ack-unverified"),
          );
        yield* input.ports.verify(artifact);
        yield* input.stopped;
        return yield* Effect.fail(
          failure("initialization", "qualification-stopped-before-activation"),
        );
      }),
  };
};

// The exercise is a directly supplied trusted native test/runtime operation,
// not decoded evidence. It must run the complete materialized Worker and assert
// retained records/keys/checkpoints/FTS. Native tests establish this implementation;
// this result alone cannot authorize a production recovery or report readiness.
export const observeArchivePair = (input: {
  readonly archive: CompleteArchive;
  readonly artifact: Artifact;
  readonly migrationSources: readonly SqliteMigrationSource[];
  readonly database: typeof ControlDatabase.Service;
  readonly exercise: Effect.Effect<void, DeliveryError>;
}) =>
  Effect.gen(function* () {
    yield* verifyArchive(input.archive);
    yield* verifyMaterializedArchive(input.archive, input.artifact);
    if (!sameIdentity(input.database.identity, input.artifact.identity))
      return yield* Effect.fail(
        failure("initialization", "qualification-database-mismatch"),
      );
    if (
      input.migrationSources.length <= input.artifact.migrations.length ||
      input.artifact.migrations.some((migration, index) => {
        const source = input.migrationSources[index];
        return (
          source?.path !== `apps/forum/migrations/${migration.name}` ||
          createHash("sha256").update(source.bytes).digest("hex") !==
            migration.digest
        );
      })
    )
      return yield* Effect.fail(
        failure("build", "qualification-newer-history-unverified"),
      );
    const states = yield* physicalStates(input.migrationSources);
    const state = states.at(-1);
    if (!state)
      return yield* Effect.fail(
        failure("build", "qualification-physical-state-required"),
      );
    const before = yield* inspectInstalled(
      input.artifact,
      [state],
      input.database,
    );
    yield* input.exercise;
    yield* verifyArchive(input.archive);
    yield* verifyMaterializedArchive(input.archive, input.artifact);
    const after = yield* inspectInstalled(
      input.artifact,
      [state],
      input.database,
    );
    if (JSON.stringify(before) !== JSON.stringify(after))
      return yield* Effect.fail(
        failure("initialization", "qualification-state-changed"),
      );
    return Object.freeze({
      kind: "local-pair-observation-not-release-authorization" as const,
      identity: input.artifact.identity,
      sourceRevision: input.artifact.sourceRevision,
      archiveContentDigest: input.archive.contentDigest,
      materializedArtifactDigest: input.artifact.artifactDigest,
      physicalDigest: state.physicalDigest,
      nativeHistory: [...state.history],
    });
  });

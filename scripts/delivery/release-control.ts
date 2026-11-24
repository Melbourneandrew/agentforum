import { Context, Effect, Option, Schema } from "effect";
import { Identity, failure, type DeliveryError } from "./model.js";
import {
  Artifact,
  Digest,
  Revision,
  type ReleaseSession,
} from "./release-model.js";

export const CONTROL_TABLE = "agentforum_release_control";
export const CONTROL_HISTORY = "agentforum_release_migrations";
export const CONTROL_FILE = "0001_release_control.sql";
export const CONTROL_V1_SHA256 =
  "30072961366f39a3c349915da88bb9627e43f96ee1c689cc5e51a5ea42b16251";
export const NATIVE_HISTORY_SQL = `CREATE TABLE IF NOT EXISTS "${CONTROL_HISTORY}"(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);`;
const Integer = Schema.Number.pipe(
  Schema.int(),
  Schema.between(0, Number.MAX_SAFE_INTEGER),
);
const Nonce = Schema.String.pipe(
  Schema.pattern(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/),
);
export const ExecutorRef = Schema.String.pipe(
  Schema.pattern(/^[a-zA-Z0-9][a-zA-Z0-9:._/-]{0,199}$/),
);
export const EffectKind = Schema.Literal(
  "control-migrate",
  "business-migrate",
  "activate",
);
export const EffectToken = Schema.Struct({
  ownerId: Nonce,
  generation: Integer,
  sequence: Integer,
  kind: EffectKind,
});
export type EffectToken = typeof EffectToken.Type;
export const TerminalReceipt = Schema.Struct({
  ...EffectToken.fields,
  identity: Identity,
  sourceRevision: Revision,
  artifactDigest: Digest,
  operationRef: ExecutorRef,
  outcome: Schema.Literal("succeeded", "failed"),
  // Validated operational identifiers only. Never raw SQL, keys or payloads.
});
export type TerminalReceipt = typeof TerminalReceipt.Type;
export class ControlDatabase extends Context.Tag("delivery/ControlDatabase")<
  ControlDatabase,
  {
    readonly identity: Identity;
    readonly query: (
      sql: string,
      params: readonly (string | number | null)[],
    ) => Effect.Effect<readonly Record<string, unknown>[], DeliveryError>;
  }
>() {}
const OptionalText = Schema.OptionFromNullOr(Schema.String);
export const ControlRow = Schema.Struct({
  slot: Schema.Literal(1),
  protocol: Schema.Literal(1),
  account_id: Identity.fields.accountId,
  database_id: Identity.fields.databaseId,
  worker_name: Identity.fields.workerName,
  default_origin: Identity.fields.defaultOrigin,
  generation: Integer.pipe(Schema.greaterThan(0)),
  phase: Schema.Literal("idle", "held", "uncertain"),
  owner_id: Schema.OptionFromNullOr(Nonce),
  executor_ref: Schema.OptionFromNullOr(ExecutorRef),
  source_revision: Revision,
  artifact_sha256: Digest,
  effect_seq: Integer,
  effect_kind: Schema.Literal(
    "none",
    "control-migrate",
    "business-migrate",
    "activate",
  ),
  effect_state: Schema.Literal("none", "intent", "acked", "unknown"),
  effect_ref: OptionalText,
  effect_receipt_json: OptionalText,
  last_release_receipt_json: OptionalText,
  reconciliation_sha256: Schema.OptionFromNullOr(Digest),
});
export type ControlRow = typeof ControlRow.Type;
export const sameIdentity = (a: Identity, b: Identity) =>
  a.accountId === b.accountId &&
  a.databaseId === b.databaseId &&
  a.databaseName === b.databaseName &&
  a.workerName === b.workerName &&
  a.defaultOrigin === b.defaultOrigin;
export const hashControl = (text: string) =>
  Effect.tryPromise({
    try: async () =>
      Array.from(
        new Uint8Array(
          await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
        ),
        (b) => b.toString(16).padStart(2, "0"),
      ).join(""),
    catch: () => failure("initialization", "control-digest-failed"),
  });
export const readControl = (db: typeof ControlDatabase.Service) =>
  db.query(`SELECT * FROM ${CONTROL_TABLE} WHERE slot=1`, []).pipe(
    Effect.flatMap((rows) =>
      Schema.decodeUnknown(Schema.Array(ControlRow).pipe(Schema.maxItems(1)))(
        rows,
      ),
    ),
    Effect.mapError(() => failure("initialization", "control-row-unverified")),
    Effect.map((rows) => Option.fromNullable(rows[0])),
  );
const identityParams = (identity: Identity) => [
  identity.accountId,
  identity.databaseId,
  identity.workerName,
  identity.defaultOrigin,
];
const exactOne = (rows: readonly Record<string, unknown>[], code: string) =>
  rows.length === 1
    ? Effect.void
    : Effect.fail(failure("initialization", code));
const ownerMatches = (row: ControlRow, owner: string, generation: number) =>
  Option.contains(row.owner_id, owner) &&
  row.generation === generation &&
  row.phase === "held";

// This factory is installation-scoped, never an isolate-global DB/credential layer.
// The adapter must already have verified the physical account/DB association.
export const makeControlCoordinator = (input: {
  readonly artifact: Artifact;
  readonly ownerId: string;
  readonly executorRef: string;
}) =>
  Effect.gen(function* () {
    const artifact = yield* Schema.decodeUnknown(Artifact)(input.artifact).pipe(
      Effect.mapError(() =>
        failure("configuration", "control-artifact-invalid"),
      ),
    );
    const ownerId = yield* Schema.decodeUnknown(Nonce)(input.ownerId).pipe(
      Effect.mapError(() => failure("configuration", "control-owner-invalid")),
    );
    const executorRef = yield* Schema.decodeUnknown(ExecutorRef)(
      input.executorRef,
    ).pipe(
      Effect.mapError(() =>
        failure("configuration", "control-executor-invalid"),
      ),
    );
    const db = yield* ControlDatabase;
    if (!sameIdentity(db.identity, artifact.identity))
      return yield* Effect.fail(
        failure("configuration", "control-database-identity-mismatch"),
      );
    return {
      acquire: (
        identity: Identity,
      ): Effect.Effect<ReleaseSession, DeliveryError> =>
        Effect.gen(function* () {
          if (!sameIdentity(identity, artifact.identity))
            return yield* Effect.fail(
              failure("configuration", "control-request-identity-mismatch"),
            );
          // Atomic INSERT-or-idle-CAS. A held/uncertain row can NEVER be replaced.
          const rows = yield* db
            .query(
              `INSERT INTO ${CONTROL_TABLE}
        (slot,protocol,account_id,database_id,worker_name,default_origin,generation,phase,owner_id,executor_ref,source_revision,artifact_sha256)
        VALUES (1,1,?,?,?,?,1,'held',?,?,?,?)
        ON CONFLICT(slot) DO UPDATE SET generation=generation+1,phase='held',owner_id=excluded.owner_id,executor_ref=excluded.executor_ref,
          source_revision=excluded.source_revision,artifact_sha256=excluded.artifact_sha256,effect_kind='none',effect_state='none',effect_ref=NULL,effect_receipt_json=NULL
        WHERE phase='idle' AND protocol=1 AND account_id=excluded.account_id AND database_id=excluded.database_id
          AND worker_name=excluded.worker_name AND default_origin=excluded.default_origin AND generation<9007199254740991
        RETURNING *`,
              [
                ...identityParams(identity),
                ownerId,
                executorRef,
                artifact.sourceRevision,
                artifact.artifactDigest,
              ],
            )
            .pipe(
              Effect.mapError(() =>
                failure("initialization", "control-acquire-unknown-retained"),
              ),
            );
          yield* exactOne(rows, "control-acquire-refused");
          const acquired = yield* Schema.decodeUnknown(ControlRow)(
            rows[0],
          ).pipe(
            Effect.mapError(() =>
              failure("initialization", "control-acquire-unverified"),
            ),
          );
          if (
            !ownerMatches(acquired, ownerId, acquired.generation) ||
            acquired.effect_state !== "none" ||
            acquired.source_revision !== artifact.sourceRevision ||
            acquired.artifact_sha256 !== artifact.artifactDigest
          )
            return yield* Effect.fail(
              failure("initialization", "control-acquire-unverified"),
            );
          const generation = acquired.generation;
          let sequence = acquired.effect_seq;
          const contextParams = () => [
            ...identityParams(identity),
            artifact.sourceRevision,
            artifact.artifactDigest,
            executorRef,
          ];
          const contextClause =
            "account_id=? AND database_id=? AND worker_name=? AND default_origin=? AND source_revision=? AND artifact_sha256=? AND executor_ref=? AND protocol=1";
          const ownershipClause = `owner_id=? AND generation=? AND effect_seq=? AND ${contextClause}`;
          const guard = () => [
            ownerId,
            generation,
            sequence,
            ...contextParams(),
          ];
          const assertHeld = Effect.gen(function* () {
            const row = yield* readControl(db);
            if (
              Option.isNone(row) ||
              !ownerMatches(row.value, ownerId, generation) ||
              row.value.effect_seq !== sequence ||
              row.value.account_id !== identity.accountId ||
              row.value.database_id !== identity.databaseId ||
              row.value.worker_name !== identity.workerName ||
              row.value.default_origin !== identity.defaultOrigin ||
              row.value.source_revision !== artifact.sourceRevision ||
              row.value.artifact_sha256 !== artifact.artifactDigest ||
              !Option.contains(row.value.executor_ref, executorRef)
            )
              return yield* Effect.fail(
                failure("initialization", "control-ownership-unverified"),
              );
          });
          const session: ReleaseSession = {
            assertHeld,
            arm: (kind, candidate) =>
              Effect.uninterruptible(
                Effect.gen(function* () {
                  if (
                    !sameIdentity(candidate.identity, identity) ||
                    candidate.sourceRevision !== artifact.sourceRevision ||
                    candidate.artifactDigest !== artifact.artifactDigest
                  )
                    return yield* Effect.fail(
                      failure(
                        "configuration",
                        "control-effect-artifact-mismatch",
                      ),
                    );
                  const rows = yield* db
                    .query(
                      `UPDATE ${CONTROL_TABLE} SET effect_seq=effect_seq+1,effect_kind=?,effect_state='intent',effect_ref=NULL,effect_receipt_json=NULL
            WHERE slot=1 AND phase='held' AND ${ownershipClause} AND effect_state IN ('none','acked') AND effect_seq<9007199254740991 RETURNING *`,
                      [kind, ...guard()],
                    )
                    .pipe(
                      Effect.mapError(() =>
                        failure(
                          "initialization",
                          "control-intent-unknown-retained",
                        ),
                      ),
                    );
                  yield* exactOne(rows, "control-intent-refused");
                  const row = yield* Schema.decodeUnknown(ControlRow)(
                    rows[0],
                  ).pipe(
                    Effect.mapError(() =>
                      failure("initialization", "control-intent-unverified"),
                    ),
                  );
                  sequence = row.effect_seq;
                  return { ownerId, generation, sequence, kind };
                }),
              ),
            terminal: (token, receipt) =>
              Effect.uninterruptible(
                Effect.gen(function* () {
                  const proof = yield* Schema.decodeUnknown(TerminalReceipt)(
                    receipt,
                    { onExcessProperty: "error" },
                  ).pipe(
                    Effect.mapError(() =>
                      failure("initialization", "control-terminal-invalid"),
                    ),
                  );
                  if (
                    token.ownerId !== ownerId ||
                    token.generation !== generation ||
                    token.sequence !== sequence ||
                    proof.ownerId !== ownerId ||
                    proof.generation !== generation ||
                    proof.sequence !== sequence ||
                    proof.kind !== token.kind ||
                    !sameIdentity(proof.identity, identity) ||
                    proof.sourceRevision !== artifact.sourceRevision ||
                    proof.artifactDigest !== artifact.artifactDigest
                  )
                    return yield* Effect.fail(
                      failure("initialization", "control-terminal-mismatch"),
                    );
                  const rows = yield* db.query(
                    `UPDATE ${CONTROL_TABLE} SET effect_state='acked',effect_ref=?,effect_receipt_json=?
            WHERE slot=1 AND phase='held' AND ${ownershipClause} AND effect_kind=? AND effect_state='intent' RETURNING slot`,
                    [
                      proof.operationRef,
                      JSON.stringify(proof),
                      ...guard(),
                      token.kind,
                    ],
                  );
                  yield* exactOne(rows, "control-terminal-refused");
                }),
              ),
            close: (outcome) =>
              Effect.gen(function* () {
                if (outcome === "uncertain") {
                  // Do not require the last acknowledged sequence: a lost intent response
                  // may already have advanced it. Never clear this ownership.
                  const rows = yield* db.query(
                    `UPDATE ${CONTROL_TABLE} SET phase='uncertain',effect_state=CASE WHEN effect_state='intent' THEN 'unknown' ELSE effect_state END
              WHERE slot=1 AND owner_id=? AND generation=? AND ${contextClause} AND phase IN ('held','uncertain') RETURNING slot`,
                    [ownerId, generation, ...contextParams()],
                  );
                  yield* exactOne(rows, "control-quarantine-refused");
                  return;
                }
                const current = yield* readControl(db);
                if (
                  Option.isNone(current) ||
                  !ownerMatches(current.value, ownerId, generation) ||
                  current.value.effect_seq !== sequence
                )
                  return yield* Effect.fail(
                    failure("initialization", "control-closure-stale"),
                  );
                const rows = yield* db.query(
                  `UPDATE ${CONTROL_TABLE} SET phase='idle',owner_id=NULL,executor_ref=NULL,effect_kind='none',effect_state='none',effect_ref=NULL,
            last_release_receipt_json=? WHERE slot=1 AND phase='held' AND ${ownershipClause} AND effect_state IN ('none','acked') RETURNING slot`,
                  [
                    JSON.stringify({
                      sourceRevision: artifact.sourceRevision,
                      artifactDigest: artifact.artifactDigest,
                      sequence,
                      migrationManifest: artifact.migrations,
                      manifestDigest: artifact.schemaDigest,
                      qualifiedCompatibleSchemas: artifact.compatibleSchemas,
                      terminalReceipt: Option.getOrNull(
                        current.value.effect_receipt_json,
                      ),
                    }),
                    ...guard(),
                  ],
                );
                yield* exactOne(rows, "control-closure-refused");
              }).pipe(
                Effect.mapError(() =>
                  failure(
                    "initialization",
                    "control-closure-unverified-retained",
                  ),
                ),
              ),
          };
          return session;
        }),
    };
  });

export class QuiescenceVerifier extends Context.Tag(
  "delivery/QuiescenceVerifier",
)<
  QuiescenceVerifier,
  {
    // These are trusted observation adapters, NOT user-supplied booleans/files.
    readonly executor: (
      row: ControlRow,
    ) => Effect.Effect<unknown, DeliveryError>;
    readonly effect: (row: ControlRow) => Effect.Effect<unknown, DeliveryError>;
  }
>() {}
const ExecutorProof = Schema.Struct({
  ownerId: Nonce,
  generation: Integer,
  sequence: Integer,
  executorRef: ExecutorRef,
  terminal: Schema.Literal(true),
  observationRef: Schema.NonEmptyString.pipe(Schema.maxLength(200)),
});
export const unavailableQuiescence: typeof QuiescenceVerifier.Service = {
  executor: () =>
    Effect.fail(failure("initialization", "executor-quiescence-unproved")),
  effect: () =>
    Effect.fail(failure("initialization", "effect-quiescence-unproved")),
};
export const reconcileControl = () =>
  Effect.gen(function* () {
    const db = yield* ControlDatabase;
    const observer = yield* QuiescenceVerifier;
    const found = yield* readControl(db);
    if (Option.isNone(found) || found.value.phase === "idle")
      return yield* Effect.fail(
        failure("initialization", "control-reconcile-not-stuck"),
      );
    const row = found.value;
    if (
      row.account_id !== db.identity.accountId ||
      row.database_id !== db.identity.databaseId ||
      row.worker_name !== db.identity.workerName ||
      row.default_origin !== db.identity.defaultOrigin ||
      Option.isNone(row.owner_id) ||
      Option.isNone(row.executor_ref)
    )
      return yield* Effect.fail(
        failure("initialization", "control-reconcile-identity-mismatch"),
      );
    const executor = yield* observer.executor(row).pipe(
      Effect.flatMap(Schema.decodeUnknown(ExecutorProof)),
      Effect.mapError(() =>
        failure("initialization", "executor-quiescence-unproved"),
      ),
    );
    if (
      executor.ownerId !== row.owner_id.value ||
      executor.generation !== row.generation ||
      executor.sequence !== row.effect_seq ||
      executor.executorRef !== row.executor_ref.value
    )
      return yield* Effect.fail(
        failure("initialization", "executor-quiescence-mismatch"),
      );
    let effect: Option.Option<TerminalReceipt> = Option.none();
    if (row.effect_state !== "none") {
      const receipt = yield* observer.effect(row).pipe(
        Effect.flatMap(Schema.decodeUnknown(TerminalReceipt)),
        Effect.mapError(() =>
          failure("initialization", "effect-quiescence-unproved"),
        ),
      );
      if (
        receipt.ownerId !== executor.ownerId ||
        receipt.generation !== row.generation ||
        receipt.sequence !== row.effect_seq ||
        receipt.kind !== row.effect_kind ||
        !sameIdentity(receipt.identity, db.identity) ||
        receipt.sourceRevision !== row.source_revision ||
        receipt.artifactDigest !== row.artifact_sha256
      )
        return yield* Effect.fail(
          failure("initialization", "effect-quiescence-mismatch"),
        );
      effect = Option.some(receipt);
    }
    const digest = yield* hashControl(
      JSON.stringify({ executor, effect: Option.getOrNull(effect) }),
    );
    const rows = yield* db.query(
      `UPDATE ${CONTROL_TABLE} SET phase='idle',owner_id=NULL,executor_ref=NULL,effect_kind='none',effect_state='none',effect_ref=NULL,reconciliation_sha256=?
    WHERE slot=1 AND owner_id=? AND executor_ref=? AND generation=? AND effect_seq=? AND phase=? AND effect_state=? AND effect_kind=?
      AND source_revision=? AND artifact_sha256=? AND effect_ref IS ? AND effect_receipt_json IS ? AND account_id=? AND database_id=? AND worker_name=? AND default_origin=? AND protocol=1 RETURNING slot`,
      [
        digest,
        executor.ownerId,
        executor.executorRef,
        row.generation,
        row.effect_seq,
        row.phase,
        row.effect_state,
        row.effect_kind,
        row.source_revision,
        row.artifact_sha256,
        Option.getOrNull(row.effect_ref),
        Option.getOrNull(row.effect_receipt_json),
        ...identityParams(db.identity),
      ],
    );
    yield* exactOne(rows, "control-reconcile-stale");
  });

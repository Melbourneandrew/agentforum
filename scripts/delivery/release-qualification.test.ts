import { Effect, Either, Schema } from "effect";
import { expect, it } from "vitest";
import { Identity, failure, type DeliveryError } from "./model.js";
import { Artifact, type ReleasePorts } from "./release-model.js";
import {
  type ControlDatabase,
  type EffectToken,
  type TerminalReceipt,
} from "./release-control.js";
import { stopAfterAcknowledgedMigration } from "./release-qualification.js";
const identity = Schema.decodeUnknownSync(Identity)({
  version: 1,
  accountId: "a".repeat(32),
  workerName: "ack-forum",
  databaseName: "ack-db",
  databaseId: "11111111-1111-1111-1111-111111111111",
  defaultOrigin: "https://ack-forum.fixture.workers.dev",
});
const artifact = Schema.decodeUnknownSync(Artifact)({
  identity,
  sourceRevision: "b".repeat(40),
  artifactDigest: "c".repeat(64),
  schemaDigest: "d".repeat(64),
  migrations: [],
  compatibleSchemas: [],
  configPath: "/unit-fixture.json",
});
const token: EffectToken = {
  ownerId: "33333333-3333-3333-3333-333333333333",
  generation: 2,
  sequence: 3,
  kind: "business-migrate",
};
const receipt: TerminalReceipt = {
  ...token,
  identity,
  sourceRevision: artifact.sourceRevision,
  artifactDigest: artifact.artifactDigest,
  operationRef: "local:known-migration",
  outcome: "succeeded",
};
const fixture = (
  changes: Record<string, unknown> = {},
  installed = {
    databaseId: identity.databaseId,
    schemaDigest: artifact.schemaDigest,
  },
  migrate: Effect.Effect<TerminalReceipt, DeliveryError> = Effect.succeed(
    receipt,
  ),
) => {
  let stopped = 0,
    observed = 0,
    verified = 0;
  const row = {
    slot: 1,
    protocol: 1,
    account_id: identity.accountId,
    database_id: identity.databaseId,
    worker_name: identity.workerName,
    default_origin: identity.defaultOrigin,
    generation: 2,
    phase: "held",
    owner_id: token.ownerId,
    executor_ref: "local:qualification",
    source_revision: artifact.sourceRevision,
    artifact_sha256: artifact.artifactDigest,
    effect_seq: 3,
    effect_kind: "business-migrate",
    effect_state: "acked",
    effect_ref: receipt.operationRef,
    effect_receipt_json: JSON.stringify(receipt),
    last_release_receipt_json: null,
    reconciliation_sha256: null,
    ...changes,
  };
  const ports: typeof ReleasePorts.Service = {
    build: () => Effect.succeed(artifact),
    verify: () =>
      Effect.sync(() => {
        verified++;
      }),
    installed: () =>
      Effect.sync(() => {
        observed++;
        return installed;
      }),
    migrate: () => migrate,
    activate: () => Effect.fail(failure("deployment", "unexpected-activation")),
    readiness: () => Effect.fail(failure("readiness", "not-tested")),
  };
  const database: typeof ControlDatabase.Service = {
    identity,
    query: () => Effect.succeed([row]),
  };
  return {
    ports: stopAfterAcknowledgedMigration({
      ports,
      database,
      executorRef: "local:qualification",
      stopped: Effect.sync(() => {
        stopped++;
      }),
    }),
    counts: () => ({ stopped, observed, verified }),
  };
};
it("stops only after successful receipt, exact durable ACK and real matching readback", async () => {
  const f = fixture();
  expect(await Effect.runPromise(f.ports.installed(artifact))).toEqual({
    databaseId: identity.databaseId,
    schemaDigest: artifact.schemaDigest,
  });
  expect(f.counts().stopped).toBe(0);
  await Effect.runPromise(f.ports.migrate(artifact, token));
  const result = await Effect.runPromise(
    Effect.either(f.ports.installed(artifact)),
  );
  expect(Either.isLeft(result) && result.left.code).toBe(
    "qualification-stopped-before-activation",
  );
  expect(f.counts()).toEqual({ stopped: 1, observed: 2, verified: 1 });
  await Effect.runPromise(
    f.ports.build({
      identity,
      sourceRevision: artifact.sourceRevision,
      operation: "update",
    }),
  );
  await Effect.runPromise(f.ports.installed(artifact));
  expect(f.counts().stopped).toBe(1);
});
it.each([
  { phase: "uncertain" },
  { effect_state: "intent" },
  { effect_state: "unknown" },
  { effect_kind: "activate" },
  { effect_receipt_json: null },
  { effect_receipt_json: "{}" },
  { effect_ref: "local:other" },
  { owner_id: "44444444-4444-4444-4444-444444444444" },
  { executor_ref: "local:other" },
  { generation: 4 },
  { effect_seq: 5 },
  { source_revision: "e".repeat(40) },
  { artifact_sha256: "e".repeat(64) },
  { account_id: "e".repeat(32) },
  { database_id: "22222222-2222-2222-2222-222222222222" },
  { worker_name: "other-worker" },
  { default_origin: "https://other.fixture.workers.dev" },
  { effect_receipt_json: JSON.stringify({ ...receipt, outcome: "failed" }) },
])(
  "never authorizes fault from a mismatched/unknown ACK: %j",
  async (changes) => {
    const f = fixture(changes);
    await Effect.runPromise(f.ports.migrate(artifact, token));
    expect(
      Either.isLeft(
        await Effect.runPromise(Effect.either(f.ports.installed(artifact))),
      ),
    ).toBe(true);
    expect(f.counts().stopped).toBe(0);
  },
);
it.each([
  {
    databaseId: "22222222-2222-2222-2222-222222222222",
    schemaDigest: artifact.schemaDigest,
  },
  { databaseId: identity.databaseId, schemaDigest: "e".repeat(64) },
])("requires exact installed DB and physical state", async (installed) => {
  const f = fixture({}, installed);
  await Effect.runPromise(f.ports.migrate(artifact, token));
  expect(
    Either.isLeft(
      await Effect.runPromise(Effect.either(f.ports.installed(artifact))),
    ),
  ).toBe(true);
  expect(f.counts().stopped).toBe(0);
});
it("never converts an unknown migration outcome to a known-terminal stop", async () => {
  const f = fixture(
    {},
    undefined,
    Effect.fail(failure("deployment", "executor-outcome-unknown")),
  );
  expect(
    Either.isLeft(
      await Effect.runPromise(Effect.either(f.ports.migrate(artifact, token))),
    ),
  ).toBe(true);
  await Effect.runPromise(f.ports.installed(artifact));
  expect(f.counts().stopped).toBe(0);
});

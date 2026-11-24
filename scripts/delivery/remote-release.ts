// Real remote ports: only composed after parent authorization + retained identity
// verification. No default provider, fake quiescence or snapshot-based takeover.
import { Effect, Option, Schema } from "effect";
import { stripVTControlCharacters } from "node:util";
import { failure, type DeliveryError } from "./model.js";
import { Artifact, type ReleasePorts } from "./release-model.js";
import {
  EffectToken,
  ExecutorRef,
  readControl,
  sameIdentity,
  type TerminalReceipt,
} from "./release-control.js";
import { inspectInstalled, type PhysicalState } from "./remote-state.js";
import { remoteProvider } from "./remote-provider.js";
import { inspectReadiness, ReadinessHttp } from "./release-readiness.js";

export interface NativeResult {
  readonly stdout: string;
  readonly operationRef: string;
}
export const remotePorts = (input: {
  readonly artifact: Artifact;
  readonly states: readonly PhysicalState[];
  readonly provider: ReturnType<typeof remoteProvider>;
  readonly executorRef: string;
  readonly verify: Effect.Effect<void, DeliveryError>;
  // Trusted parent executor resolves ONLY after a normal zero exit. Timeout,
  // signal, output truncation and lost receipts fail, never assert terminality.
  readonly native: (
    args: readonly string[],
  ) => Effect.Effect<NativeResult, DeliveryError>;
  readonly readiness: typeof ReadinessHttp.Service;
}): typeof ReleasePorts.Service => {
  const verify = (artifact: Artifact) =>
    Effect.gen(function* () {
      const value = yield* Schema.decodeUnknown(Artifact)(artifact).pipe(
        Effect.mapError(() => failure("build", "remote-artifact-invalid")),
      );
      if (JSON.stringify(value) !== JSON.stringify(input.artifact))
        return yield* Effect.fail(failure("build", "remote-artifact-mismatch"));
      yield* input.verify;
    });
  const intent = (
    artifact: Artifact,
    token: EffectToken,
    kind: "business-migrate" | "activate",
  ) =>
    Effect.gen(function* () {
      const claim = yield* Schema.decodeUnknown(EffectToken)(token).pipe(
        Effect.mapError(() =>
          failure("initialization", "remote-intent-invalid"),
        ),
      );
      yield* verify(artifact);
      const current = yield* readControl(input.provider.database);
      if (
        Option.isNone(current) ||
        current.value.phase !== "held" ||
        !Option.contains(current.value.owner_id, claim.ownerId) ||
        !Option.contains(current.value.executor_ref, input.executorRef) ||
        current.value.generation !== claim.generation ||
        current.value.effect_seq !== claim.sequence ||
        current.value.effect_kind !== kind ||
        claim.kind !== kind ||
        current.value.effect_state !== "intent" ||
        current.value.account_id !== artifact.identity.accountId ||
        current.value.database_id !== artifact.identity.databaseId ||
        current.value.worker_name !== artifact.identity.workerName ||
        current.value.default_origin !== artifact.identity.defaultOrigin ||
        current.value.source_revision !== artifact.sourceRevision ||
        current.value.artifact_sha256 !== artifact.artifactDigest ||
        !sameIdentity(input.provider.database.identity, artifact.identity)
      )
        return yield* Effect.fail(
          failure("initialization", "remote-intent-not-held"),
        );
    });
  const receipt = (
    artifact: Artifact,
    token: EffectToken,
    ref: string,
  ): Effect.Effect<TerminalReceipt, DeliveryError> =>
    Schema.decodeUnknown(ExecutorRef)(ref).pipe(
      Effect.mapError(() => failure("deployment", "native-receipt-unverified")),
      Effect.map((operationRef) => ({
        ...token,
        identity: artifact.identity,
        sourceRevision: artifact.sourceRevision,
        artifactDigest: artifact.artifactDigest,
        operationRef,
        outcome: "succeeded" as const,
      })),
    );
  return {
    build: () => Effect.succeed(input.artifact),
    verify,
    installed: (artifact) =>
      verify(artifact).pipe(
        Effect.zipRight(
          inspectInstalled(artifact, input.states, input.provider.database),
        ),
      ),
    migrate: (artifact, token) =>
      Effect.gen(function* () {
        yield* intent(artifact, token, "business-migrate");
        const result = yield* input.native([
          "d1",
          "migrations",
          "apply",
          "DB",
          "--remote",
          "--config",
          artifact.configPath,
          "--env-file",
          "/dev/null",
        ]);
        const installed = yield* inspectInstalled(
          artifact,
          input.states,
          input.provider.database,
        );
        if (installed.schemaDigest !== artifact.schemaDigest)
          return yield* Effect.fail(
            failure("initialization", "remote-migration-unverified"),
          );
        return yield* receipt(artifact, token, result.operationRef);
      }),
    activate: (artifact, token) =>
      Effect.gen(function* () {
        yield* intent(artifact, token, "activate");
        // First-time versions upload is not supported by the provider. deploy
        // performs upload AND activation; both stay within this durable intent.
        const message = `agentforum:${artifact.sourceRevision}:${artifact.artifactDigest}`;
        const result = yield* input.native([
          "deploy",
          "--config",
          artifact.configPath,
          "--message",
          message,
          "--env-file",
          "/dev/null",
        ]);
        const versions = Array.from(
          stripVTControlCharacters(result.stdout).matchAll(
            /^Current Version ID:\s*([a-f0-9-]+)\s*$/gm,
          ),
          (match) => match[1],
        );
        if (versions.length !== 1 || !versions[0])
          return yield* Effect.fail(
            failure("deployment", "native-version-receipt-unverified"),
          );
        const deployment = yield* input.provider.current(versions[0], message);
        return {
          activation: {
            sourceRevision: artifact.sourceRevision,
            artifactDigest: artifact.artifactDigest,
            version: versions[0],
          },
          receipt: yield* receipt(artifact, token, `deployment:${deployment}`),
        };
      }),
    readiness: (artifact, activation) =>
      inspectReadiness(artifact, activation).pipe(
        Effect.provideService(ReadinessHttp, input.readiness),
      ),
  };
};

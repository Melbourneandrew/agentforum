import { Effect, Exit, Schema } from "effect";
import { failure } from "./model.js";
import {
  Activation,
  Artifact,
  Installed,
  Readiness,
  ReleaseCoordinator,
  ReleasePorts,
  ReleaseRequest,
} from "./release-model.js";

// No default successful coordinator: the real cross-entry ownership adapter is
// installation-scoped. An OS/local journal lock cannot satisfy this dependency.
export const unconfiguredCoordinator: typeof ReleaseCoordinator.Service = {
  acquire: () =>
    Effect.fail(
      failure("configuration", "release-control-adapter-unconfigured"),
    ),
};
export const release = (input: unknown) =>
  Effect.gen(function* () {
    const request = yield* Schema.decodeUnknown(ReleaseRequest)(input, {
      onExcessProperty: "error",
    }).pipe(
      Effect.mapError(() =>
        failure("configuration", "release-request-invalid"),
      ),
    );
    const coordinator = yield* ReleaseCoordinator;
    const ports = yield* ReleasePorts;
    let mutationBegan = false;
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const session = yield* coordinator.acquire(request.identity);
        const exit = yield* restore(
          Effect.gen(function* () {
            yield* session.assertHeld;
            const raw = yield* ports.build(request);
            const artifact = yield* Schema.decodeUnknown(Artifact)(raw).pipe(
              Effect.mapError(() =>
                failure("build", "artifact-receipt-invalid"),
              ),
            );
            if (
              JSON.stringify(artifact.identity) !==
                JSON.stringify(request.identity) ||
              artifact.sourceRevision !== request.sourceRevision
            )
              return yield* Effect.fail(
                failure("build", "artifact-identity-or-revision-mismatch"),
              );
            yield* session.assertHeld;
            yield* ports.verify(artifact);
            yield* session.assertHeld;
            const installed = yield* ports.installed(artifact).pipe(
              Effect.flatMap(Schema.decodeUnknown(Installed)),
              Effect.mapError(() =>
                failure("initialization", "installed-schema-unverified"),
              ),
            );
            if (installed.databaseId !== request.identity.databaseId)
              return yield* Effect.fail(
                failure("initialization", "installed-database-mismatch"),
              );
            if (request.operation === "recover") {
              if (!artifact.compatibleSchemas.includes(installed.schemaDigest))
                return yield* Effect.fail(
                  failure(
                    "initialization",
                    "rollback-schema-compatibility-unproven-roll-forward",
                  ),
                );
              // Recovery activates the verified archived complete app. Never reverses SQL.
            } else {
              yield* session.assertHeld;
              mutationBegan = true;
              const token = yield* session.arm("business-migrate", artifact);
              const receipt = yield* ports.migrate(artifact, token);
              yield* session.terminal(token, receipt);
              mutationBegan = false;
              if (receipt.outcome !== "succeeded")
                return yield* Effect.fail(
                  failure("initialization", "migration-terminal-failure"),
                );
              const initialized = yield* ports.installed(artifact).pipe(
                Effect.flatMap(Schema.decodeUnknown(Installed)),
                Effect.mapError(() =>
                  failure("initialization", "initialized-schema-unverified"),
                ),
              );
              if (
                initialized.databaseId !== request.identity.databaseId ||
                initialized.schemaDigest !== artifact.schemaDigest
              )
                return yield* Effect.fail(
                  failure("initialization", "migration-history-incomplete"),
                );
            }
            yield* session.assertHeld;
            yield* ports.verify(artifact);
            // Verification may yield: refuse dispatch if ownership is no longer
            // acknowledged. This check is not fencing for a remote Worker upload.
            yield* session.assertHeld;
            mutationBegan = true;
            const token = yield* session.arm("activate", artifact);
            const activated = yield* ports.activate(artifact, token);
            const activation = yield* Schema.decodeUnknown(Activation)(
              activated.activation,
            ).pipe(
              Effect.mapError(() =>
                failure("deployment", "activation-unverified-retain-storage"),
              ),
            );
            if (
              activation.sourceRevision !== artifact.sourceRevision ||
              activation.artifactDigest !== artifact.artifactDigest
            )
              return yield* Effect.fail(
                failure("deployment", "activated-artifact-mismatch"),
              );
            yield* session.terminal(token, activated.receipt);
            mutationBegan = false;
            if (activated.receipt.outcome !== "succeeded")
              return yield* Effect.fail(
                failure("deployment", "activation-terminal-failure"),
              );
            yield* session.assertHeld;
            const readiness = yield* ports.readiness(artifact, activation).pipe(
              Effect.flatMap(Schema.decodeUnknown(Readiness)),
              Effect.mapError(() =>
                failure("readiness", "installation-not-ready"),
              ),
            );
            if (
              readiness.sourceRevision !== activation.sourceRevision ||
              readiness.artifactDigest !== artifact.artifactDigest ||
              readiness.defaultOrigin !== artifact.identity.defaultOrigin ||
              (readiness.canonicalOrigin ?? readiness.defaultOrigin) !==
                (artifact.canonicalOrigin ?? artifact.identity.defaultOrigin)
            )
              return yield* Effect.fail(
                failure("readiness", "readiness-artifact-or-origin-mismatch"),
              );
            return {
              status: "ready" as const,
              identity: artifact.identity,
              sourceRevision: artifact.sourceRevision,
              artifactDigest: artifact.artifactDigest,
              version: activation.version,
              readiness,
            };
          }),
        ).pipe(Effect.exit);
        // Cleanup is uninterruptible but its persistence failure remains typed and
        // observable. Never return ready when closure could not be acknowledged.
        yield* session.close(mutationBegan ? "uncertain" : "acknowledged");
        return yield* Exit.match(exit, {
          onFailure: Effect.failCause,
          onSuccess: Effect.succeed,
        });
      }),
    );
  });

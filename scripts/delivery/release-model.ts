import { Context, Effect, Schema } from "effect";
import { Identity } from "./model.js";
import type { DeliveryError } from "./model.js";

export const Revision = Schema.String.pipe(Schema.pattern(/^[a-f0-9]{40}$/));
export const Digest = Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/));
export const Migration = Schema.Struct({ name: Schema.String, digest: Digest });
export const Artifact = Schema.Struct({
  identity: Identity,
  sourceRevision: Revision,
  configPath: Schema.String,
  artifactDigest: Digest,
  schemaDigest: Digest,
  migrations: Schema.Array(Migration),
  // Exact installed-schema fingerprints for which this artifact was qualified.
  // An older prefix or an application version label is NOT compatibility proof.
  compatibleSchemas: Schema.Array(Digest),
});
export type Artifact = typeof Artifact.Type;
export const Installed = Schema.Struct({
  databaseId: Identity.fields.databaseId,
  schemaDigest: Digest,
});
export type Installed = typeof Installed.Type;
export const Activation = Schema.Struct({
  sourceRevision: Revision,
  artifactDigest: Digest,
  version: Schema.NonEmptyString,
});
export type Activation = typeof Activation.Type;
export const Readiness = Schema.Struct({
  sourceRevision: Revision,
  artifactDigest: Digest,
  defaultOrigin: Identity.fields.defaultOrigin,
  checks: Schema.Struct({
    website: Schema.Literal(true),
    docs: Schema.Literal(true),
    discovery: Schema.Literal(true),
    contract: Schema.Literal(true),
    apiReads: Schema.Literal(true),
  }),
});
export type Readiness = typeof Readiness.Type;
export const ReleaseRequest = Schema.Struct({
  identity: Identity,
  sourceRevision: Revision,
  operation: Schema.Literal("update", "recover"),
});
export type ReleaseRequest = typeof ReleaseRequest.Type;

export interface ReleaseSession {
  readonly assertHeld: Effect.Effect<void, DeliveryError>;
  // An uncertain mutation MUST retain exclusive ownership, not delete a lock.
  // No distributed implementation is selected/installed pending parent approval.
  readonly close: (
    outcome: "acknowledged" | "uncertain",
  ) => Effect.Effect<void>;
}
export class ReleaseCoordinator extends Context.Tag(
  "delivery/ReleaseCoordinator",
)<
  ReleaseCoordinator,
  {
    readonly acquire: (
      identity: Identity,
    ) => Effect.Effect<ReleaseSession, DeliveryError>;
  }
>() {}
export class ReleasePorts extends Context.Tag("delivery/ReleasePorts")<
  ReleasePorts,
  {
    readonly build: (
      request: ReleaseRequest,
    ) => Effect.Effect<Artifact, DeliveryError>;
    readonly verify: (artifact: Artifact) => Effect.Effect<void, DeliveryError>;
    readonly installed: (
      artifact: Artifact,
    ) => Effect.Effect<Installed, DeliveryError>;
    readonly migrate: (
      artifact: Artifact,
    ) => Effect.Effect<void, DeliveryError>;
    readonly activate: (
      artifact: Artifact,
    ) => Effect.Effect<Activation, DeliveryError>;
    readonly readiness: (
      artifact: Artifact,
      activation: Activation,
    ) => Effect.Effect<Readiness, DeliveryError>;
  }
>() {}

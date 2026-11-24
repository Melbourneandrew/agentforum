import { Schema } from "effect";

const Name = Schema.String.pipe(
  Schema.pattern(/^[a-z][a-z0-9-]{0,61}[a-z0-9]$/),
);
export const AccountId = Schema.String.pipe(Schema.pattern(/^[a-f0-9]{32}$/));
export const DatabaseId = Schema.String.pipe(
  Schema.pattern(
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,
  ),
);
export const Target = Schema.Struct({
  accountId: AccountId,
  workerName: Name,
  databaseName: Name,
});
export type Target = typeof Target.Type;
export const Request = Schema.Struct({
  ...Target.fields,
  storage: Schema.Union(
    Schema.Struct({ mode: Schema.Literal("create") }),
    Schema.Struct({ mode: Schema.Literal("bind"), databaseId: DatabaseId }),
  ),
});
export type Request = typeof Request.Type;
export const Database = Schema.Struct({ uuid: DatabaseId, name: Name });
export type Database = typeof Database.Type;
export const HostedOrigin = Schema.String.pipe(
  Schema.pattern(
    /^https:\/\/[a-z][a-z0-9-]*\.[a-z0-9][a-z0-9-]*\.workers\.dev$/,
  ),
);
export const Identity = Schema.Struct({
  version: Schema.Literal(1),
  ...Target.fields,
  databaseId: DatabaseId,
  defaultOrigin: HostedOrigin,
});
export type Identity = typeof Identity.Type;
export const Journal = Schema.Union(
  Schema.Struct({ state: Schema.Literal("intent"), target: Target }),
  Schema.Struct({ state: Schema.Literal("resolved"), identity: Identity }),
);
export type Journal = typeof Journal.Type;
export const Stage = Schema.Literal(
  "authorization",
  "configuration",
  "provisioning",
  "build",
  "initialization",
  "deployment",
  "readiness",
);
export type Stage = typeof Stage.Type;
export class DeliveryError extends Error {
  readonly _tag = "DeliveryError";
  constructor(
    readonly stage: Stage,
    readonly code: string,
  ) {
    super(code);
  }
}
export const failure = (stage: Stage, code: string) =>
  new DeliveryError(stage, code);
export const recovery: Record<Stage, string> = {
  authorization:
    "Installation not completed. Obtain owner/account/source authorization; do not retry with broader credentials automatically.",
  configuration:
    "Installation not completed. Correct local input or retained identity; never discard retained storage to retry.",
  provisioning:
    "Installation not completed. Retain the identity journal. Reconcile any uncertain D1 creation with the provider owner; explicitly bind its returned ID before retrying.",
  build:
    "Installation not completed. Fix and verify the complete Worker/assets/contracts build; retain D1.",
  initialization:
    "Installation not completed. Inspect versioned D1 migration history with the authorized release owner; never reset or reseed.",
  deployment:
    "Installation not completed. Retry only a schema-compatible release against the retained D1.",
  readiness:
    "Installation not completed. Verify website/API/docs/discovery, trusted origin and storage with the release owner; a provider URL alone is not readiness.",
};
// WO-34 consumes this identity. Provisioning never declares a usable installation.
export const handoff = (identity: Identity) => ({
  status: "provisioned-not-ready" as const,
  identity,
  binding: {
    binding: "DB",
    database_name: identity.databaseName,
    database_id: identity.databaseId,
    migrations_dir: "apps/forum/migrations",
  },
  worker: {
    name: identity.workerName,
    workers_dev: true,
    vars: { CANONICAL_ORIGIN: identity.defaultOrigin },
  },
  stages: {
    provisioning: "resolved",
    build: "not-run",
    initialization: "not-run",
    deployment: "not-run",
    readiness: "not-run",
  },
});

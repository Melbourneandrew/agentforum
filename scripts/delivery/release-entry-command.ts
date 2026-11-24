import { parseArgs } from "node:util";
import { Context, Effect, Schema } from "effect";
import { failure, Identity, type DeliveryError } from "./model.js";
import { Artifact, ReleaseCoordinator, ReleasePorts } from "./release-model.js";
import {
  bootstrapControl,
  NativeControlMigrations,
} from "./control-bootstrap.js";
import {
  ControlDatabase,
  ExecutorRef,
  makeControlCoordinator,
  sameIdentity,
} from "./release-control.js";
import { release } from "./release.js";

export interface EntryInput {
  readonly mode: "native" | "cli";
  readonly operation: "update" | "recover";
  readonly inputPath: string;
}
const Admission = Schema.Struct({
  identity: Identity,
  executorRef: ExecutorRef,
});
export type Admission = typeof Admission.Type;
export class EntryAuthorization extends Context.Tag(
  "delivery/EntryAuthorization",
)<
  EntryAuthorization,
  {
    // Supported provider/owner execution boundary; never infer authority from a
    // token, build UUID, CI flag or arbitrary JSON confirmation/evidence file.
    readonly admit: (
      input: EntryInput,
    ) => Effect.Effect<Admission, DeliveryError>;
  }
>() {}
export class EntryAdapters extends Context.Tag("delivery/EntryAdapters")<
  EntryAdapters,
  {
    // Pure clean build/target verification first; no DB side effects here.
    readonly prepare: (
      input: EntryInput,
      admission: Admission,
    ) => Effect.Effect<
      {
        readonly artifact: Artifact;
        readonly ports: typeof ReleasePorts.Service;
        readonly database: typeof ControlDatabase.Service;
        readonly bootstrap: typeof NativeControlMigrations.Service;
        readonly ownerId: string;
      },
      DeliveryError
    >;
  }
>() {}
export const deniedEntry: typeof EntryAuthorization.Service = {
  admit: (input) =>
    Effect.fail(
      failure(
        "authorization",
        input.mode === "native"
          ? "native-authorization-handoff-unproved"
          : "owner-execution-authorization-unconfigured",
      ),
    ),
};
export const entryCommand = (args: readonly string[]) =>
  Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () =>
        parseArgs({
          args: [...args],
          strict: true,
          allowPositionals: true,
          options: {
            "resolved-config": { type: "string" },
            identity: { type: "string" },
            operation: { type: "string" },
          },
        }),
      catch: () => failure("configuration", "release-entry-arguments-invalid"),
    });
    const mode = parsed.positionals[0] ?? "native";
    const operation = parsed.values.operation ?? "update";
    if (
      parsed.positionals.length > 1 ||
      (mode !== "native" && mode !== "cli") ||
      (operation !== "update" && operation !== "recover") ||
      (mode === "native" && parsed.values.identity) ||
      (mode === "cli" && parsed.values["resolved-config"])
    )
      return yield* Effect.fail(
        failure("configuration", "release-entry-arguments-invalid"),
      );
    const input: EntryInput = {
      mode,
      operation,
      inputPath:
        (mode === "native"
          ? parsed.values["resolved-config"]
          : parsed.values.identity) ?? "",
    };
    const authorization = yield* EntryAuthorization;
    const admitted = yield* authorization.admit(input).pipe(
      Effect.flatMap(Schema.decodeUnknown(Admission)),
      Effect.mapError(() =>
        failure(
          "authorization",
          mode === "native"
            ? "native-authorization-handoff-unproved"
            : "owner-execution-authorization-unconfigured",
        ),
      ),
    );
    if (!input.inputPath)
      return yield* Effect.fail(
        failure("configuration", "resolved-installation-input-required"),
      );
    const adapters = yield* EntryAdapters;
    const prepared = yield* adapters.prepare(input, admitted);
    const artifact = yield* Schema.decodeUnknown(Artifact)(
      prepared.artifact,
    ).pipe(Effect.mapError(() => failure("build", "entry-artifact-invalid")));
    if (
      !sameIdentity(admitted.identity, artifact.identity) ||
      !sameIdentity(prepared.database.identity, artifact.identity)
    )
      return yield* Effect.fail(
        failure("configuration", "entry-identity-mismatch"),
      );
    // All storage mutations start only after admission and complete build/verify.
    return yield* Effect.gen(function* () {
      yield* bootstrapControl();
      const coordinator = yield* makeControlCoordinator({
        artifact,
        ownerId: prepared.ownerId,
        executorRef: admitted.executorRef,
      });
      return yield* release({
        identity: artifact.identity,
        sourceRevision: artifact.sourceRevision,
        operation,
      }).pipe(
        Effect.provideService(ReleaseCoordinator, coordinator),
        Effect.provideService(ReleasePorts, {
          ...prepared.ports,
          build: () => Effect.succeed(artifact),
        }),
      );
    }).pipe(
      Effect.provideService(ControlDatabase, prepared.database),
      Effect.provideService(NativeControlMigrations, prepared.bootstrap),
    );
  });

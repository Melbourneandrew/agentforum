// Retained WO33 owner-CLI handoff only. No provisioning, migration, activation,
// domain changes or grant inference from token presence/read success.
import { Context, Effect, Option, Schema } from "effect";
import { withIdentityFile } from "./identity-file.js";
import {
  AccountId,
  Database,
  HostedOrigin,
  Identity,
  failure,
  type DeliveryError,
} from "./model.js";
import { IdentityStore } from "./provision.js";
import { Provider } from "./provider.js";
import { ExecutorRef, sameIdentity } from "./release-control.js";
import { cliIdentity } from "./release-config.js";
import type {
  EntryInput,
  EntryAuthorization,
} from "./release-entry-command.js";

const OwnerContext = Schema.Struct({
  accountId: AccountId,
  executorRef: ExecutorRef,
  identity: Schema.optional(Identity),
});
export class OwnerReleaseAccess extends Context.Tag(
  "delivery/OwnerReleaseAccess",
)<
  OwnerReleaseAccess,
  {
    // Supported execution boundary must establish owner/source/account/grants.
    // Neither a journal, env flag nor an arbitrary JSON assertion supplies it.
    readonly authorize: (
      input: EntryInput,
    ) => Effect.Effect<typeof OwnerContext.Type, DeliveryError>;
    readonly provider: Effect.Effect<typeof Provider.Service, DeliveryError>;
  }
>() {}
export const deniedOwnerAccess: typeof OwnerReleaseAccess.Service = {
  authorize: () =>
    Effect.fail(
      failure("authorization", "owner-execution-authorization-unconfigured"),
    ),
  provider: Effect.fail(
    failure("authorization", "owner-provider-unconfigured"),
  ),
};

export const verifyOwnerHandoff = (input: EntryInput) =>
  Effect.gen(function* () {
    if (input.mode !== "cli")
      return yield* Effect.fail(
        failure("authorization", "native-authorization-handoff-unproved"),
      );
    const access = yield* OwnerReleaseAccess;
    const context = yield* access.authorize(input).pipe(
      Effect.flatMap(Schema.decodeUnknown(OwnerContext)),
      Effect.mapError(() =>
        failure("authorization", "owner-execution-authorization-unconfigured"),
      ),
    );
    const store = yield* IdentityStore;
    const previous = yield* store.read;
    if (Option.isNone(previous))
      return yield* Effect.fail(
        failure("configuration", "retained-identity-required"),
      );
    const identity = yield* cliIdentity(previous.value);
    if (identity.accountId !== context.accountId)
      return yield* Effect.fail(
        failure("authorization", "owner-account-mismatch"),
      );
    if (context.identity && !sameIdentity(context.identity, identity))
      return yield* Effect.fail(
        failure("authorization", "parent-retained-identity-mismatch"),
      );
    // Construction/credential access is lazy and AFTER authority plus journal checks.
    const provider = yield* access.provider;
    const database = yield* provider
      .database(identity.accountId, identity.databaseId)
      .pipe(
        Effect.flatMap((value) =>
          Schema.decodeUnknown(Database)(value).pipe(
            Effect.mapError(() =>
              failure("provisioning", "retained-database-unverified"),
            ),
          ),
        ),
      );
    if (
      database.uuid !== identity.databaseId ||
      database.name !== identity.databaseName
    )
      return yield* Effect.fail(
        failure("provisioning", "retained-database-mismatch"),
      );
    const subdomain = yield* provider.subdomain(identity.accountId);
    const origin = yield* Schema.decodeUnknown(HostedOrigin)(
      `https://${identity.workerName}.${subdomain}.workers.dev`,
    ).pipe(
      Effect.mapError(() =>
        failure("configuration", "retained-origin-unverified"),
      ),
    );
    if (origin !== identity.defaultOrigin)
      return yield* Effect.fail(
        failure("configuration", "retained-origin-mismatch"),
      );
    const worker = yield* provider.worker(
      identity.accountId,
      identity.workerName,
    );
    if (Option.isSome(worker)) {
      const bindings = worker.value.bindings.filter(
        (binding) => binding.type === "d1",
      );
      if (
        bindings.length !== 1 ||
        bindings[0]?.name !== "DB" ||
        bindings[0].id !== identity.databaseId
      )
        return yield* Effect.fail(
          failure("provisioning", "retained-worker-binding-conflict"),
        );
    }
    return { identity, executorRef: context.executorRef };
  });

// Reuse secure outside-checkout WO33 journal handling; never rewrite/reprovision
// it. The short local file lock is NOT cross-entry D1 release serialization.
export const ownerEntryAuthorization = (
  repository: string,
  access: typeof OwnerReleaseAccess.Service,
): typeof EntryAuthorization.Service => ({
  admit: (input) =>
    input.mode !== "cli"
      ? Effect.fail(
          failure("authorization", "native-authorization-handoff-unproved"),
        )
      : Effect.gen(function* () {
          // Gate before file-lock acquisition/read. Cache only this invocation's
          // validated context, not ambient isolate/account state.
          const context = yield* access.authorize(input).pipe(
            Effect.flatMap(Schema.decodeUnknown(OwnerContext)),
            Effect.mapError(() =>
              failure(
                "authorization",
                "owner-execution-authorization-unconfigured",
              ),
            ),
          );
          return yield* withIdentityFile(
            input.inputPath,
            repository,
            verifyOwnerHandoff(input).pipe(
              Effect.provideService(OwnerReleaseAccess, {
                authorize: () => Effect.succeed(context),
                provider: access.provider,
              }),
            ),
          );
        }),
});

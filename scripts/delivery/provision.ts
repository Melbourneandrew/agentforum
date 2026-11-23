import { Context, Effect, Option, Schema } from "effect";
import { HostedOrigin, failure, handoff } from "./model.js";
import type {
  DeliveryError,
  Identity,
  Journal,
  Request,
  Target,
} from "./model.js";
import { Provider } from "./provider.js";

export class IdentityStore extends Context.Tag("delivery/IdentityStore")<
  IdentityStore,
  {
    readonly read: Effect.Effect<Option.Option<Journal>, DeliveryError>;
    readonly write: (journal: Journal) => Effect.Effect<void, DeliveryError>;
  }
>() {}
const sameTarget = (left: Target, right: Target) =>
  left.accountId === right.accountId &&
  left.workerName === right.workerName &&
  left.databaseName === right.databaseName;
export const provision = (request: Request) =>
  Effect.gen(function* () {
    const store = yield* IdentityStore;
    const provider = yield* Provider;
    const previous = yield* store.read;
    const retained = Option.flatMap(previous, (entry) =>
      entry.state === "resolved" ? Option.some(entry.identity) : Option.none(),
    );
    if (
      Option.isSome(previous) &&
      !sameTarget(
        previous.value.state === "resolved"
          ? previous.value.identity
          : previous.value.target,
        request,
      )
    )
      return yield* Effect.fail(
        failure("configuration", "retained-target-mismatch"),
      );
    if (
      Option.isSome(previous) &&
      previous.value.state === "intent" &&
      request.storage.mode === "create"
    )
      return yield* Effect.fail(
        failure("provisioning", "uncertain-create-requires-explicit-bind"),
      );
    if (
      Option.isSome(retained) &&
      request.storage.mode === "bind" &&
      request.storage.databaseId !== retained.value.databaseId
    )
      return yield* Effect.fail(
        failure("configuration", "retained-database-mismatch"),
      );
    // Read prerequisites before creation. No account/subdomain creation here.
    const subdomain = yield* provider.subdomain(request.accountId);
    const origin = yield* Schema.decodeUnknown(HostedOrigin)(
      `https://${request.workerName}.${subdomain}.workers.dev`,
    ).pipe(
      Effect.mapError(() => failure("configuration", "invalid-hosted-origin")),
    );
    if (Option.isSome(retained) && retained.value.defaultOrigin !== origin)
      return yield* Effect.fail(
        failure("configuration", "retained-origin-mismatch"),
      );
    const worker = yield* provider.worker(
      request.accountId,
      request.workerName,
    );
    const databaseId = Option.isSome(retained)
      ? Option.some(retained.value.databaseId)
      : request.storage.mode === "bind"
        ? Option.some(request.storage.databaseId)
        : Option.none<string>();
    if (Option.isSome(worker)) {
      const bindings = worker.value.bindings.filter(
        (binding) => binding.type === "d1",
      );
      if (
        Option.isNone(databaseId) ||
        bindings.length !== 1 ||
        bindings[0]?.name !== "DB" ||
        bindings[0].id !== databaseId.value
      )
        return yield* Effect.fail(
          failure("provisioning", "existing-worker-binding-conflict"),
        );
    }
    // Durable intent precedes the side effect. Ambiguous failures cannot silently
    // create another D1 on retry. No list-and-guess by database name.
    if (Option.isNone(previous))
      yield* store.write({
        state: "intent",
        target: {
          accountId: request.accountId,
          workerName: request.workerName,
          databaseName: request.databaseName,
        },
      });
    const database = Option.isSome(databaseId)
      ? yield* provider.database(request.accountId, databaseId.value)
      : yield* provider.create(request.accountId, request.databaseName);
    if (
      database.name !== request.databaseName ||
      (Option.isSome(databaseId) && database.uuid !== databaseId.value)
    )
      return yield* Effect.fail(
        failure("provisioning", "database-identity-mismatch"),
      );
    const identity: Identity = {
      version: 1,
      accountId: request.accountId,
      workerName: request.workerName,
      databaseName: database.name,
      databaseId: database.uuid,
      defaultOrigin: origin,
    };
    yield* store.write({ state: "resolved", identity });
    return handoff(identity);
  });

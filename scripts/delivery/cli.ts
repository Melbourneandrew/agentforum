import { parseArgs } from "node:util";
import { Effect } from "effect";
import { failure } from "./model.js";
import type { DeliveryError, Request } from "./model.js";
import { Provider } from "./provider.js";
import { IdentityStore, provision } from "./provision.js";

export interface CliAdapters {
  readonly readRequest: (path: string) => Effect.Effect<Request, DeliveryError>;
  readonly provider: Effect.Effect<typeof Provider.Service, DeliveryError>;
  readonly withIdentity: (
    path: string,
    use: Effect.Effect<void, DeliveryError, IdentityStore>,
  ) => Effect.Effect<void, DeliveryError>;
  readonly output: (text: string) => void;
}
export const command = (args: readonly string[], adapters: CliAdapters) =>
  Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () =>
        parseArgs({
          args: [...args],
          strict: true,
          allowPositionals: true,
          options: {
            request: { type: "string" },
            identity: { type: "string" },
            "allow-provider": { type: "boolean" },
            confirm: { type: "boolean" },
            "source-authorized": { type: "boolean" },
            cancel: { type: "boolean" },
          },
        }),
      catch: () => failure("configuration", "invalid-cli-arguments"),
    });
    const { values, positionals } = parsed;
    if (values.cancel)
      return yield* Effect.fail(failure("authorization", "cancelled"));
    if (
      positionals.length !== 1 ||
      (positionals[0] !== "plan" && positionals[0] !== "provision") ||
      !values.request
    )
      return yield* Effect.fail(
        failure("configuration", "expected-plan-or-provision-and-request"),
      );
    if (
      positionals[0] === "provision" &&
      (!values["allow-provider"] ||
        !values.confirm ||
        !values["source-authorized"] ||
        !values.identity)
    )
      return yield* Effect.fail(
        failure(
          "authorization",
          "explicit-provider-source-confirmation-required",
        ),
      );
    const request = yield* adapters.readRequest(values.request);
    if (positionals[0] === "plan") {
      adapters.output(
        JSON.stringify({
          status: "plan-only-not-installed",
          target: request,
          providerExecution: "not-run",
          next: "Explicit owner authorization is required for provisioning; WO-34 owns build, migrations, activation and readiness.",
        }),
      );
      return;
    }
    // No credential access or transport construction before the explicit gates.
    const provider = yield* adapters.provider;
    const action = provision(request).pipe(
      Effect.provideService(Provider, provider),
      Effect.tap((result) =>
        Effect.sync(() => {
          adapters.output(JSON.stringify(result));
        }),
      ),
      Effect.asVoid,
    );
    if (!values.identity)
      return yield* Effect.fail(failure("configuration", "identity-required"));
    yield* adapters.withIdentity(values.identity, action);
  });

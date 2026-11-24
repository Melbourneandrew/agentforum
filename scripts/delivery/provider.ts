import { Context, Effect, Option, Schema } from "effect";
import { Database, failure } from "./model.js";
import type { DeliveryError } from "./model.js";

const Subdomain = Schema.Struct({
  subdomain: Schema.String.pipe(
    Schema.pattern(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/),
  ),
});
const Settings = Schema.Struct({
  bindings: Schema.Array(
    Schema.Struct({
      type: Schema.String,
      name: Schema.String,
      id: Schema.optional(Schema.String),
    }),
  ),
});
export class Provider extends Context.Tag("delivery/Provider")<
  Provider,
  {
    readonly subdomain: (
      account: string,
    ) => Effect.Effect<string, DeliveryError>;
    readonly worker: (
      account: string,
      name: string,
    ) => Effect.Effect<Option.Option<typeof Settings.Type>, DeliveryError>;
    readonly database: (
      account: string,
      id: string,
    ) => Effect.Effect<Database, DeliveryError>;
    readonly create: (
      account: string,
      name: string,
    ) => Effect.Effect<Database, DeliveryError>;
  }
>() {}

// Injected transport only. Endpoints match the Cloudflare v4 API used by pinned
// Wrangler. No login, credential discovery, migrations, Worker or domain writes.
export const cloudflare = (
  transport: typeof fetch,
  token: string,
): typeof Provider.Service => {
  const request = <A, I>(
    account: string,
    path: string,
    schema: Schema.Schema<A, I>,
    method: "GET" | "POST" = "GET",
    body?: string,
    allowMissing = false,
  ) =>
    Effect.gen(function* () {
      const response = yield* Effect.tryPromise({
        try: () =>
          transport(
            `https://api.cloudflare.com/client/v4/accounts/${account}${path}`,
            {
              method,
              headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
              },
              ...(body === undefined ? {} : { body }),
              redirect: "error",
              signal: AbortSignal.timeout(30_000),
            },
          ),
        catch: () => failure("provisioning", "provider-transport-uncertain"),
      });
      if (response.status === 401 || response.status === 403)
        return yield* Effect.fail(failure("authorization", "provider-denied"));
      if (allowMissing && response.status === 404) return Option.none<A>();
      if (!response.ok)
        return yield* Effect.fail(
          failure("provisioning", "provider-http-failure"),
        );
      const raw: unknown = yield* Effect.tryPromise({
        try: () => response.json(),
        catch: () => failure("provisioning", "provider-invalid-json"),
      });
      const envelope = yield* Schema.decodeUnknown(
        Schema.Struct({ success: Schema.Literal(true), result: schema }),
      )(raw).pipe(
        Effect.mapError(() =>
          failure("provisioning", "provider-invalid-response"),
        ),
      );
      return Option.some(envelope.result);
    });
  const required = <A>(value: Option.Option<A>) =>
    Option.match(value, {
      onNone: () =>
        Effect.fail(failure("provisioning", "provider-missing-result")),
      onSome: Effect.succeed,
    });
  return {
    subdomain: (account) =>
      request(account, "/workers/subdomain", Subdomain).pipe(
        Effect.flatMap(required),
        Effect.map((value) => value.subdomain),
      ),
    worker: (account, name) =>
      request(
        account,
        `/workers/scripts/${name}/settings`,
        Settings,
        "GET",
        undefined,
        true,
      ),
    database: (account, id) =>
      request(account, `/d1/database/${id}`, Database).pipe(
        Effect.flatMap(required),
      ),
    create: (account, name) =>
      request(
        account,
        "/d1/database",
        Database,
        "POST",
        JSON.stringify({ name }),
      ).pipe(Effect.flatMap(required)),
  };
};

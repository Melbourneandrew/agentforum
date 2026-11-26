// Fixed Cloudflare v4 endpoints, authenticated transport supplied only by the
// admitted parent executor. Never discovers credentials or retries mutations.
import { Effect, Schema } from "effect";
import { DatabaseId, Identity, failure, type DeliveryError } from "./model.js";
import type { ControlDatabase } from "./release-control.js";

const Rows = Schema.Array(
  Schema.Record({ key: Schema.String, value: Schema.Unknown }),
);
const QueryResult = Schema.Array(
  Schema.Struct({ success: Schema.Literal(true), results: Rows }),
).pipe(Schema.itemsCount(1));
const Deployments = Schema.Struct({
  deployments: Schema.Array(
    Schema.Struct({
      id: DatabaseId,
      versions: Schema.Array(
        Schema.Struct({ version_id: DatabaseId, percentage: Schema.Number }),
      ),
    }),
  ),
});
const Version = Schema.Struct({
  id: DatabaseId,
  annotations: Schema.Record({ key: Schema.String, value: Schema.String }),
  resources: Schema.Struct({
    bindings: Schema.Array(
      Schema.Struct({
        type: Schema.String,
        name: Schema.String,
        id: Schema.optional(Schema.String),
      }),
    ),
  }),
});
export const remoteProvider = (identity: Identity, transport: typeof fetch) => {
  const request = <A, I>(
    path: string,
    schema: Schema.Schema<A, I>,
    body?: string,
  ): Effect.Effect<A, DeliveryError> =>
    Effect.gen(function* () {
      const response = yield* Effect.tryPromise({
        try: () =>
          transport(
            `https://api.cloudflare.com/client/v4/accounts/${identity.accountId}${path}`,
            {
              method: body === undefined ? "GET" : "POST",
              redirect: "error",
              headers: { "Content-Type": "application/json" },
              ...(body === undefined ? {} : { body }),
              signal: AbortSignal.timeout(30_000),
            },
          ),
        catch: () => failure("deployment", "remote-response-unknown"),
      });
      if (response.status === 401 || response.status === 403)
        return yield* Effect.fail(failure("authorization", "provider-denied"));
      if (!response.ok)
        return yield* Effect.fail(
          failure("deployment", "remote-response-unverified"),
        );
      const raw: unknown = yield* Effect.tryPromise({
        try: () => response.json(),
        catch: () => failure("deployment", "remote-response-unreadable"),
      });
      return (yield* Schema.decodeUnknown(
        Schema.Struct({ success: Schema.Literal(true), result: schema }),
      )(raw).pipe(
        Effect.mapError(() => failure("deployment", "remote-response-invalid")),
      )).result;
    });
  const database: typeof ControlDatabase.Service = {
    identity,
    query: (sql, params) =>
      request(
        `/d1/database/${identity.databaseId}/query`,
        QueryResult,
        JSON.stringify({ sql, params }),
      ).pipe(Effect.map((result) => result[0]?.results ?? [])),
  };
  return {
    database,
    // Pinned Wrangler's fetchLatestDeployments uses result.deployments[0].
    current: (versionId: string, message: string) =>
      Effect.gen(function* () {
        const id = yield* Schema.decodeUnknown(DatabaseId)(versionId).pipe(
          Effect.mapError(() => failure("deployment", "version-id-invalid")),
        );
        const base = `/workers/scripts/${identity.workerName}`;
        const deployments = yield* request(`${base}/deployments`, Deployments);
        const current = deployments.deployments[0];
        if (
          current?.versions.length !== 1 ||
          current.versions[0]?.version_id !== id ||
          current.versions[0].percentage !== 100
        )
          return yield* Effect.fail(
            failure("deployment", "current-deployment-mismatch"),
          );
        const version = yield* request(`${base}/versions/${id}`, Version);
        const bindings = version.resources.bindings.filter(
          (binding) => binding.type === "d1",
        );
        if (
          version.id !== id ||
          version.annotations["workers/message"] !== message ||
          bindings.length !== 1 ||
          bindings[0]?.name !== "DB" ||
          bindings[0].id !== identity.databaseId
        )
          return yield* Effect.fail(
            failure("deployment", "current-version-mismatch"),
          );
        // Re-read current traffic after the version read. Not a fence for an
        // unrelated external deploy; all supported entries must honor D1 ownership.
        const reread = yield* request(`${base}/deployments`, Deployments);
        if (JSON.stringify(reread.deployments[0]) !== JSON.stringify(current))
          return yield* Effect.fail(
            failure("deployment", "current-deployment-changed"),
          );
        return current.id;
      }),
  };
};

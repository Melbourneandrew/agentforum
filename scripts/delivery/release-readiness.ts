import { Context, Effect, Schema } from "effect";
import { failure } from "./model.js";
import type { DeliveryError } from "./model.js";
import type { Activation, Artifact } from "./release-model.js";
import { Readiness } from "./release-model.js";

export class ReadinessHttp extends Context.Tag("delivery/ReadinessHttp")<
  ReadinessHttp,
  {
    readonly request: (
      request: Request,
    ) => Effect.Effect<Response, DeliveryError>;
  }
>() {}
// Contract location is explicit input from the accepted docs/build interface;
// this module does not invent a new public route or discovery endpoint.
export const inspectReadiness = (
  artifact: Artifact,
  activation: Activation,
  contractPath: string,
) =>
  Effect.gen(function* () {
    if (!/^\/[a-zA-Z0-9/_-]+\.json$/.test(contractPath))
      return yield* Effect.fail(
        failure("configuration", "contract-path-required"),
      );
    if (
      activation.sourceRevision !== artifact.sourceRevision ||
      activation.artifactDigest !== artifact.artifactDigest
    )
      return yield* Effect.fail(
        failure("readiness", "activation-receipt-mismatch"),
      );
    const http = yield* ReadinessHttp;
    const origin = artifact.identity.defaultOrigin;
    const get = (path: string) =>
      Effect.gen(function* () {
        const response = yield* http.request(
          new Request(`${origin}${path}`, { redirect: "manual" }),
        );
        if (response.status !== 200 || response.redirected)
          return yield* Effect.fail(
            failure("readiness", "required-surface-unavailable"),
          );
        return yield* Effect.tryPromise({
          try: () => response.text(),
          catch: () => failure("readiness", "required-surface-unreadable"),
        });
      });
    const web = yield* get("/");
    const docs = yield* get("/docs/");
    if (
      !web.includes("<main") ||
      web.includes("Local D1 binding available") ||
      !docs.includes("<main") ||
      docs.includes("not a complete installation")
    )
      return yield* Effect.fail(
        failure("readiness", "incomplete-observation-or-docs"),
      );
    const guide = yield* get("/llms.txt");
    const skill = yield* get("/skill.md");
    if (
      guide !== skill ||
      !guide.includes(`${origin}/docs`) ||
      !guide.includes(`${origin}/v1`)
    )
      return yield* Effect.fail(
        failure("readiness", "discovery-origin-or-parity-failed"),
      );
    const contractText = yield* get(contractPath);
    const contract = yield* Schema.decodeUnknown(
      Schema.parseJson(
        Schema.Struct({
          servers: Schema.Array(Schema.Struct({ url: Schema.String })),
          paths: Schema.Record({
            key: Schema.String,
            value: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
          }),
        }),
      ),
    )(contractText).pipe(
      Effect.mapError(() => failure("readiness", "contract-unavailable")),
    );
    if (
      !contract.servers.length ||
      contract.servers.some((server) => server.url !== origin)
    )
      return yield* Effect.fail(
        failure("readiness", "contract-origin-mismatch"),
      );
    for (const operation of ["register", "publish", "search"]) {
      const path = contract.paths[`/v1/${operation}`];
      if (!path || !Object.hasOwn(path, "get") || !Object.hasOwn(path, "post"))
        return yield* Effect.fail(
          failure("readiness", "contract-operation-incomplete"),
        );
    }
    // Only unauthenticated, non-mutating search probes on an owner installation.
    // Register/publish/retention qualification needs a separately scoped disposable
    // installation; never seed or mutate a live owner's data during readiness.
    for (const method of ["GET", "POST"]) {
      const body = JSON.stringify({ limit: 1 });
      const request = new Request(
        `${origin}/v1/search${method === "GET" ? `?payload=${encodeURIComponent(body)}` : ""}`,
        {
          method,
          headers: { "Content-Type": "application/json" },
          redirect: "manual",
          ...(method === "POST" ? { body } : {}),
        },
      );
      const response = yield* http.request(request);
      if (response.status !== 200 || response.redirected)
        return yield* Effect.fail(failure("readiness", "api-read-unavailable"));
      const raw: unknown = yield* Effect.tryPromise({
        try: () => response.json(),
        catch: () => failure("readiness", "api-read-invalid"),
      });
      yield* Schema.decodeUnknown(
        Schema.Struct({
          posts: Schema.Array(Schema.Unknown),
          readCursor: Schema.String,
        }),
      )(raw).pipe(
        Effect.mapError(() => failure("readiness", "api-read-invalid")),
      );
    }
    return yield* Schema.decodeUnknown(Readiness)({
      sourceRevision: artifact.sourceRevision,
      artifactDigest: artifact.artifactDigest,
      defaultOrigin: origin,
      checks: {
        website: true,
        docs: true,
        discovery: true,
        contract: true,
        apiReads: true,
      },
    }).pipe(
      Effect.mapError(() => failure("readiness", "readiness-receipt-invalid")),
    );
  });

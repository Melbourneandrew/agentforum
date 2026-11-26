import { Context, Effect, Schema } from "effect";
import {
  discoveryPaths,
  discoveryResponse,
} from "../../apps/forum/src/discovery/responses.js";
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
// Accepted Docs32 static contract. The documentation index is NOT the root
// System Discovery Guide; missing WO-30 assets must still fail readiness.
export const DOCS_OPENAPI_PATH = "/docs/openapi.json";
// Metadata-only probe of the accepted WO30 representations. Caller supplies the
// already trusted installation origin; never derive it from request/CI input.
// Passing this probe is NOT complete website/provider/release acceptance.
export const inspectDiscovery = (origin: string) =>
  Effect.gen(function* () {
    const http = yield* ReadinessHttp;
    const get = (path: string) =>
      Effect.gen(function* () {
        const response = yield* http.request(
          new Request(`${origin}${path}`, { redirect: "manual" }),
        );
        if (response.status !== 200 || response.redirected)
          return yield* Effect.fail(
            failure("readiness", "discovery-unavailable"),
          );
        return response;
      });
    const text = (response: Response) =>
      Effect.tryPromise({
        try: () => response.text(),
        catch: () => failure("readiness", "discovery-unreadable"),
      });
    const guide = yield* text(yield* get("/llms.txt"));
    const skill = yield* text(yield* get("/skill.md"));
    const packaged = yield* text(yield* get("/skills/agentforum/SKILL.md"));
    if (
      guide !== skill ||
      !guide.startsWith("# Agent Forum System Discovery Guide\n") ||
      !packaged.startsWith("---\nname: agentforum\ndescription:") ||
      !packaged.endsWith(guide)
    )
      return yield* Effect.fail(
        failure("readiness", "discovery-guide-or-skill-mismatch"),
      );
    const links = yield* Effect.try({
      try: () =>
        Array.from(guide.matchAll(/\]\(([^)]+)\)/g), (match) => {
          const target = match[1];
          if (!target) throw new Error("missing local link");
          return new URL(target, origin);
        }),
      catch: () => failure("readiness", "discovery-link-invalid"),
    });
    if (
      links.some((url) => url.origin !== origin) ||
      [
        "/",
        "/v1",
        "/docs/",
        "/docs/openapi.json",
        "/docs/post.schema.json",
        "/skills/agentforum/SKILL.md",
        ...discoveryPaths,
      ].some((path) => !links.some((url) => url.pathname === path))
    )
      return yield* Effect.fail(
        failure("readiness", "discovery-origin-or-inventory-failed"),
      );
    const schemaText = yield* text(yield* get("/docs/post.schema.json"));
    yield* Schema.decodeUnknown(
      Schema.parseJson(
        Schema.Struct({
          $schema: Schema.NonEmptyString,
          $ref: Schema.Literal("#/$defs/PostResult"),
          $defs: Schema.Struct({
            PostResult: Schema.Record({
              key: Schema.String,
              value: Schema.Unknown,
            }),
            PublishInput: Schema.Record({
              key: Schema.String,
              value: Schema.Unknown,
            }),
          }),
          "x-schema-version": Schema.NonEmptyString,
          "x-api-path-version": Schema.Literal("v1"),
        }),
      ),
    )(schemaText).pipe(
      Effect.mapError(() =>
        failure("readiness", "discovery-post-schema-invalid"),
      ),
    );
    // Consume the shared pure source, not a second hand-maintained catalog or
    // agents schema. Exactly four approved GET descriptions, no business writes.
    for (const path of discoveryPaths) {
      const response = yield* get(path);
      const expected = discoveryResponse(path, origin);
      if (
        response.headers.get("Content-Type") !==
          expected.headers.get("Content-Type") ||
        response.headers.get("Link") !== expected.headers.get("Link") ||
        (yield* text(response)) !== (yield* text(expected))
      )
        return yield* Effect.fail(
          failure("readiness", "discovery-description-mismatch"),
        );
    }
  });

export const inspectReadiness = (
  artifact: Artifact,
  activation: Activation,
  contractPath: string = DOCS_OPENAPI_PATH,
) =>
  Effect.gen(function* () {
    if (contractPath !== DOCS_OPENAPI_PATH)
      return yield* Effect.fail(
        failure("configuration", "unsupported-contract-path"),
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
    yield* inspectDiscovery(origin);
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
      contract.servers.some(
        (server) => server.url !== "/" && server.url !== origin,
      )
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

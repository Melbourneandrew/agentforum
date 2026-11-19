import type {
  D1Database,
  ExecutionContext,
  Fetcher,
} from "@cloudflare/workers-types/index.ts";
import { Context, Data, Effect, Layer, Schema } from "effect";

export interface Bindings {
  readonly DB: D1Database;
  readonly ASSETS: Fetcher;
  readonly CANONICAL_ORIGIN?: string;
}
export type Execution = Pick<
  ExecutionContext,
  "waitUntil" | "passThroughOnException" | "props"
>;
export class InvalidOrigin extends Data.TaggedError("InvalidOrigin")<{
  readonly configuration: boolean;
}> {}
const Origin = Schema.String.pipe(
  Schema.filter((value) => {
    try {
      const url = new URL(value);
      return (
        url.origin === value &&
        url.protocol === "https:" &&
        !url.username &&
        !url.password
      );
    } catch {
      return false;
    }
  }),
);
const Configuration = Schema.Struct({
  CANONICAL_ORIGIN: Schema.optional(Origin),
});
const providerHost =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.workers\.dev$/;
export const installationOrigin = (request: Request, bindings: unknown) =>
  Effect.gen(function* () {
    const config = yield* Schema.decodeUnknown(Configuration)(bindings).pipe(
      Effect.mapError(() => new InvalidOrigin({ configuration: true })),
    );
    const url = yield* Schema.decodeUnknown(Schema.URL)(request.url).pipe(
      Effect.mapError(() => new InvalidOrigin({ configuration: false })),
    );
    const local =
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    const provider =
      url.protocol === "https:" && providerHost.test(url.hostname) && !url.port;
    const configured = config.CANONICAL_ORIGIN === url.origin;
    const host = request.headers.get("Host");
    return yield* Effect.succeed(config.CANONICAL_ORIGIN ?? url.origin).pipe(
      Effect.filterOrFail(
        () =>
          !url.username &&
          !url.password &&
          (local || provider || configured) &&
          (host === null || host.toLowerCase() === url.host),
        () => new InvalidOrigin({ configuration: false }),
      ),
    );
  });
export class RequestContext extends Context.Tag(
  "@agentforum/forum/RequestContext",
)<
  RequestContext,
  {
    readonly bindings: Bindings;
    readonly execution: Execution;
    readonly origin: string;
    readonly correlationId: string;
  }
>() {}
export const requestLayer = (
  bindings: Bindings,
  execution: Execution,
  origin: string,
  correlationId: string,
) =>
  Layer.succeed(RequestContext, { bindings, execution, origin, correlationId });

export class DependencyUnavailable extends Data.TaggedError(
  "DependencyUnavailable",
) {}
export class PublicQueries extends Context.Tag(
  "@agentforum/forum/PublicQueries",
)<
  PublicQueries,
  {
    readonly runtime: Effect.Effect<
      { readonly database: "available" },
      DependencyUnavailable
    >;
  }
>() {}
// Real, bounded D1 query. Domain query interfaces are owned by WO-42/43.
export const publicQueries = Layer.effect(
  PublicQueries,
  Effect.gen(function* () {
    const { bindings } = yield* RequestContext;
    return {
      runtime: Effect.tryPromise({
        try: () => bindings.DB.prepare("SELECT 1 AS ready").first(),
        catch: () => new DependencyUnavailable(),
      }).pipe(
        Effect.flatMap(
          Schema.decodeUnknown(Schema.Struct({ ready: Schema.Literal(1) })),
        ),
        Effect.map(() => ({ database: "available" as const })),
        Effect.mapError(() => new DependencyUnavailable()),
      ),
    };
  }),
);
export interface PageContext {
  readonly origin: string;
  readonly runtime: () => Promise<{ readonly database: "available" }>;
}
declare module "react-router" {
  interface AppLoadContext {
    forum: PageContext;
  }
}

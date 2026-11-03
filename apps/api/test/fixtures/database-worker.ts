import { Cause, Effect, Exit, Option, Redacted, Schema } from "effect";
import { sql } from "drizzle-orm";
import {
  CachedDatabase,
  DirectDatabase,
  cachedDatabaseLayer,
  databaseBindingsLayer,
  directDatabaseLayer,
} from "../../src/database/database.js";
import {
  DatabaseConnectionTimeoutProblem,
  databaseTimeoutProblem,
} from "../../src/database/problems.js";

import {
  ProbeInput,
  ProbeResult,
  ProbeFailure,
  readProbeJson,
  transactionProbe,
} from "./transaction-probe.js";
import { ConnectionInfo } from "./database-schema.js";
const Authorization = Schema.Struct({
  DATABASE_SMOKE_TOKEN: Schema.Redacted(Schema.NonEmptyString),
});
const FaultBindings = Schema.Struct({
  HYPERDRIVE_CACHED: Schema.Unknown,
  HYPERDRIVE_TIMEOUT: Schema.optionalWith(Schema.Unknown, { as: "Option" }),
  HYPERDRIVE_SATURATED: Schema.optionalWith(Schema.Unknown, { as: "Option" }),
});
const Failure = Schema.Struct({
  type: Schema.String,
  title: Schema.String,
  status: Schema.Int,
  detail: Schema.String,
  instance: Schema.String,
});
const failure = (status: number, id: string) =>
  Response.json(
    Schema.encodeSync(Failure)({
      type: "about:blank",
      title:
        status === 401
          ? "Unauthorized"
          : status === 404
            ? "Not found"
            : "Internal server error",
      status,
      detail: "The fixture request could not be completed.",
      instance: `urn:uuid:${id}`,
    }),
    {
      status,
      headers: {
        "Content-Type": "application/problem+json",
        "Cache-Control": "no-store",
      },
    },
  );

// Verification-only Worker. Never route it onto a public product domain. Delivery
// must bind real Hyperdrive resources and a fresh private smoke token in Actions.
export default {
  async fetch(request: Request, bindings: unknown): Promise<Response> {
    const correlationId = crypto.randomUUID();
    if (request.method === "HEAD" || request.method === "OPTIONS")
      return new Response(null, {
        status: request.method === "HEAD" ? 200 : 204,
      });
    const auth = Schema.decodeUnknownEither(Authorization)(bindings);
    if (auth._tag === "Left") return failure(500, correlationId);
    if (
      request.headers.get("Authorization") !==
      `Bearer ${Redacted.value(auth.right.DATABASE_SMOKE_TOKEN)}`
    )
      return failure(401, correlationId);
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === "/transaction") {
      const outcome = await Effect.runPromiseExit(
        Effect.tryPromise({
          try: () => readProbeJson(request.body),
          catch: () => new ProbeFailure(),
        }).pipe(
          Effect.flatMap(Schema.decodeUnknown(ProbeInput)),
          Effect.flatMap(transactionProbe),
          Effect.provide(databaseBindingsLayer(bindings)),
        ),
        { signal: request.signal },
      );
      if (Exit.isFailure(outcome)) return failure(500, correlationId);
      return Response.json(Schema.encodeSync(ProbeResult)(outcome.value), {
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (
      request.method !== "GET" ||
      !["/direct", "/cached", "/timeout", "/saturated"].includes(path)
    )
      return failure(404, correlationId);
    let effectiveBindings = bindings;
    if (path === "/timeout" || path === "/saturated") {
      const configured = Schema.decodeUnknownEither(FaultBindings)(bindings);
      if (configured._tag === "Left") return failure(500, correlationId);
      const selected =
        path === "/timeout"
          ? configured.right.HYPERDRIVE_TIMEOUT
          : configured.right.HYPERDRIVE_SATURATED;
      if (Option.isNone(selected)) return failure(500, correlationId);
      effectiveBindings = {
        HYPERDRIVE_DIRECT: selected.value,
        HYPERDRIVE_CACHED: configured.right.HYPERDRIVE_CACHED,
      };
    }
    const direct = Effect.flatMap(DirectDatabase, (database) =>
      database.execute(
        () =>
          sql`SELECT pg_backend_pid()::integer AS pid, current_database() AS database`,
        ConnectionInfo,
      ),
    ).pipe(Effect.provide(directDatabaseLayer));
    const cached = Effect.flatMap(CachedDatabase, (database) =>
      database.read(
        (builder) =>
          builder
            .select({
              pid: sql<number>`pg_backend_pid()`.as("pid"),
              database: sql<string>`current_database()`.as("database"),
            })
            .from(sql`(VALUES (1)) AS fixture(n)`),
        ConnectionInfo,
      ),
    ).pipe(Effect.provide(cachedDatabaseLayer));
    const outcome = await Effect.runPromiseExit(
      (path === "/cached" ? cached : direct).pipe(
        Effect.flatMap(Schema.decodeUnknown(Schema.Tuple(ConnectionInfo))),
        Effect.map((rows) => rows[0]),
        Effect.provide(databaseBindingsLayer(effectiveBindings)),
      ),
      { signal: request.signal },
    );
    if (Exit.isFailure(outcome)) {
      const known = Cause.failureOption(outcome.cause);
      if (
        Option.exists(
          known,
          (error) => error._tag === "DatabaseConnectionTimeoutError",
        )
      ) {
        return Response.json(
          Schema.encodeSync(DatabaseConnectionTimeoutProblem)(
            databaseTimeoutProblem(correlationId),
          ),
          {
            status: 503,
            headers: {
              "Content-Type": "application/problem+json",
              "Retry-After": "1",
              "Cache-Control": "no-store",
            },
          },
        );
      }
      return failure(500, correlationId);
    }
    return Response.json(Schema.encodeSync(ConnectionInfo)(outcome.value), {
      headers: { "Cache-Control": "no-store" },
    });
  },
};

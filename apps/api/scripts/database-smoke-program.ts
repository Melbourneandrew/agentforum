import { Context, Data, Effect, Layer, Redacted, Schema } from "effect";
import { ConnectionInfo } from "../test/fixtures/database-schema.js";
import {
  ProbeInput,
  ProbeResult,
  readProbeJson,
} from "../test/fixtures/transaction-probe.js";
export class DatabaseSmokeError extends Data.TaggedError(
  "DatabaseSmokeError",
) {}
export class SmokeTransport extends Context.Tag("@agentforum/smoke/Transport")<
  SmokeTransport,
  {
    readonly request: (
      path: string,
      input: Schema.Schema.Type<typeof ProbeInput> | "read",
    ) => Effect.Effect<unknown, DatabaseSmokeError>;
  }
>() {}
export const smokeTransportLayer = (origin: string, token: Redacted.Redacted) =>
  Layer.succeed(SmokeTransport, {
    request: (path, input) =>
      Effect.tryPromise({
        try: async (signal) => {
          const response = await fetch(`${origin}${path}`, {
            method: input === "read" ? "GET" : "POST",
            redirect: "error",
            headers: {
              Authorization: `Bearer ${Redacted.value(token)}`,
              "Content-Type": "application/json",
            },
            ...(input === "read" ? {} : { body: JSON.stringify(input) }),
            signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
          });
          if (response.status !== 200) {
            await response.body?.cancel();
            throw new DatabaseSmokeError();
          }
          return readProbeJson(response.body);
        },
        catch: () => new DatabaseSmokeError(),
      }),
  });
export const runDatabaseSmoke = (
  directDatabase: string,
  cachedDatabase: string,
) =>
  Effect.gen(function* () {
    const transport = yield* SmokeTransport;
    for (const [path, expected] of [
      ["/direct", directDatabase],
      ["/cached", cachedDatabase],
    ] as const) {
      const response = yield* transport
        .request(path, "read")
        .pipe(Effect.flatMap(Schema.decodeUnknown(ConnectionInfo)));
      yield* Effect.filterOrFail(
        Effect.succeed(response.database),
        (value) => value === expected,
        () => new DatabaseSmokeError(),
      );
    }
    for (const mode of ["commit", "rollback", "interrupt"] as const) {
      const response = yield* transport
        .request("/transaction", { mode, marker: crypto.randomUUID() })
        .pipe(Effect.flatMap(Schema.decodeUnknown(ProbeResult)));
      yield* Effect.filterOrFail(
        Effect.succeed(response),
        (value) =>
          value.mode === mode &&
          value.persisted === (mode === "commit") &&
          value.transactionCleared &&
          value.sleepObserved === (mode === "interrupt") &&
          value.interrupted === (mode === "interrupt"),
        () => new DatabaseSmokeError(),
      );
    }
  });
export const SmokeEnvironment = Schema.Struct({
  GITHUB_ACTIONS: Schema.Literal("true"),
  DATABASE_SMOKE_ORIGIN: Schema.String.pipe(
    Schema.filter((value) => {
      try {
        const url = new URL(value);
        return (
          url.protocol === "https:" &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash &&
          url.pathname === "/"
        );
      } catch {
        return false;
      }
    }),
  ),
  DATABASE_SMOKE_TOKEN: Schema.Redacted(Schema.NonEmptyString),
  DATABASE_SMOKE_DATABASE: Schema.NonEmptyString,
});

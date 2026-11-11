import { tracing } from "cloudflare:workers";
import type { Span, Tracing } from "@cloudflare/workers-types/index.ts";
import {
  Cause,
  Context,
  Data,
  Effect,
  Exit,
  Layer,
  Option,
  Schema,
} from "effect";

const Operation = Schema.Literal(
  "identity.insert",
  "credential.lookup",
  "publication.edge_signal",
  "publication.rate_limit",
  "publication.transaction",
);
type Operation = Schema.Schema.Type<typeof Operation>;
// This private vocabulary cannot receive SQL, identifiers, inputs or errors.
const operationAttributes = (operation: Operation) => ({
  "service.name": "agentforum-api",
  "agentforum.operation": operation,
  ...(operation === "publication.edge_signal"
    ? { "agentforum.dependency": "edge-rate-limit" }
    : {
        "db.system.name": "postgresql",
        "db.operation.name":
          operation === "identity.insert"
            ? "INSERT"
            : operation === "credential.lookup"
              ? "SELECT"
              : "TRANSACTION",
      }),
});
class InstrumentationFailure extends Data.TaggedError(
  "InstrumentationFailure",
) {}
const bestEffort = <A>(action: () => A) =>
  Effect.try({ try: action, catch: () => new InstrumentationFailure() }).pipe(
    Effect.option,
  );

export class OperationalTracing extends Context.Tag(
  "@agentforum/api/OperationalTracing",
)<
  OperationalTracing,
  {
    readonly operation: <A, E, R>(
      operation: Operation,
      program: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
  }
>() {}

// Structural driver injection verifies our lifecycle contract, not platform
// export. Production always uses the genuine cloudflare:workers tracing API.
interface Handle {
  readonly setAttributes: (
    attributes: Parameters<Span["setAttributes"]>[0],
  ) => void;
  readonly setStatus: (status: Parameters<Span["setStatus"]>[0]) => void;
  readonly end: () => void;
}
interface Driver {
  readonly startSpan: (name: string) => Handle;
}
export const operationalTracingLayer = (driver: Driver) =>
  Layer.succeed(OperationalTracing, {
    operation: <A, E, R>(
      operation: Operation,
      program: Effect.Effect<A, E, R>,
    ) =>
      Effect.acquireUseRelease(
        // Validate even this internal runtime boundary: never send arbitrary
        // caller strings to native span names or attributes.
        Schema.decodeUnknown(Operation)(operation).pipe(
          Effect.flatMap((name) => bestEffort(() => driver.startSpan(name))),
          Effect.catchAll(() => Effect.succeed(Option.none<Handle>())),
        ),
        (handle) =>
          Effect.gen(function* () {
            if (Option.isSome(handle)) {
              yield* bestEffort(() => {
                handle.value.setAttributes(operationAttributes(operation));
              });
            }
            return yield* program.pipe(
              Effect.onExit((exit) =>
                Option.match(handle, {
                  onNone: () => Effect.void,
                  onSome: (span) =>
                    bestEffort(() => {
                      const outcome = Exit.isSuccess(exit)
                        ? "success"
                        : Cause.isInterruptedOnly(exit.cause)
                          ? "interrupted"
                          : "failure";
                      span.setAttributes({ "agentforum.outcome": outcome });
                      span.setStatus({
                        code: outcome === "success" ? "ok" : "error",
                      });
                    }).pipe(Effect.asVoid),
                }),
              ),
            );
          }),
        (handle) =>
          Option.match(handle, {
            onNone: () => Effect.void,
            onSome: (span) =>
              bestEffort(() => {
                span.end();
              }).pipe(Effect.asVoid),
          }),
      ),
  });
const native: Pick<Tracing, "startSpan"> = tracing;
export const nativeOperationalTracingLayer = operationalTracingLayer(native);

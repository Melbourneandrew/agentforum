import type { RateLimit } from "@cloudflare/workers-types/index.ts";
import { Context, Data, Effect, Layer, Redacted, Schema } from "effect";
import {
  OperationalTracing,
  nativeOperationalTracingLayer,
} from "../telemetry/operational-tracing.js";
export class EdgeSignalConfigurationError extends Data.TaggedError(
  "EdgeSignalConfigurationError",
) {}
class EdgeSignalFailure extends Data.TaggedError("EdgeSignalFailure") {}
const Binding = Schema.declare(
  (value: unknown): value is RateLimit =>
    typeof value === "object" &&
    value !== null &&
    "limit" in value &&
    typeof value.limit === "function",
);
const Outcome = Schema.Struct({ success: Schema.Boolean });
export class EdgeAbuseSignal extends Context.Tag(
  "@agentforum/api/EdgeAbuseSignal",
)<
  EdgeAbuseSignal,
  {
    readonly observe: (
      credential: Redacted.Redacted,
    ) => Effect.Effect<"allow" | "deny" | "unknown">;
  }
>() {}
export const edgeAbuseSignalLayer = (bindings: unknown) =>
  Layer.effect(
    EdgeAbuseSignal,
    Effect.gen(function* () {
      const { PUBLISH_ABUSE: binding } = yield* Schema.decodeUnknown(
        Schema.Struct({ PUBLISH_ABUSE: Binding }),
      )(bindings).pipe(
        Effect.mapError(() => new EdgeSignalConfigurationError()),
      );
      const tracing = yield* OperationalTracing;
      return {
        observe: (credential: Redacted.Redacted) =>
          tracing.operation(
            "publication.edge_signal",
            Effect.tryPromise({
              try: async () => {
                // Domain-separated hash of a high-entropy credential, never a raw key,
                // identity, body, URL or reversible encoded principal identifier.
                const bytes = new Uint8Array(
                  await crypto.subtle.digest(
                    "SHA-256",
                    new TextEncoder().encode(
                      "agentforum:v1:publication-abuse\0" +
                        Redacted.value(credential),
                    ),
                  ),
                );
                const key = Array.from(bytes, (value) =>
                  value.toString(16).padStart(2, "0"),
                ).join("");
                return binding.limit({ key });
              },
              catch: () => new EdgeSignalFailure(),
            }).pipe(
              Effect.flatMap(Schema.decodeUnknown(Outcome)),
              Effect.map((value) =>
                value.success ? ("allow" as const) : ("deny" as const),
              ),
              // Approximate/provider failure never invents a policy denial or retry.
              Effect.orElseSucceed(() => "unknown" as const),
            ),
          ),
      };
    }),
  ).pipe(Layer.provide(nativeOperationalTracingLayer));

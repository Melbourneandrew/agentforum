import { describe, expect, it } from "vitest";
// Local configuration/schema evidence only; this is not provider capture proof.
import configuration from "../../../wrangler.jsonc?raw";
import pinnedSchema from "../node_modules/wrangler/config-schema.json?raw";
import { parse } from "jsonc-parser";
import { Schema } from "effect";

const Empty = Schema.Array(Schema.Unknown).pipe(
  Schema.filter((values) => values.length === 0),
);
const Off = Schema.Literal(false);
const DisabledChannel = Schema.Struct({
  enabled: Off,
  persist: Off,
  destinations: Empty,
});
const CaptureConfig = Schema.Struct({
  workers_dev: Off,
  preview_urls: Off,
  observability: Schema.Struct({
    enabled: Off,
    redact_query_string: Schema.Literal(true),
    logs: Schema.Struct({ ...DisabledChannel.fields, invocation_logs: Off }),
    traces: DisabledChannel,
    issues: Schema.Struct({ enabled: Off }),
  }),
  secrets: Schema.Struct({ required: Empty }),
  tail_consumers: Schema.optional(Empty),
  logpush: Schema.optional(Off),
  // No environment overrides exist on this base. Review added envs explicitly.
  env: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.Unknown }).pipe(
      Schema.filter((values) => Object.keys(values).length === 0),
    ),
  ),
});
const safe = {
  workers_dev: false,
  preview_urls: false,
  observability: {
    enabled: false,
    redact_query_string: true,
    logs: {
      enabled: false,
      invocation_logs: false,
      persist: false,
      destinations: [],
    },
    traces: { enabled: false, persist: false, destinations: [] },
    issues: { enabled: false },
  },
  secrets: { required: [] },
};
const BooleanField = Schema.Struct({ type: Schema.Literal("boolean") });
const DestinationsField = Schema.Struct({
  type: Schema.Literal("array"),
  items: Schema.Struct({ type: Schema.Literal("string") }),
});
const ChannelProperties = {
  enabled: BooleanField,
  persist: BooleanField,
  destinations: DestinationsField,
};
// Assert every applied property exists with its actual JSON-schema type in the
// installed pinned provider schema, rather than inventing capture controls.
const ProviderSchema = Schema.Struct({
  definitions: Schema.Struct({
    Observability: Schema.Struct({
      properties: Schema.Struct({
        enabled: BooleanField,
        redact_query_string: BooleanField,
        issues: Schema.Struct({
          properties: Schema.Struct({ enabled: BooleanField }),
        }),
        logs: Schema.Struct({
          properties: Schema.Struct({
            ...ChannelProperties,
            invocation_logs: BooleanField,
          }),
        }),
        traces: Schema.Struct({ properties: Schema.Struct(ChannelProperties) }),
      }),
    }),
  }),
});
describe("fail-closed native capture defaults", () => {
  it("verifies all applied capture fields against the installed Wrangler schema", () => {
    const input: unknown = JSON.parse(pinnedSchema);
    expect(Schema.is(ProviderSchema)(input)).toBe(true);
  });
  it("requires the complete explicit off/redaction defense without secrets or exposure", () => {
    const input: unknown = parse(configuration);
    expect(Schema.is(CaptureConfig)(input)).toBe(true);
    expect(Schema.decodeUnknownSync(CaptureConfig)(input)).toEqual(safe);
  });
  for (const unsafe of [
    { ...safe, observability: { ...safe.observability, enabled: true } },
    {
      ...safe,
      observability: { ...safe.observability, redact_query_string: false },
    },
    { ...safe, observability: { enabled: false } },
    {
      ...safe,
      observability: {
        ...safe.observability,
        logs: { ...safe.observability.logs, enabled: true },
      },
    },
    {
      ...safe,
      observability: {
        ...safe.observability,
        logs: { ...safe.observability.logs, invocation_logs: true },
      },
    },
    {
      ...safe,
      observability: {
        ...safe.observability,
        logs: { ...safe.observability.logs, persist: true },
      },
    },
    {
      ...safe,
      observability: {
        ...safe.observability,
        logs: { ...safe.observability.logs, destinations: ["external"] },
      },
    },
    {
      ...safe,
      observability: {
        ...safe.observability,
        traces: { ...safe.observability.traces, enabled: true },
      },
    },
    {
      ...safe,
      observability: {
        ...safe.observability,
        traces: { ...safe.observability.traces, persist: true },
      },
    },
    {
      ...safe,
      observability: {
        ...safe.observability,
        traces: { ...safe.observability.traces, destinations: ["external"] },
      },
    },
    {
      ...safe,
      observability: { ...safe.observability, issues: { enabled: true } },
    },
    { ...safe, tail_consumers: [{ service: "tail" }] },
    { ...safe, logpush: true },
    { ...safe, secrets: { required: ["EXPORT_TOKEN"] } },
    { ...safe, workers_dev: true },
    { ...safe, preview_urls: true },
    { ...safe, env: { production: { observability: { enabled: true } } } },
  ]) {
    it(`rejects capture/secret/exposure drift ${JSON.stringify(unsafe)}`, () => {
      expect(Schema.is(CaptureConfig)(unsafe)).toBe(false);
    });
  }
});

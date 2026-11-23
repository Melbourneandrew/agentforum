import { describe, expect, it } from "vitest";
// Local configuration evidence only; this is not provider capture proof.
import configuration from "../../../wrangler.jsonc?raw";
import { parse } from "jsonc-parser";
import { Schema } from "effect";

const DisabledChannel = Schema.Struct({
  enabled: Schema.optional(Schema.Literal(false)),
  invocation_logs: Schema.optional(Schema.Literal(false)),
  persist: Schema.optional(Schema.Literal(false)),
  destinations: Schema.optional(Schema.Array(Schema.Never)),
});
const CaptureConfig = Schema.Struct({
  observability: Schema.Struct({
    enabled: Schema.Literal(false),
    logs: Schema.optional(DisabledChannel),
    traces: Schema.optional(DisabledChannel),
    issues: Schema.optional(Schema.Struct({ enabled: Schema.Literal(false) })),
  }),
  secrets: Schema.Struct({
    required: Schema.Array(Schema.Never),
  }),
  tail_consumers: Schema.optional(Schema.Array(Schema.Never)),
  logpush: Schema.optional(Schema.Literal(false)),
  // No environment overrides exist on this base. Review added envs explicitly.
  env: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.Never }),
  ),
});
const safe = { observability: { enabled: false }, secrets: { required: [] } };
describe("fail-closed native capture defaults", () => {
  it("keeps native capture disabled without bootstrap secrets", () => {
    const input: unknown = parse(configuration);
    expect(Schema.is(CaptureConfig)(input)).toBe(true);
  });
  for (const unsafe of [
    { ...safe, observability: { enabled: true } },
    { ...safe, observability: { enabled: false, logs: { enabled: true } } },
    {
      ...safe,
      observability: { enabled: false, logs: { invocation_logs: true } },
    },
    { ...safe, observability: { enabled: false, traces: { enabled: true } } },
    {
      ...safe,
      observability: { enabled: false, logs: { destinations: ["external"] } },
    },
    { ...safe, observability: { enabled: false, issues: { enabled: true } } },
    { ...safe, tail_consumers: [{ service: "tail" }] },
    { ...safe, logpush: true },
    { ...safe, secrets: { required: ["EXPORT_TOKEN"] } },
    { ...safe, env: { production: { observability: { enabled: true } } } },
  ]) {
    it(`rejects capture/secret drift ${JSON.stringify(unsafe)}`, () => {
      expect(Schema.is(CaptureConfig)(unsafe)).toBe(false);
    });
  }
});

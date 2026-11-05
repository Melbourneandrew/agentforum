import { readFile } from "node:fs/promises";
import { parse } from "jsonc-parser";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

const SafeLocalConfiguration = Schema.Struct({
  observability: Schema.Struct({
    enabled: Schema.Literal(false),
    redact_query_string: Schema.Literal(true),
    logs: Schema.Struct({
      enabled: Schema.Literal(false),
      invocation_logs: Schema.Literal(false),
    }),
    traces: Schema.Struct({ enabled: Schema.Literal(false) }),
  }),
});
describe("current native telemetry activation boundary", () => {
  it("does not enable automatic request/read collection while policy and provider verification are unresolved", async () => {
    const input: unknown = parse(await readFile("wrangler.jsonc", "utf8"));
    const config = Schema.decodeUnknownSync(SafeLocalConfiguration)(input);
    expect(config.observability).toEqual({
      enabled: false,
      redact_query_string: true,
      logs: { enabled: false, invocation_logs: false },
      traces: { enabled: false },
    });
  });
});

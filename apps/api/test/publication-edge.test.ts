import { env } from "cloudflare:workers";
import { Effect, Redacted } from "effect";
import { describe, expect, it } from "vitest";
import {
  EdgeAbuseSignal,
  edgeAbuseSignalLayer,
} from "../src/publication/edge.js";
const observe = (bindings: unknown, credential: string) =>
  Effect.runPromise(
    Effect.flatMap(EdgeAbuseSignal, (service) =>
      service.observe(Redacted.make(credential)),
    ).pipe(Effect.provide(edgeAbuseSignalLayer(bindings))),
  );
describe("native advisory publication edge signal", () => {
  it("calls the genuine local workerd rate-limit binding", async () => {
    expect(navigator.userAgent).toContain("Cloudflare-Workers");
    expect(await observe(env, crypto.randomUUID())).toBe("allow");
  });
  it("uses a stable non-reversible credential-derived key (injected binding contract, not native capture)", async () => {
    const seen: string[] = [];
    const binding = {
      limit: (options: { key: string }) => {
        seen.push(options.key);
        return Promise.resolve({ success: false });
      },
    };
    const credential = "synthetic-sensitive-credential";
    expect(await observe({ PUBLISH_ABUSE: binding }, credential)).toBe("deny");
    expect(await observe({ PUBLISH_ABUSE: binding }, credential)).toBe("deny");
    expect(
      await observe({ PUBLISH_ABUSE: binding }, credential + "-different"),
    ).toBe("deny");
    expect(seen[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(seen[0]).toBe(seen[1]);
    expect(seen[2]).not.toBe(seen[0]);
    expect(JSON.stringify(seen)).not.toContain(credential);
  });
  it("contains binding failure without inventing denial/retry or repeating the binding call (contract injection)", async () => {
    let calls = 0;
    expect(
      await observe(
        {
          PUBLISH_ABUSE: {
            limit: () => {
              calls++;
              return Promise.reject(new Error("sensitive-provider-details"));
            },
          },
        },
        "synthetic",
      ),
    ).toBe("unknown");
    expect(calls).toBe(1);
    expect(
      await observe(
        {
          PUBLISH_ABUSE: {
            limit: () => Promise.resolve({ success: "not-a-boolean" }),
          },
        },
        "synthetic",
      ),
    ).toBe("unknown");
  });
  it("fails closed on a missing required binding rather than silently dropping configuration", async () => {
    const result = await Effect.runPromise(
      Effect.either(
        Effect.flatMap(EdgeAbuseSignal, () => Effect.void).pipe(
          Effect.provide(edgeAbuseSignalLayer({})),
        ),
      ),
    );
    expect(result).toMatchObject({
      _tag: "Left",
      left: { _tag: "EdgeSignalConfigurationError" },
    });
  });
});

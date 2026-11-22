import { env } from "cloudflare:workers";
import { Effect, Encoding } from "effect";
import { describe, expect, it } from "vitest";
import { decodeStrictJson } from "../src/api/json.js";
import { decodeCursor, encodeCursor } from "../src/api/query.js";
import { makeDispatcher } from "../src/runtime/dispatch.js";
import type { Bindings, Execution } from "../src/runtime/context.js";

const bytes = (source: string) => new TextEncoder().encode(source);
const succeeds = <A, E>(value: Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.isSuccess(value));
const origin = "https://json.owner.workers.dev";
const app = makeDispatcher(() => {
  throw new Error("API must not render");
});
const bindings: Bindings = {
  get DB(): Bindings["DB"] {
    throw new Error("Invalid source must not acquire D1");
  },
  ASSETS: env.ASSETS,
};
const execution: Execution = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
};
describe("strict JSON source before normalization", () => {
  it.each([
    '{"body":"first","body":"last"}',
    '{"body":"first","\\u0062ody":"last"}',
    '{"body":"x","tags":[],"tags":["last"]}',
    '{"name":"first","name":"last"}',
    '{"boundary":{"sequence":"1","sequence":"2"}}',
    '{"items":[{"name":1,"name":2}]}',
    '{"__proto__":{},"__proto__":{}}',
  ])("rejects duplicate decoded object member names: %s", async (source) => {
    expect(await succeeds(decodeStrictJson(bytes(source)))).toBe(false);
  });
  it.each([
    '{"body":"\\ud800"}',
    '{"body":"\\udfff"}',
    '{"\\ud800":"x"}',
    '{"items":["\\ud800"]}',
    '{"body":"ok",}',
    '{/* comment */"body":"x"}',
    '{"body":"x"} {}',
    '{"body":NaN}',
    '{"body":undefined}',
  ])("rejects invalid Unicode or non-JSON extensions: %s", async (source) => {
    expect(await succeeds(decodeStrictJson(bytes(source)))).toBe(false);
  });
  it("preserves NUL, astral characters, opaque strings and repeated names in separate objects", async () => {
    const value = {
      body: 'raw\0 😀 {"name":1,"name":2}',
      tags: ["A", "a", "e\u0301", "é"],
      items: [{ name: 1 }, { name: 2 }],
    };
    expect(
      await Effect.runPromise(decodeStrictJson(bytes(JSON.stringify(value)))),
    ).toEqual(value);
    expect(
      await Effect.runPromise(
        decodeStrictJson(bytes('{"body":"\\ud83d\\ude00"}')),
      ),
    ).toEqual({ body: "😀" });
  });
  it("rejects duplicate source keys through both HTTP forms before D1", async () => {
    for (const [operation, source] of [
      ["register", '{"name":"first","name":"last"}'],
      ["publish", '{"body":"first","\\u0062ody":"last"}'],
      ["search", '{"limit":1,"limit":100}'],
    ] as const) {
      const requests = [
        new Request(
          `${origin}/v1/${operation}?payload=${encodeURIComponent(source)}`,
        ),
        new Request(`${origin}/v1/${operation}`, {
          method: "POST",
          body: source,
          headers: { "Content-Type": "application/json" },
        }),
      ];
      for (const request of requests) {
        const response = await app.fetch(request, bindings, execution);
        expect(response.status).toBe(400);
        const result = await response.text();
        expect(result).not.toContain("first");
        expect(result).not.toContain("last");
      }
    }
  });
  it("rejects duplicate cursor members including escaped nested boundary members", async () => {
    const valid = {
      version: 1,
      api: "v1",
      fingerprint: "a".repeat(64),
      resource: "posts",
      purpose: "page",
      order: "newest",
      boundary: { sequence: "1", id: "a".repeat(21) },
    } as const;
    const source = JSON.stringify(valid);
    for (const altered of [
      source.replace('"purpose":"page"', '"purpose":"read","purpose":"page"'),
      source.replace('"sequence":"1"', '"sequence":"2","\\u0073equence":"1"'),
    ])
      expect(
        await succeeds(decodeCursor(Encoding.encodeBase64Url(altered))),
      ).toBe(false);
    const token = await Effect.runPromise(encodeCursor(valid));
    expect(await Effect.runPromise(decodeCursor(token))).toEqual(valid);
  });
  it("retains byte and UTF8 boundaries independently of the lexical validator", async () => {
    expect(await succeeds(decodeStrictJson(new Uint8Array([0xff])))).toBe(
      false,
    );
    expect(
      await succeeds(decodeStrictJson(bytes("{}" + " ".repeat(65534)))),
    ).toBe(true);
    expect(
      await succeeds(decodeStrictJson(bytes("{}" + " ".repeat(65535)))),
    ).toBe(false);
  });
});

import { env } from "cloudflare:workers";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { makeDispatcher } from "../src/runtime/dispatch.js";
import type { Bindings, Execution } from "../src/runtime/context.js";
import { PublishInput, Tags } from "../src/api/contracts.js";
import {
  decodePublish,
  readBearer,
  readDocument,
} from "../src/api/transport.js";
import { problemResponse } from "../src/api/problems.js";

const origin = "https://contracts.owner.workers.dev";
const execution: Execution = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
};
const bindings: Bindings = {
  get DB(): Bindings["DB"] {
    throw new Error("D1 must not be used by contracts");
  },
  ASSETS: env.ASSETS,
};
const app = makeDispatcher(() => {
  throw new Error("API must not render");
});
const post = (
  operation: string,
  body: string,
  headers: Record<string, string> = {},
) =>
  new Request(`${origin}/v1/${operation}`, {
    method: "POST",
    body,
    headers: { "Content-Type": "application/json", ...headers },
  });
const get = (operation: string, body: string) =>
  new Request(`${origin}/v1/${operation}?payload=${encodeURIComponent(body)}`);
const call = (request: Request) => app.fetch(request, bindings, execution);
const succeeds = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.isSuccess(effect));

describe("strict original-byte transport in native workerd", () => {
  it.each([
    ["register", {}],
    ["publish", { body: "raw Markdown\n😀", tags: [" A ", "a", " A "] }],
    ["search", {}],
    ["search", { resource: "agents" }],
  ])(
    "validates equivalent forms without fake business success: %s",
    async (operation, value) => {
      const body = JSON.stringify(value);
      for (const request of [get(operation, body), post(operation, body)]) {
        const response = await call(request);
        expect(response.status).toBe(501);
        expect(response.headers.get("Cache-Control")).toBe("no-store, private");
        expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
        expect(response.headers.has("Access-Control-Allow-Credentials")).toBe(
          false,
        );
      }
    },
  );
  it("counts original whitespace, escapes and UTF-8 bytes before normalization", async () => {
    for (const source of [
      '{"body":"\\u0061"}',
      JSON.stringify({ body: "😀é" }),
    ]) {
      const exact =
        source + " ".repeat(65536 - new TextEncoder().encode(source).length);
      expect((await call(post("publish", exact))).status).toBe(501);
      const rejected = await call(post("publish", exact + " "));
      expect(rejected.status).toBe(413);
      expect(await rejected.text()).toContain("65536");
    }
  });
  it("enforces the complete absolute encoded URL at exactly14336 bytes", async () => {
    const base = get("publish", JSON.stringify({ body: "x" })).url.length;
    const request = get(
      "publish",
      JSON.stringify({ body: "x".repeat(14336 - base + 1) }),
    );
    expect(new TextEncoder().encode(request.url).length).toBe(14336);
    expect((await call(request)).status).toBe(501);
    const response = await call(
      get("publish", JSON.stringify({ body: "x".repeat(14336 - base + 2) })),
    );
    expect(response.status).toBe(413);
    expect(await response.text()).toContain("Use POST");
  });
  it.each([
    "",
    "?payload=%",
    "?payload=%FF",
    "?payload=%C0%AF",
    "?payload=%257B%257D",
    "?payload=%7B%7D&payload=%7B%7D",
    "?payload=%7B%7D&key=PRIVATE",
    "?unknown=%7B%7D",
    "?payload=%7B%7D&",
    "?payload=%7B%7D#fragment",
  ])(
    "rejects malformed/duplicate/unknown GET transport: %s",
    async (suffix) => {
      const response = await call(
        new Request(`${origin}/v1/register${suffix}`),
      );
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain("PRIVATE");
    },
  );
  it("decodes percent/plus exactly once and preserves raw logical content", async () => {
    const body = JSON.stringify({ body: "%20 + & / 😀" });
    expect(await Effect.runPromise(readDocument(get("publish", body)))).toEqual(
      { body: "%20 + & / 😀" },
    );
    expect(
      await Effect.runPromise(readDocument(post("publish", body))),
    ).toEqual({ body: "%20 + & / 😀" });
  });
  it.each([
    { "Content-Encoding": "gzip" },
    { "Content-Encoding": "br" },
    { "Content-Type": "text/plain" },
    { "Content-Type": "application/json; charset=latin1" },
  ])("rejects non-identity/non-UTF8 JSON POST: %j", async (headers) => {
    expect((await call(post("register", "{}", headers))).status).toBe(415);
  });
  it("accepts explicit identity/UTF8 and ignores misleading Content-Length", async () => {
    expect(
      (
        await call(
          post("register", "{}", {
            "Content-Encoding": "identity",
            "Content-Type": 'application/json; charset="UTF-8"',
            "Content-Length": "999999",
          }),
        )
      ).status,
    ).toBe(501);
  });
  it("rejects malformed UTF8 and JSON, primitive bodies and POST query aliases", async () => {
    for (const body of ["", "{", "null", "[]", '"body"'])
      expect((await call(post("publish", body))).status).toBe(400);
    const invalid = new Request(`${origin}/v1/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: new Uint8Array([0xff]),
    });
    expect((await call(invalid)).status).toBe(400);
    expect((await call(post("register?payload=%7B%7D", "{}"))).status).toBe(
      400,
    );
  });
  it.each([
    { body: "x", metadata: {} },
    { body: "x", authorId: "spoof" },
    { body: "x", publicationOrder: "1" },
    { body: "" },
    { body: 4 },
    { body: "x", reply_to: null },
    { body: "x", tags: [null] },
    { body: "x", tags: [["nested"]] },
    { body: "\ud800" },
  ])("rejects invalid publication fields: %j", async (value) => {
    expect((await call(post("publish", JSON.stringify(value)))).status).toBe(
      400,
    );
    expect(await succeeds(Schema.decodeUnknown(PublishInput)(value))).toBe(
      false,
    );
  });
  it("validates submitted tag limits before exact first-occurrence deduplication", async () => {
    expect(
      await succeeds(
        decodePublish({
          body: "x",
          tags: Array.from({ length: 33 }, () => "same"),
        }),
      ),
    ).toBe(false);
    for (const tag of ["", "x".repeat(65), "é".repeat(129), "👨‍👩‍👧‍👦".repeat(11)])
      expect(await succeeds(Schema.decodeUnknown(Tags)([tag]))).toBe(false);
    expect(
      await Effect.runPromise(
        decodePublish({ body: "raw\n", tags: [" a ", "a", " a ", "A"] }),
      ),
    ).toEqual({ body: "raw\n", tags: [" a ", "a", "A"] });
    expect(
      await succeeds(
        Schema.decodeUnknown(Tags)(["é".repeat(64), "😀".repeat(64)]),
      ),
    ).toBe(true);
  });
  it("exposes a header-only Bearer decoder without authenticating stub operations", async () => {
    expect(
      await Effect.runPromise(
        readBearer(
          new Request(origin, {
            headers: { Authorization: "Bearer fixture-token" },
          }),
        ),
      ),
    ).toBe("fixture-token");
    for (const headers of [
      {},
      { Cookie: "key=PRIVATE" },
      { Authorization: "Basic PRIVATE" },
      { Authorization: "Bearer two tokens" },
    ])
      expect(await succeeds(readBearer(new Request(origin, { headers })))).toBe(
        false,
      );
  });
  it("keeps safe methods and method aliases away from D1 and all decoding", async () => {
    for (const method of ["HEAD", "OPTIONS"]) {
      const response = await call(
        new Request(`${origin}/v1/publish?payload=%FF`, { method }),
      );
      expect(response.status).toBe(204);
      expect(await response.text()).toBe("");
    }
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const response = await call(
        new Request(`${origin}/v1/publish`, { method }),
      );
      expect(response.status).toBe(405);
      expect(response.headers.get("Allow")).toBe("GET, POST, HEAD, OPTIONS");
    }
  });
  it("serializes only safe allowlisted problems and local problem-doc links", async () => {
    const response = problemResponse(
      400,
      origin,
      crypto.randomUUID(),
      "invalid-request",
    );
    const body = await response.text();
    expect(body).not.toContain("PRIVATE");
    expect(JSON.parse(body)).toMatchObject({
      status: 400,
      type: `${origin}/docs/problems/invalid-request.json`,
      _tag: "BadRequest",
    });
    expect(
      problemResponse(
        401,
        origin,
        crypto.randomUUID(),
        "unauthorized",
      ).headers.get("WWW-Authenticate"),
    ).toBe('Bearer realm="forum"');
  });
});

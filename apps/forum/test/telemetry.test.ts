import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { makeDispatcher } from "../src/runtime/dispatch.js";
import {
  requestDiagnostics,
  writeDiagnostic,
} from "../src/telemetry/diagnostics.js";
import { Option } from "effect";
import { validatePropagation } from "../src/telemetry/propagation.js";
import { migrate } from "./d1.js";
import type { Execution } from "../src/runtime/context.js";

const execution: Execution = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
};
const id = "01234567-89ab-4cde-8fab-0123456789ab";
const secret = "SENSITIVE-WO35-credential-cookie-markdown-tags-cursor-query";
const parent = "00-12345678901234567890123456789012-1234567890123456-01";
beforeAll(() => migrate());
afterEach(() => vi.restoreAllMocks());
const app = makeDispatcher(() => Promise.resolve(new Response("public")));

describe("safe diagnostics in real workerd", () => {
  for (const method of ["GET", "POST"]) {
    it(`excludes synthetic sensitive ${method} inputs and issued credentials`, async () => {
      expect(navigator.userAgent).toContain("Cloudflare-Workers");
      const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
      const input = { name: `wo35-${method.toLowerCase()}` };
      const response = await app.fetch(
        new Request(
          `https://alpha.owner.workers.dev/v1/register${method === "GET" ? `?payload=${encodeURIComponent(JSON.stringify(input))}` : ""}`,
          {
            method,
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${secret}`,
              Cookie: secret,
              traceparent: parent,
              tracestate: `vendor=${secret}`,
              "X-Request-Id": secret,
            },
            ...(method === "POST" ? { body: JSON.stringify(input) } : {}),
          },
        ),
        env,
        execution,
      );
      expect(response.status).toBe(201);
      const body: unknown = await response.json();
      expect(body).toHaveProperty("apiKey");
      if (typeof body === "object" && body !== null && "apiKey" in body)
        expect(JSON.stringify(log.mock.calls)).not.toContain(body.apiKey);
      const serialized = JSON.stringify(log.mock.calls);
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain(parent);
      expect(serialized).not.toContain("alpha.owner");
      expect(serialized).not.toContain(input.name);
      expect(log).toHaveBeenCalledOnce();
      expect(serialized).toContain(response.headers.get("X-Request-Id"));
      expect(serialized).toContain("registration");
    });
    it(`excludes hostile ${method} publication bodies, credentials and query values`, async () => {
      const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
      const payload = JSON.stringify({
        body: secret,
        tags: [secret],
        parent: secret,
      });
      const response = await app.fetch(
        new Request(
          `https://alpha.owner.workers.dev/v1/publish${method === "GET" ? `?payload=${encodeURIComponent(payload)}` : ""}`,
          {
            method,
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${secret}`,
              Cookie: secret,
            },
            ...(method === "POST" ? { body: payload } : {}),
          },
        ),
        env,
        execution,
      );
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
      expect(JSON.stringify(log.mock.calls)).toContain("/v1/publish");
    });
  }
  it("drops sensitive search text, cursor and tag values on GET and POST", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const payload = JSON.stringify({
      q: secret,
      cursor: secret,
      tags: [secret],
    });
    for (const method of ["GET", "POST"]) {
      const response = await app.fetch(
        new Request(
          `https://alpha.owner.workers.dev/v1/search${method === "GET" ? `?payload=${encodeURIComponent(payload)}` : ""}`,
          {
            method,
            headers: { "Content-Type": "application/json" },
            ...(method === "POST" ? { body: payload } : {}),
          },
        ),
        env,
        execution,
      );
      expect(response.status).toBeGreaterThanOrEqual(400);
    }
    expect(log).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
  });
  it("drops unknown paths, arbitrary methods, and caller correlation strings", () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    requestDiagnostics(
      new Request(`https://example.com/${secret}?q=${secret}`, {
        method: "PATCH",
      }),
      id,
    )(404);
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(log.mock.calls)).toContain("unmatched");
    expect(JSON.stringify(log.mock.calls)).toContain("other");
    requestDiagnostics(new Request("https://example.com/"), secret)(200);
    expect(log).toHaveBeenCalledOnce();
  });
  it("reconstructs only schema attributes and caps duration and completion count", () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const clock = vi
      .spyOn(performance, "now")
      .mockReturnValueOnce(0)
      .mockReturnValue(900_000);
    const complete = requestDiagnostics(
      new Request("https://example.com/v1/search"),
      id,
    );
    complete(503);
    complete(200);
    const record: unknown = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(record).toHaveProperty("duration.ms", 300_000);
    expect(record).toHaveProperty("error.type", "dependency-unavailable");
    expect(record).toHaveProperty("dependency.category", "d1");
    expect(log).toHaveBeenCalledOnce();
    clock.mockRestore();
    // Structural extra properties are stripped before the sink; no object pass-through.
    const safe = {
      "service.name": "agentforum",
      "event.name": "operation.completed",
      "api.version": "v1",
      "http.route": "/",
      "http.request.method": "GET",
      "http.response.status_code": 200,
      "request.id": id,
      "operation.name": "public-read",
      "error.type": "none",
      "dependency.category": "none",
      "duration.ms": 0,
      body: secret,
    } as const;
    writeDiagnostic(safe);
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
  });
  it("contains sink failures without changing successful results", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {
      throw new Error(secret);
    });
    const response = await app.fetch(
      new Request("https://alpha.owner.workers.dev/", {
        headers: { Cookie: secret },
      }),
      env,
      execution,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("public");
  });
  it("sanitizes thrown dependency/renderer messages and stacks", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const broken = makeDispatcher(() =>
      Promise.reject(new Error(`SQL bindings ${secret}`)),
    );
    const response = await broken.fetch(
      new Request("https://alpha.owner.workers.dev/", {
        headers: { Cookie: secret },
      }),
      env,
      execution,
    );
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(secret);
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(log.mock.calls)).toContain("internal-error");
  });
  it("keeps safe methods nonmutating and request correlation independent", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    for (const method of ["HEAD", "OPTIONS"]) {
      const response = await app.fetch(
        new Request("https://alpha.owner.workers.dev/v1/register", { method }),
        env,
        execution,
      );
      expect(response.status).toBe(204);
    }
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0]).not.toEqual(log.mock.calls[1]);
  });
});

describe("bounded dormant W3C propagation", () => {
  it("accepts version00 only with nonzero IDs and validated vendor state", () => {
    const context = validatePropagation(
      new Headers({
        traceparent: parent,
        tracestate: "vendor=value, other@tenant=opaque",
      }),
    );
    expect(Option.isSome(context)).toBe(true);
    if (Option.isSome(context))
      expect(context.value.tracestate).toEqual(
        Option.some("vendor=value, other@tenant=opaque"),
      );
  });
  for (const invalid of [
    "",
    parent.replace("123456", "ABCDEF"),
    parent.replace("00-", "ff-"),
    "00-" + "0".repeat(32) + "-1234567890123456-01",
    parent.replace("-1234567890123456-", "-0000000000000000-"),
    parent + "-extra",
    "a".repeat(10_000),
  ]) {
    it(`rejects invalid traceparent ${invalid.slice(0, 60)}`, () => {
      expect(
        Option.isNone(
          validatePropagation(new Headers({ traceparent: invalid })),
        ),
      ).toBe(true);
    });
  }
  for (const state of [
    "a=one,a=two",
    "a=secret=value",
    "Upper=value",
    "a=",
    "a=" + "x".repeat(257),
    Array.from({ length: 33 }, (_, n) => `v${String(n)}=x`).join(","),
    "a=" + "x".repeat(513),
  ]) {
    it(`drops invalid tracestate ${state.slice(0, 60)}`, () => {
      const context = validatePropagation(
        new Headers({ traceparent: parent, tracestate: state }),
      );
      expect(Option.isSome(context)).toBe(true);
      if (Option.isSome(context))
        expect(Option.isNone(context.value.tracestate)).toBe(true);
    });
  }
});

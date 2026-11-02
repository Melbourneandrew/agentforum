import { describe, expect, it } from "vitest";
import { contentSecurityPolicy, makeBoundary } from "../src/boundary.js";
import type { WebExecutionContext } from "../src/boundary.js";

const execution: WebExecutionContext = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
};
const env = { ENVIRONMENT: "local" };
const request = (method = "GET") =>
  new Request("https://observer.test/", { method });

describe("read-only observation boundary in workerd", () => {
  it("sets restrictive browser defenses on a successful response", async () => {
    expect(navigator.userAgent).toContain("Cloudflare-Workers");
    const response = await makeBoundary(() =>
      Promise.resolve(new Response("SSR page")),
    ).fetch(request(), env, execution);
    expect(await response.text()).toBe("SSR page");
    expect(response.headers.get("Content-Security-Policy")).toBe(
      contentSecurityPolicy,
    );
    expect(contentSecurityPolicy).toContain("script-src 'none'");
    expect(contentSecurityPolicy).not.toMatch(/unsafe-inline|unsafe-eval/);
    expect(response.headers.get("Cache-Control")).toBe("no-store, private");
  });
  it("terminates OPTIONS before environment validation or rendering", async () => {
    let calls = 0;
    const response = await makeBoundary(() => {
      calls++;
      return Promise.resolve(new Response());
    }).fetch(request("OPTIONS"), {}, execution);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(calls).toBe(0);
  });
  it("does not provide mutation method aliases", async () => {
    let calls = 0;
    const app = makeBoundary(() => {
      calls++;
      return Promise.resolve(new Response());
    });
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = await app.fetch(request(method), env, execution);
      expect(response.status).toBe(405);
      expect(response.headers.get("Allow")).toBe("GET, HEAD, OPTIONS");
    }
    expect(calls).toBe(0);
  });
  it("keeps successful and failed HEAD responses bodyless", async () => {
    const app = makeBoundary(() => Promise.resolve(new Response("body")));
    for (const bindings of [env, {}]) {
      const response = await app.fetch(request("HEAD"), bindings, execution);
      expect(response.status).toBe(bindings === env ? 200 : 500);
      expect(await response.text()).toBe("");
    }
  });
  it("contains defects and invalid configuration without leaking details", async () => {
    const app = makeBoundary(() =>
      Promise.reject(new Error("secret connection details")),
    );
    for (const bindings of [env, { ENVIRONMENT: "private-config" }]) {
      const response = await app.fetch(request(), bindings, execution);
      expect(response.status).toBe(500);
      expect(await response.text()).toBe(
        "The observation site is unavailable.",
      );
      expect(response.headers.get("Content-Security-Policy")).toBe(
        contentSecurityPolicy,
      );
    }
  });
  it("forwards only per-request platform context without changing bindings", async () => {
    const app = makeBoundary((_request, bindings, context) => {
      expect(context).toBe(execution);
      return Promise.resolve(new Response(String(bindings.ENVIRONMENT)));
    });
    const responses = await Promise.all(
      ["local", "staging"].map((ENVIRONMENT) =>
        app.fetch(request(), { ENVIRONMENT }, execution),
      ),
    );
    expect(
      await Promise.all(responses.map((response) => response.text())),
    ).toEqual(["local", "staging"]);
    expect(env).toEqual({ ENVIRONMENT: "local" });
  });
});

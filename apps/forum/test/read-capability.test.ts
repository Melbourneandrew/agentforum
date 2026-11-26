import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { makeDispatcher } from "../src/runtime/dispatch";
import { readClient } from "../app/browsing/client-manifest";
const execution = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
};
describe("approved bounded HTML capability", () => {
  it("admits only exact immutable hash for successful dynamic HTML", async () => {
    const app = makeDispatcher(() =>
      Promise.resolve(
        new Response("<main>Read only</main>", {
          headers: {
            "Content-Type": "text/html",
            "Cache-Control": "no-store, private",
          },
        }),
      ),
    );
    const response = await app.fetch(
      new Request("https://alpha.owner.workers.dev/"),
      env,
      execution,
    );
    const csp = response.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain(`script-src '${readClient.integrity}'`);
    expect(csp).toContain("script-src-attr 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).not.toMatch(
      /unsafe-inline|unsafe-eval|strict-dynamic|script-src 'self'/,
    );
  });
  it("keeps errors and nonHTML restrictive with their full status/body", async () => {
    for (const status of [400, 404, 500, 503]) {
      const app = makeDispatcher(() =>
        Promise.resolve(
          new Response("Safe full failure", {
            status,
            headers: { "Content-Type": "text/html" },
          }),
        ),
      );
      const response = await app.fetch(
        new Request("https://alpha.owner.workers.dev/"),
        env,
        execution,
      );
      expect(response.status).toBe(status);
      expect(await response.text()).toBe("Safe full failure");
      expect(response.headers.get("Content-Security-Policy")).toContain(
        "script-src 'none'",
      );
      expect(response.headers.get("Content-Security-Policy")).toContain(
        "form-action 'none'",
      );
    }
    const app = makeDispatcher(() =>
      Promise.resolve(
        new Response("Not HTML", {
          headers: { "Cache-Control": "no-store, private" },
        }),
      ),
    );
    expect(
      (
        await app.fetch(
          new Request("https://alpha.owner.workers.dev/"),
          env,
          execution,
        )
      ).headers.get("Content-Security-Policy"),
    ).toContain("script-src 'none'");
  });
  it("never lends renderer capability to metadata/static fallthrough or safe API methods", async () => {
    let rendered = 0;
    const app = makeDispatcher(() => {
      rendered++;
      return Promise.resolve(
        new Response("Unexpected renderer", {
          headers: { "Content-Type": "text/html" },
        }),
      );
    });
    for (const path of [
      "/.well-known/api-catalog",
      "/agents.txt",
      "/agents.json",
      "/docs/",
      "/unknown",
    ]) {
      const response = await app.fetch(
        new Request("https://alpha.owner.workers.dev" + path),
        env,
        execution,
      );
      expect(response.headers.get("Content-Security-Policy")).toContain(
        "script-src 'none'",
      );
      expect(response.headers.get("Content-Security-Policy")).toContain(
        "form-action 'none'",
      );
      expect(response.headers.get("Content-Security-Policy")).not.toContain(
        readClient.integrity,
      );
    }
    for (const method of ["HEAD", "OPTIONS"]) {
      const response = await app.fetch(
        new Request("https://alpha.owner.workers.dev/v1/publish", { method }),
        env,
        execution,
      );
      expect(response.status).toBe(204);
      expect(await response.text()).toBe("");
      expect(response.headers.get("Content-Security-Policy")).toBeNull();
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    }
    expect(rendered).toBe(0);
  });
  it("preserves the same explicit capability on admitted renderer cache hits", async () => {
    let rendered = 0;
    const writes: Promise<unknown>[] = [];
    const app = makeDispatcher(() => {
      rendered++;
      return Promise.resolve(
        new Response("<main>Cached renderer</main>", {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        }),
      );
    });
    const request = new Request(
      "https://alpha.owner.workers.dev/?proof=" + crypto.randomUUID(),
    );
    const scope = {
      ...execution,
      waitUntil: (promise: Promise<unknown>) => {
        writes.push(promise);
      },
    };
    const first = await app.fetch(request, env, scope);
    await Promise.all(writes);
    const second = await app.fetch(request, env, scope);
    expect(rendered).toBe(1);
    expect(await second.text()).toBe("<main>Cached renderer</main>");
    expect(second.headers.get("Content-Security-Policy")).toBe(
      first.headers.get("Content-Security-Policy"),
    );
    expect(second.headers.get("Content-Security-Policy")).toContain(
      `script-src '${readClient.integrity}'`,
    );
  });
});

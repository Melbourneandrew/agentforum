import { describe, expect, it } from "vitest";
import worker from "../src/worker.js";

const request = (path = "/", method = "GET") =>
  new Request(`https://docs.test${path}`, { method });
const bindings = (fetch: (request: Request) => Promise<Response>) => ({
  ENVIRONMENT: "local",
  ASSETS: { fetch },
});

describe("static documentation Worker in workerd", () => {
  it("serves assets with restrictive browser defenses", async () => {
    expect(navigator.userAgent).toContain("Cloudflare-Workers");
    const response = await worker.fetch(
      request(),
      bindings(() => Promise.resolve(new Response("static page"))),
    );
    expect(await response.text()).toBe("static page");
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "script-src 'none'",
    );
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Cache-Control")).toBe("no-store, private");
  });
  it("keeps raw Markdown in its declared media type", async () => {
    for (const path of [
      "/markdown/runtime.md",
      "/docs/llms.txt",
      "/llms.txt",
      "/skill.md",
    ]) {
      const response = await worker.fetch(
        request(path),
        bindings(() => Promise.resolve(new Response("# Raw"))),
      );
      expect(response.headers.get("Content-Type")).toBe(
        "text/markdown; charset=utf-8",
      );
      expect(await response.text()).toBe("# Raw");
    }
  });
  it("OPTIONS terminates before environment decoding or asset access", async () => {
    const response = await worker.fetch(request("/", "OPTIONS"), {});
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });
  it("does not serve mutation method aliases", async () => {
    let calls = 0;
    const env = bindings(() => {
      calls++;
      return Promise.resolve(new Response());
    });
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = await worker.fetch(request("/", method), env);
      expect(response.status).toBe(405);
      expect(response.headers.get("Allow")).toBe("GET, HEAD, OPTIONS");
    }
    expect(calls).toBe(0);
  });
  it("HEAD is bodyless and does not turn missing assets into a client shell", async () => {
    const response = await worker.fetch(
      request("/missing", "HEAD"),
      bindings(() =>
        Promise.resolve(new Response("not found", { status: 404 })),
      ),
    );
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
  });
  it("contains invalid configuration and asset failures without secrets", async () => {
    for (const env of [
      {},
      bindings(() =>
        Promise.reject(new Error("private infrastructure detail")),
      ),
    ]) {
      const response = await worker.fetch(request(), env);
      expect(response.status).toBe(500);
      expect(await response.text()).toBe("Documentation is unavailable.");
    }
  });
});

import { migrate } from "./d1.js";
import { env } from "cloudflare:workers";
import { Effect } from "effect";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  installationOrigin,
  type Bindings,
  type Execution,
} from "../src/runtime/context.js";
import { makeDispatcher } from "../src/runtime/dispatch.js";

const execution: Execution = {
  waitUntil: (promise) => {
    pending.push(promise);
  },
  passThroughOnException: () => undefined,
  props: {},
};
const pending: Promise<unknown>[] = [];
const request = (
  path = "/",
  method = "GET",
  origin = "https://alpha.owner.workers.dev",
) => new Request(origin + path, { method });
const app = makeDispatcher(async (_request, context) => {
  const runtime = await context.runtime();
  return new Response(`${context.origin} ${runtime.database}`);
});
beforeAll(() => migrate());
beforeEach(async () => {
  await Promise.all(pending.splice(0));
});

describe("native single-Worker runtime", () => {
  it("runs with a genuine local D1 binding, no application secrets and no Node database", async () => {
    expect(navigator.userAgent).toContain("Cloudflare-Workers");
    expect(await env.DB.prepare("SELECT 1 AS ready").first()).toEqual({
      ready: 1,
    });
    expect(Object.keys(env)).not.toEqual(
      expect.arrayContaining(["DATABASE_URL"]),
    );
  });
  it("exercises native FTS5 and lossless SQLite integer output without asserting domain implementation", async () => {
    await env.DB.exec(
      "DROP TABLE IF EXISTS runtime_fts; CREATE VIRTUAL TABLE runtime_fts USING fts5(body);",
    );
    await env.DB.prepare("INSERT INTO runtime_fts(body) VALUES (?)")
      .bind("shared agent memory")
      .run();
    expect(
      await env.DB.prepare(
        "SELECT body FROM runtime_fts WHERE runtime_fts MATCH ?",
      )
        .bind('"agent memory"')
        .first("body"),
    ).toBe("shared agent memory");
    expect(
      await env.DB.prepare(
        "SELECT CAST(9223372036854775807 AS TEXT) AS position",
      ).first("position"),
    ).toBe("9223372036854775807");
    await env.DB.exec("DROP TABLE runtime_fts");
  });
  it("does not render pages for any API request; reports unimplemented rather than fabricated success", async () => {
    let renders = 0;
    const boundary = makeDispatcher(() => {
      renders++;
      return Promise.resolve(new Response("wrong"));
    });
    for (const operation of ["register", "publish", "search"])
      for (const method of ["GET", "POST"]) {
        const response = await boundary.fetch(
          new Request(
            `https://alpha.owner.workers.dev/v1/${operation}` +
              (method === "GET"
                ? `?payload=${encodeURIComponent(JSON.stringify(operation === "publish" ? { body: "fixture" } : {}))}`
                : ""),
            method === "POST"
              ? {
                  method,
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(
                    operation === "publish" ? { body: "fixture" } : {},
                  ),
                }
              : { method },
          ),
          env,
          execution,
        );
        expect(response.status).toBe(
          operation === "register" ? 200 : operation === "publish" ? 401 : 501,
        );
        expect(response.headers.get("Cache-Control")).toBe("no-store, private");
        expect(response.headers.get("Content-Type")).toBe(
          operation === "register"
            ? "application/json"
            : "application/problem+json",
        );
        if (operation === "search")
          expect(await response.text()).toContain("not-implemented");
      }
    expect(renders).toBe(0);
  });
  it("terminates HEAD/OPTIONS before touching config, binding or page rendering", async () => {
    const invalid = {
      get DB(): Bindings["DB"] {
        throw new Error("D1 must not be acquired");
      },
      ASSETS: env.ASSETS,
      CANONICAL_ORIGIN: "not an origin",
    };
    for (const method of ["HEAD", "OPTIONS"])
      for (const op of ["register", "publish", "search"]) {
        const response = await app.fetch(
          request(`/v1/${op}`, method),
          invalid,
          execution,
        );
        expect(response.status).toBe(204);
        expect(await response.text()).toBe("");
      }
  });
  it("enforces the complete encoded GET URL cap before API service use", async () => {
    const response = await app.fetch(
      request("/v1/publish?payload=" + "x".repeat(14336)),
      env,
      execution,
    );
    expect(response.status).toBe(413);
    expect(await response.text()).toContain("Use POST");
  });
  it("reads request-local D1 services directly and scopes cached output to validated origins", async () => {
    const suffix = `?fixture=${crypto.randomUUID()}`;
    const alpha = await app.fetch(request("/" + suffix), env, execution);
    expect(await alpha.text()).toBe(
      "https://alpha.owner.workers.dev available",
    );
    expect(alpha.headers.get("Cache-Control")).toBe("public, max-age=30");
    await Promise.all(pending.splice(0));
    const beta = await app.fetch(
      request("/" + suffix, "GET", "https://beta.owner.workers.dev"),
      env,
      execution,
    );
    expect(await beta.text()).toBe("https://beta.owner.workers.dev available");
  });
  it("uses trusted configured canonical origin, ignores forwarding headers and rejects unsafe hosts", async () => {
    const input = new Request("https://alpha.owner.workers.dev/", {
      headers: {
        Forwarded: "host=attacker.invalid",
        "X-Forwarded-Host": "attacker.invalid",
      },
    });
    expect(
      await Effect.runPromise(
        installationOrigin(input, {
          CANONICAL_ORIGIN: "https://forum.example",
        }),
      ),
    ).toBe("https://forum.example");
    for (const origin of [
      "https://attacker.invalid",
      "https://workers.dev",
      "https://a.b.workers.dev.attacker.invalid",
      "http://a.b.workers.dev",
    ]) {
      expect(
        (await app.fetch(request("/", "GET", origin), env, execution)).status,
      ).toBe(400);
    }
    for (const value of [
      "http://forum.example",
      "https://user:secret@forum.example",
      "https://forum.example/path",
      "https://forum.example/",
    ]) {
      const response = await app.fetch(
        request(),
        { ...env, CANONICAL_ORIGIN: value },
        execution,
      );
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain(value);
    }
    const hostMismatch = new Request("https://alpha.owner.workers.dev/", {
      headers: { Host: "attacker.invalid" },
    });
    expect((await app.fetch(hostMismatch, env, execution)).status).toBe(400);
  });
  it("never caches credentials, cookies, failures or mutation methods", async () => {
    for (const headers of [
      { Authorization: "Bearer secret" },
      { Cookie: "secret=value" },
    ]) {
      const response = await app.fetch(
        new Request("https://alpha.owner.workers.dev/", { headers }),
        env,
        execution,
      );
      expect(response.headers.get("Cache-Control")).toBe("no-store, private");
    }
    expect((await app.fetch(request("/", "POST"), env, execution)).status).toBe(
      405,
    );
    expect(
      (await app.fetch(request("/", "DELETE"), env, execution)).status,
    ).toBe(405);
    expect(
      (await app.fetch(request("/v1/unknown"), env, execution)).status,
    ).toBe(404);
    const head = await app.fetch(request("/", "HEAD"), env, execution);
    expect(await head.text()).toBe("");
  });
  it("never caches renderer-private, no-store, varying or cookie-bearing responses", async () => {
    for (const headers of [
      { "Cache-Control": "no-store" },
      { "Cache-Control": "private, max-age=0" },
      { Vary: "Accept-Language" },
      { "Set-Cookie": "fixture=synthetic" },
    ]) {
      let calls = 0;
      const boundary = makeDispatcher(() => {
        calls++;
        return Promise.resolve(new Response("private", { headers }));
      });
      const path = `/?restriction=${crypto.randomUUID()}`;
      for (let count = 0; count < 2; count++) {
        const response = await boundary.fetch(request(path), env, execution);
        expect(response.headers.get("Cache-Control")).toBe("no-store, private");
        await Promise.all(pending.splice(0));
      }
      expect(calls).toBe(2);
    }
  });
});

import type { WorkerExecutionContext } from "../src/worker.js";
import { Deferred, Effect, Layer, Logger, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import worker, { Health, makeWorker, RequestContext } from "../src/worker.js";
import { InternalProblem, ValidationProblem } from "../src/contract.js";

const execution: WorkerExecutionContext = {
  waitUntil: (pending) => {
    void pending;
  },
  passThroughOnException: () => undefined,
  props: {},
};
const env = { ENVIRONMENT: "local" };
const request = (path = "/v1/health", init?: RequestInit) =>
  new Request(`https://api.agentforum.test${path}`, init);
const body = async (response: Response): Promise<unknown> => response.json();
const quiet = Logger.replace(Logger.defaultLogger, Logger.none);

describe("native Worker boundary (workerd)", () => {
  it("executes the harmless health route inside Workers", async () => {
    expect(navigator.userAgent).toContain("Cloudflare-Workers");
    const response = await worker.fetch(request(), env, execution);
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({ status: "ok" });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Cache-Control")).toBe("no-store, private");
  });

  it("rejects undeclared query input without reflecting the input", async () => {
    const response = await worker.fetch(
      request("/v1/health?credential=top-secret"),
      env,
      execution,
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("Content-Type")).toContain(
      "application/problem+json",
    );
    const text = await response.text();
    expect(text).not.toContain("top-secret");
    const problem = Schema.decodeUnknownSync(ValidationProblem)(
      JSON.parse(text),
    );
    expect(problem.issues).toEqual([{ location: ["request"] }]);
    expect(problem.instance).toBe(
      `urn:uuid:${response.headers.get("X-Request-Id") ?? ""}`,
    );
  });

  it("keeps OPTIONS safe and terminates before services or environment decoding", async () => {
    let invoked = false;
    const app = makeWorker(
      Layer.sync(Health, () => {
        invoked = true;
        return { check: Effect.succeed({ status: "ok" as const }) };
      }),
    );
    const response = await app.fetch(
      request("/v1/publish", { method: "OPTIONS" }),
      {},
      execution,
    );
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(invoked).toBe(false);
    expect(response.headers.get("Access-Control-Max-Age")).toBe("86400");
  });

  it("HEAD returns headers only and unknown business routes are not advertised", async () => {
    const response = await worker.fetch(
      request("/v1/health", { method: "HEAD" }),
      env,
      execution,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    for (const path of ["/v1/register", "/v1/publish", "/v1/search"]) {
      const absent = await worker.fetch(request(path), env, execution);
      expect(absent.status).toBe(404);
      expect(await body(absent)).toMatchObject({
        status: 404,
        title: "Not found",
      });
    }
  });

  it("never reflects supplied correlation IDs", async () => {
    const supplied = "attacker-controlled-secret";
    const responses = await Promise.all(
      [1, 2].map(() =>
        worker.fetch(
          request("/v1/health", { headers: { "X-Request-Id": supplied } }),
          env,
          execution,
        ),
      ),
    );
    const ids = responses.map((response) =>
      response.headers.get("X-Request-Id"),
    );
    expect(ids[0]).not.toBe(supplied);
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("provides independent bindings and ExecutionContext to every request", async () => {
    const observed: string[] = [];
    const app = makeWorker(
      Layer.succeed(Health, {
        check: Effect.gen(function* () {
          const context = yield* RequestContext;
          expect(context.execution).toBe(execution);
          observed.push(context.bindings.ENVIRONMENT);
          return { status: "ok" as const };
        }),
      }),
    );
    await Promise.all(
      ["local", "staging"].map((ENVIRONMENT) =>
        app.fetch(request(), { ENVIRONMENT }, execution),
      ),
    );
    expect(observed.sort()).toEqual(["local", "staging"]);
  });

  it("finalizes request-scoped services on success and failure", async () => {
    for (const fail of [false, true]) {
      const events: string[] = [];
      const app = makeWorker(
        Layer.scoped(
          Health,
          Effect.acquireRelease(
            Effect.sync(() => {
              events.push("acquire");
              return {
                check: fail
                  ? Effect.die(new Error("SQL password=secret"))
                  : Effect.succeed({ status: "ok" as const }),
              };
            }),
            () =>
              Effect.sync(() => {
                events.push("release");
              }),
          ).pipe(Effect.provide(quiet)),
        ),
      );
      const response = await app.fetch(request(), env, execution);
      expect(response.status).toBe(fail ? 500 : 200);
      expect(events).toEqual(["acquire", "release"]);
      expect(await response.text()).not.toContain("password");
    }
  });

  it("contains undeclared failures and thrown defects without diagnostic leakage", async () => {
    for (const check of [
      Effect.die(new Error("Authorization: Bearer secret-verifier")),
      Effect.sync((): { readonly status: "ok" } => {
        throw new Error("postgres://secret-password");
      }),
    ]) {
      const app = makeWorker(Layer.succeed(Health, { check }));
      const response = await app.fetch(request(), env, execution);
      expect(response.status).toBe(500);
      const text = await response.text();
      expect(text).not.toContain("secret");
      expect(text).not.toContain("postgres");
      expect(
        Schema.decodeUnknownSync(InternalProblem)(JSON.parse(text)).instance,
      ).toBe(`urn:uuid:${response.headers.get("X-Request-Id") ?? ""}`);
    }
  });

  it("contains response-encoding failures", async () => {
    // The service is correctly typed, but a hostile dependency can throw on read.
    const app = makeWorker(
      Layer.succeed(Health, {
        check: Effect.succeed({
          get status(): "ok" {
            throw new Error("encoding-secret");
          },
        }),
      }),
    );
    const response = await app.fetch(request(), env, execution);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("encoding-secret");
  });

  it("rejects invalid environment configuration safely", async () => {
    const response = await worker.fetch(
      request(),
      { ENVIRONMENT: "secret-config" },
      execution,
    );
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("secret-config");
  });

  it("maps declared typed failures and strips occurrence-specific unsafe fields", async () => {
    const app = makeWorker(
      Layer.succeed(Health, {
        check: Effect.fail(
          new ValidationProblem({
            type: "https://docs.agentforum.site/problems/invalid-request",
            title: "Invalid request",
            status: 400,
            detail: "unsafe-dependency-detail",
            instance: "unsafe-instance",
            issues: [{ location: ["payload"] }],
          }),
        ),
      }),
    );
    const response = await app.fetch(request(), env, execution);
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).not.toContain("unsafe");
    expect(
      Schema.decodeUnknownSync(ValidationProblem)(JSON.parse(text)).status,
    ).toBe(400);
  });

  it("contains finalizer failures and keeps error HEAD responses bodyless", async () => {
    const app = makeWorker(
      Layer.scoped(
        Health,
        Effect.acquireRelease(
          Effect.succeed({ check: Effect.succeed({ status: "ok" as const }) }),
          () => Effect.die(new Error("finalizer-secret")),
        ),
      ),
    );
    const response = await app.fetch(request(), env, execution);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("finalizer-secret");
    const head = await app.fetch(
      request("/v1/health", { method: "HEAD" }),
      {},
      execution,
    );
    expect(head.status).toBe(500);
    expect(await head.text()).toBe("");
  });

  it("does not start a service for an already-aborted request", async () => {
    let invoked = false;
    const controller = new AbortController();
    controller.abort();
    const app = makeWorker(
      Layer.sync(Health, () => {
        invoked = true;
        return { check: Effect.succeed({ status: "ok" as const }) };
      }),
    );
    const response = await app.fetch(
      request("/v1/health", { signal: controller.signal }),
      env,
      execution,
    );
    expect(response.status).toBe(500);
    expect(invoked).toBe(false);
  });

  it("emits only a fixed diagnostic category and server correlation, never exception content", async () => {
    const diagnostic = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);
    try {
      const app = makeWorker(
        Layer.succeed(Health, {
          check: Effect.die(
            new Error("Authorization: Bearer diagnostic-secret"),
          ),
        }),
      );
      const response = await app.fetch(request(), env, execution);
      expect(response.status).toBe(500);
      const log = JSON.stringify(diagnostic.mock.calls);
      expect(log).toContain("api_unexpected_failure");
      expect(log).toContain(response.headers.get("X-Request-Id") ?? "missing");
      expect(log).not.toContain("diagnostic-secret");
      expect(log).not.toContain("Authorization");
    } finally {
      diagnostic.mockRestore();
    }
  });

  it("runs finalizers when an active request is interrupted", async () => {
    const started = Effect.runSync(Deferred.make<undefined>());
    const finished = Effect.runSync(Deferred.make<undefined>());
    const controller = new AbortController();
    const app = makeWorker(
      Layer.succeed(Health, {
        check: Effect.acquireUseRelease(
          Deferred.succeed(started, undefined),
          () => Effect.never,
          () => Deferred.succeed(finished, undefined),
        ),
      }),
    );
    const pending = app.fetch(
      request("/v1/health", { signal: controller.signal }),
      env,
      execution,
    );
    await Effect.runPromise(Deferred.await(started));
    controller.abort();
    await Effect.runPromise(
      Deferred.await(finished).pipe(Effect.timeout("2 seconds")),
    );
    const response = await pending;
    expect(response.status).toBe(500);
  });
});

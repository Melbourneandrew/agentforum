import { Deferred, Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
  makeWorker,
  normalizeProblem,
  renderProblem,
  Health,
  type WorkerExecutionContext,
} from "../src/worker.js";
import { Publication } from "../src/publication/service.js";
import {
  AuthenticationProblem,
  PublishingRateLimitProblem,
} from "../src/publication/contract.js";
const execution: WorkerExecutionContext = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
};
const url = "https://api.agentforum.test/v1/publish";
const key = `af_v1.${"1".repeat(32)}.${"2".repeat(64)}`;
const request = (
  body = '{"body":"valid"}',
  credential: string | null = key,
  signal?: AbortSignal,
) =>
  new Request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(credential === null ? {} : { Authorization: `Bearer ${credential}` }),
    },
    body,
    ...(signal === undefined ? {} : { signal }),
  });
describe("publication HTTP boundary in genuine workerd", () => {
  it("avoids domain acquisition for safe/unsupported methods, invalid input and missing/malformed credentials", async () => {
    let acquisitions = 0;
    const app = makeWorker(undefined, undefined, undefined, () => {
      acquisitions++;
      return Layer.succeed(Publication, {
        publish: () => Effect.die(new Error("Unreachable publication fixture")),
      });
    });
    for (const method of [
      "HEAD",
      "OPTIONS",
      "PUT",
      "PATCH",
      "DELETE",
      "TRACE",
    ]) {
      const response = await app.fetch(
        new Request(url, { method }),
        undefined,
        execution,
      );
      expect(response.status).toBe(
        method === "HEAD" ? 200 : method === "OPTIONS" ? 204 : 405,
      );
      if (method === "HEAD" || method === "OPTIONS")
        expect(await response.text()).toBe("");
    }
    for (const value of [
      request("{}"),
      request('{"body":""}'),
      request('{"body":"x","author_id":"forged"}'),
      new Request(url + "?payload=" + "x".repeat(14336)),
    ])
      expect(
        (await app.fetch(value, { ENVIRONMENT: "local" }, execution)).status,
      ).toBeGreaterThanOrEqual(400);
    for (const credential of [null, "bad-key"]) {
      const response = await app.fetch(
        request('{"body":"valid"}', credential),
        { ENVIRONMENT: "local" },
        execution,
      );
      expect(response.status).toBe(401);
      expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
    }
    expect(acquisitions).toBe(0);
  });
  it("waits for publication-layer finalization when the active request is interrupted", async () => {
    const entered = await Effect.runPromise(Deferred.make<boolean>());
    let released = 0;
    const app = makeWorker(undefined, undefined, undefined, () =>
      Layer.scoped(
        Publication,
        Effect.acquireRelease(
          Effect.succeed({
            publish: () =>
              Deferred.succeed(entered, true).pipe(
                Effect.zipRight(Effect.never),
              ),
          }),
          () =>
            Effect.sync(() => {
              released++;
            }),
        ),
      ),
    );
    const controller = new AbortController();
    const pending = app.fetch(
      request(undefined, key, controller.signal),
      { ENVIRONMENT: "local" },
      execution,
    );
    await Effect.runPromise(Deferred.await(entered));
    controller.abort();
    expect((await pending).status).toBe(500);
    expect(released).toBe(1);
  });
  it("reconstructs declared failures and exact retry headers without lower-layer secrets or headers", async () => {
    const secret = "sensitive-key-and-query";
    for (const problem of [
      new AuthenticationProblem({
        type: "https://docs.agentforum.site/problems/authentication-required",
        title: "Authentication required",
        status: 401,
        detail: secret,
        instance: secret,
      }),
      new PublishingRateLimitProblem({
        type: "https://docs.agentforum.site/problems/publishing-rate-limit",
        title: "Publishing rate limit exceeded",
        status: 429,
        detail: secret,
        instance: secret,
        retry_after: 17,
      }),
    ]) {
      const normalized = await Effect.runPromise(
        normalizeProblem(
          Response.json(problem, {
            status: problem.status,
            headers: {
              "Content-Type": "application/problem+json",
              "Retry-After": "999",
            },
          }),
          "server",
          "publish",
          true,
        ),
      );
      const response = renderProblem(normalized, "POST", {});
      expect(response.status).toBe(problem.status);
      expect(await response.text()).not.toContain(secret);
      expect(response.headers.get("Retry-After")).toBe(
        problem.status === 429 ? "17" : null,
      );
      if (problem.status === 401)
        expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
    }
  });
  it("does not promote newly declared publication errors on the unrelated health route", async () => {
    const failure = new PublishingRateLimitProblem({
      type: "https://docs.agentforum.site/problems/publishing-rate-limit",
      title: "Publishing rate limit exceeded",
      status: 429,
      detail: "private",
      instance: "private",
      retry_after: 55,
    });
    const app = makeWorker(
      Layer.succeed(Health, { check: Effect.die(failure) }),
    );
    const response = await app.fetch(
      new Request("https://api.agentforum.test/v1/health"),
      { ENVIRONMENT: "local" },
      execution,
    );
    expect(response.status).toBe(500);
    expect(response.headers.get("Retry-After")).toBeNull();
    expect(await response.text()).not.toContain("private");
  });
});

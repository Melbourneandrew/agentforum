import { Deferred, Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  makeWorker,
  normalizeProblem,
  renderProblem,
  type WorkerExecutionContext,
} from "../src/worker.js";
import { Retrieval } from "../src/retrieval/service.js";
import { CursorProblem } from "../src/retrieval/contract.js";
import { InputProblem } from "../src/input/transport.js";
const execution: WorkerExecutionContext = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
};
const url = "https://api.agentforum.test/v1/search";
const request = (body = "{}", signal?: AbortSignal) =>
  new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    ...(signal === undefined ? {} : { signal }),
  });
describe("public retrieval boundary in workerd", () => {
  it("avoids domain acquisition for safe/unsupported methods and malformed input", async () => {
    let acquisitions = 0;
    const app = makeWorker(undefined, undefined, () => {
      acquisitions++;
      return Layer.succeed(Retrieval, {
        search: () => Effect.die(new Error("Unreachable retrieval test")),
      });
    });
    for (const method of ["HEAD", "OPTIONS", "PUT", "PATCH", "DELETE"]) {
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
    for (const input of [
      request('{"limit":0}'),
      request('{"limit":1,"limit":2}'),
      new Request(url + "?payload=" + "x".repeat(14336)),
    ])
      expect(
        (await app.fetch(input, { ENVIRONMENT: "local" }, execution)).status,
      ).toBeGreaterThanOrEqual(400);
    expect(acquisitions).toBe(0);
  });
  it("awaits the active read handler finalizer on interruption", async () => {
    const entered = await Effect.runPromise(Deferred.make<boolean>());
    let released = 0;
    const app = makeWorker(undefined, undefined, () =>
      Layer.scoped(
        Retrieval,
        Effect.acquireRelease(
          Effect.succeed({
            search: () =>
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
      request("{}", controller.signal),
      { ENVIRONMENT: "local" },
      execution,
    );
    await Effect.runPromise(Deferred.await(entered));
    controller.abort();
    expect((await pending).status).toBe(500);
    expect(released).toBe(1);
  });
  it("reconstructs cursor/input failures with server-owned details and occurrence IDs", async () => {
    const secret = "sensitive-cursor-or-query-never-reflect";
    for (const problem of [
      new CursorProblem({
        type: "https://docs.agentforum.site/problems/cursor-unusable",
        title: "Cursor cannot be used",
        status: 400,
        detail: secret,
        instance: secret,
      }),
      new InputProblem({
        type: "https://docs.agentforum.site/problems/input-rejected",
        title: "Input rejected",
        status: 400,
        detail: secret,
        instance: secret,
        issues: [{ location: [secret] }],
        canonical: "/v1/search",
        limit: 999,
      }),
    ]) {
      const normalized = await Effect.runPromise(
        normalizeProblem(
          Response.json(problem, {
            status: 400,
            headers: { "Content-Type": "application/problem+json" },
          }),
          "server",
          "search",
          true,
        ),
      );
      const response = renderProblem(normalized, "POST", {});
      expect(response.status).toBe(400);
      const body = await response.text();
      expect(body).not.toContain(secret);
      expect(body).toContain("urn:uuid:server");
      if (problem._tag === "InputProblem") expect(body).toContain('"limit":50');
    }
  });
  it("records no application read-access diagnostic for failures, including invalid environment", async () => {
    const log = vi.spyOn(console, "log");
    try {
      const app = makeWorker(undefined, undefined, () =>
        Layer.succeed(Retrieval, {
          search: () => Effect.die(new Error("sensitive-query-value")),
        }),
      );
      for (const bindings of [{ ENVIRONMENT: "local" }, undefined]) {
        const response = await app.fetch(request(), bindings, execution);
        expect(response.status).toBe(500);
        expect(await response.text()).not.toContain("sensitive-query-value");
      }
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
});

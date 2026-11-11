import { Deferred, Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
  makeWorker,
  normalizeProblem,
  renderProblem,
  type WorkerExecutionContext,
} from "../src/worker.js";
import { Registration } from "../src/identity/service.js";
import { NameUnavailableProblem } from "../src/identity/contract.js";
import { InputProblem } from "../src/input/transport.js";
const execution: WorkerExecutionContext = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
};
const url = "https://api.agentforum.test/v1/register";
describe("registration HTTP lifecycle and closed error boundary in workerd", () => {
  it("does not acquire registration for safe/unsupported methods or invalid/over-budget input", async () => {
    let acquisitions = 0;
    let calls = 0;
    const app = makeWorker(undefined, () => {
      acquisitions++;
      return Layer.succeed(Registration, {
        register: () =>
          Effect.suspend(() => {
            calls++;
            return Effect.die(
              new Error("Invalid test: handler must never run"),
            );
          }),
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
      else
        expect(response.headers.get("Allow")).toBe("GET, POST, HEAD, OPTIONS");
    }
    for (const request of [
      new Request(url + "?payload=" + encodeURIComponent('{"name":""}')),
      new Request(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"name":"a","name":"b"}',
      }),
      new Request(url + "?payload=" + "x".repeat(14336)),
    ])
      expect(
        (await app.fetch(request, { ENVIRONMENT: "local" }, execution)).status,
      ).toBeGreaterThanOrEqual(400);
    for (const path of ["/v1/health", "/llms.txt", "/skill.md"])
      expect(
        (
          await app.fetch(
            new Request("https://api.agentforum.test" + path),
            { ENVIRONMENT: "local" },
            execution,
          )
        ).status,
      ).toBe(200);
    expect(acquisitions).toBe(0);
    expect(calls).toBe(0);
  });
  it("interrupts an active registration handler and awaits its request-scoped finalizer", async () => {
    const entered = await Effect.runPromise(Deferred.make<boolean>());
    let released = 0;
    const app = makeWorker(undefined, () =>
      Layer.scoped(
        Registration,
        Effect.acquireRelease(
          Effect.succeed({
            register: () =>
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
      new Request(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal: controller.signal,
      }),
      { ENVIRONMENT: "local" },
      execution,
    );
    await Effect.runPromise(Deferred.await(entered));
    controller.abort();
    const response = await pending;
    expect(response.status).toBe(500);
    expect(released).toBe(1);
  });
  it("rebuilds recognized registration errors instead of reflecting details, issue data or occurrence IDs", async () => {
    const secret = "af_v1.synthetic-key-must-never-be-reflected";
    const problems = [
      new InputProblem({
        type: "https://docs.agentforum.site/problems/input-rejected",
        title: "Input rejected",
        status: 400,
        detail: secret,
        instance: secret,
        issues: [{ location: [secret] }],
        limit: 999,
        canonical: "/v1/register",
      }),
      new NameUnavailableProblem({
        type: "https://docs.agentforum.site/problems/name-unavailable",
        title: "Agent name unavailable",
        status: 409,
        detail: secret,
        instance: secret,
      }),
    ];
    for (const problem of problems) {
      const response = Response.json(problem, {
        status: problem.status,
        headers: { "Content-Type": "application/problem+json" },
      });
      const normalized = await Effect.runPromise(
        normalizeProblem(response, "server-owned-occurrence", true, true),
      );
      const output = renderProblem(normalized, "POST", {});
      expect(output.status).toBe(problem.status);
      const text = await output.text();
      expect(text).not.toContain(secret);
      expect(text).toContain("urn:uuid:server-owned-occurrence");
      if (problem.status === 400) expect(text).toContain('"limit":39');
    }
  });
  it("contains malformed/oversized or unsupported registration error bodies as generic 500s", async () => {
    for (const body of [
      "not-json",
      "x".repeat(8193),
      JSON.stringify({
        _tag: "InputProblem",
        type: "https://docs.agentforum.site/problems/input-rejected",
        title: "Input rejected",
        status: 413,
        detail: "synthetic-sensitive-detail",
        instance: "untrusted",
        issues: [],
        limit: 999,
        canonical: "/v1/register",
      }),
    ]) {
      const normalized = await Effect.runPromise(
        normalizeProblem(
          new Response(body, {
            status: 413,
            headers: { "Content-Type": "application/problem+json" },
          }),
          "server",
          true,
          true,
        ),
      );
      expect(normalized.status).toBe(500);
      expect(JSON.stringify(normalized)).not.toContain(
        "synthetic-sensitive-detail",
      );
    }
  });
});

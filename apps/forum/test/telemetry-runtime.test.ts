import { env } from "cloudflare:workers";
import { Option } from "effect";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { makeDispatcher } from "../src/runtime/dispatch.js";
import { sanitizeDiagnosticMetadata } from "../src/telemetry/diagnostics.js";
import type { Execution } from "../src/runtime/context.js";
import { migrate } from "./d1.js";
const execution: Execution = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
};
const secret = "SYNTHETIC-WO35-private";
const pair = { environment: "staging", revision: "a".repeat(40) };
beforeAll(() => migrate());
afterEach(() => vi.restoreAllMocks());
const render = () => Promise.resolve(new Response("public"));
for (const method of ["GET", "POST"]) {
  it(`immutable admitted pair survives hostile ${method} request in native D1`, async () => {
    const metadata = sanitizeDiagnosticMetadata(pair);
    const app = makeDispatcher(render, metadata);
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const payload = JSON.stringify({
      name: `metadata-${method.toLowerCase()}`,
    });
    const response = await app.fetch(
      new Request(
        `https://local.owner.workers.dev/v1/register${method === "GET" ? `?payload=${encodeURIComponent(payload)}` : ""}`,
        {
          method,
          headers: {
            "Content-Type": "application/json",
            "deployment.environment.name": secret,
            "service.version": secret,
            "X-Request-Id": secret,
            Authorization: `Bearer ${secret}`,
            Cookie: secret,
          },
          ...(method === "POST" ? { body: payload } : {}),
        },
      ),
      env,
      execution,
    );
    expect(response.status).toBe(201);
    const body: unknown = await response.json();
    const record: unknown = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(record).toHaveProperty("deployment.environment.name", "staging");
    expect(record).toHaveProperty("service.version", pair.revision);
    expect(record).toHaveProperty(
      "request.id",
      response.headers.get("X-Request-Id"),
    );
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    if (typeof body === "object" && body !== null && "apiKey" in body)
      expect(JSON.stringify(log.mock.calls)).not.toContain(body.apiKey);
  });
}
it("native source has no compile define and default writer remains None", async () => {
  expect(typeof __AGENTFORUM_DEPLOYMENT__).toBe("undefined");
  const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
  await makeDispatcher(render).fetch(
    new Request("https://local.owner.workers.dev/v1/register", {
      method: "OPTIONS",
    }),
    env,
    execution,
  );
  expect(JSON.stringify(log.mock.calls)).not.toContain(
    "deployment.environment.name",
  );
  expect(JSON.stringify(log.mock.calls)).not.toContain("service.version");
  expect(log).toHaveBeenCalledOnce();
});
it.each([
  null,
  { environment: "production" },
  { revision: pair.revision },
  { ...pair, excess: secret },
  { ...pair, environment: "unknown" },
])("invalid pair omits both but keeps base: %j", async (input) => {
  const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
  const response = await makeDispatcher(
    render,
    sanitizeDiagnosticMetadata(input),
  ).fetch(
    new Request("https://local.owner.workers.dev/v1/register", {
      method: "OPTIONS",
    }),
    env,
    execution,
  );
  expect(response.status).toBe(204);
  expect(JSON.stringify(log.mock.calls)).toContain("operation.completed");
  expect(JSON.stringify(log.mock.calls)).not.toContain("service.version");
  expect(JSON.stringify(log.mock.calls)).not.toContain(
    "deployment.environment.name",
  );
});
it("snapshots pair once and diagnostic sink failure is nonfatal", async () => {
  const supplied = { environment: "staging" as const, revision: pair.revision };
  const app = makeDispatcher(render, Option.some(supplied));
  supplied.revision = "b".repeat(40);
  const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
  await app.fetch(
    new Request("https://local.owner.workers.dev/v1/register", {
      method: "OPTIONS",
    }),
    env,
    execution,
  );
  expect(JSON.stringify(log.mock.calls)).toContain(pair.revision);
  expect(JSON.stringify(log.mock.calls)).not.toContain(supplied.revision);
  log.mockImplementation(() => {
    throw new Error(secret);
  });
  expect(
    (
      await app.fetch(
        new Request("https://local.owner.workers.dev/v1/register", {
          method: "OPTIONS",
        }),
        env,
        execution,
      )
    ).status,
  ).toBe(204);
});

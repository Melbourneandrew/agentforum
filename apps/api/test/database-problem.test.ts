import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  HttpServer,
  OpenApi,
} from "@effect/platform";
import { Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  databaseTimeoutProblem,
  DatabaseConnectionTimeoutProblem,
} from "../src/database/problems.js";
import worker, {
  Health,
  makeWorker,
  normalizeProblem,
  renderProblem,
} from "../src/worker.js";

const timeoutDto = (id: string) =>
  Schema.encodeSync(DatabaseConnectionTimeoutProblem)(
    databaseTimeoutProblem(id),
  );
const id = "b727d132-455a-4a6d-a111-3492d2c90107";
const Api = HttpApi.make("private-database-contract-probe").add(
  HttpApiGroup.make("probe").add(
    HttpApiEndpoint.get("acquire", "/acquire")
      .addSuccess(Schema.String)
      .addError(
        DatabaseConnectionTimeoutProblem.pipe(
          HttpApiSchema.withEncoding({
            kind: "Json",
            contentType: "application/problem+json",
          }),
        ),
        { status: 503 },
      ),
  ),
);
const execution = {
  waitUntil: (pending: Promise<unknown>) => {
    void pending;
  },
  passThroughOnException: () => undefined,
  props: {},
};
describe("declared database backpressure boundary in workerd", () => {
  it("preserves an actual HttpApi declared 503, fixed Retry-After and safe server-owned detail", async () => {
    const app = HttpApiBuilder.toWebHandler(
      HttpApiBuilder.api(Api).pipe(
        Layer.provide(
          HttpApiBuilder.group(Api, "probe", (handlers) =>
            handlers.handle("acquire", () =>
              Effect.fail(
                new DatabaseConnectionTimeoutProblem({
                  ...timeoutDto("untrusted-instance"),
                  detail: "synthetic-origin-secret",
                }),
              ),
            ),
          ),
        ),
        Layer.provideMerge(HttpServer.layerContext),
      ),
    );
    try {
      const response = await app.handler(
        new Request("https://database-fixture.test/acquire"),
      );
      expect(response.status).toBe(503);
      const result = renderProblem(
        await Effect.runPromise(normalizeProblem(response, id)),
        "GET",
        { "X-Request-Id": id },
      );
      expect(result.status).toBe(503);
      expect(result.headers.get("Retry-After")).toBe("1");
      expect(result.headers.get("Content-Type")).toBe(
        "application/problem+json",
      );
      const body = await result.text();
      expect(body).not.toContain("synthetic-origin-secret");
      expect(body).not.toContain("untrusted-instance");
      expect(
        Schema.decodeUnknownSync(
          Schema.parseJson(DatabaseConnectionTimeoutProblem),
        )(body).instance,
      ).toBe(`urn:uuid:${id}`);
      expect(
        OpenApi.fromApi(Api).paths["/acquire"]?.get?.responses,
      ).toHaveProperty("503");
    } finally {
      await app.dispose();
    }
  });
  it("contains arbitrary 503s, malformed/oversized bodies and wrong schemas as generic 500s", async () => {
    for (const body of [
      "not-json",
      JSON.stringify({ status: 503, detail: "synthetic-secret" }),
      JSON.stringify({
        ...timeoutDto("wrong"),
        _tag: "UndeclaredProblem",
      }),
      JSON.stringify({
        ...timeoutDto("oversized"),
        detail: "x".repeat(8_193),
      }),
    ]) {
      const response = new Response(body, {
        status: 503,
        headers: {
          "Content-Type": "application/problem+json",
          "Retry-After": "synthetic-secret",
        },
      });
      const result = renderProblem(
        await Effect.runPromise(normalizeProblem(response, id)),
        "GET",
        {},
      );
      expect(result.status).toBe(500);
      expect(result.headers.has("Retry-After")).toBe(false);
      expect(await result.text()).not.toContain("synthetic-secret");
    }
  });
  it("does not promote an undeclared thrown timeout to an expected 503", async () => {
    const app = makeWorker(
      Layer.succeed(Health, {
        check: Effect.die(databaseTimeoutProblem("synthetic-secret")),
      }),
    );
    const response = await app.fetch(
      new Request("https://api.agentforum.test/v1/health"),
      { ENVIRONMENT: "local" },
      execution,
    );
    expect(response.status).toBe(500);
    expect(response.headers.has("Retry-After")).toBe(false);
    expect(await response.text()).not.toContain("synthetic-secret");
    const healthy = await worker.fetch(
      new Request("https://api.agentforum.test/v1/health"),
      { ENVIRONMENT: "local" },
      execution,
    );
    expect(healthy.status).toBe(200);
  });
  it("renders HEAD backpressure bodylessly", async () => {
    const response = renderProblem(databaseTimeoutProblem(id), "HEAD", {});
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("1");
    expect(await response.text()).toBe("");
  });
});

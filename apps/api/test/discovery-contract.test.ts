import { contractPaths, contractUrls } from "@agentforum/discovery-assets";
import { PostRecord } from "@agentforum/contracts";
import { Effect, JSONSchema, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { makeOpenApi } from "../src/contract.js";
import { PublicationInput } from "../src/input/transport.js";
import { makePostSchema, postRequirements } from "../src/post-schema.js";
import {
  Health,
  makeWorker,
  type WorkerExecutionContext,
} from "../src/worker.js";
const execution: WorkerExecutionContext = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
};
const env = { ENVIRONMENT: "local" };
const request = (path: string, method = "GET") =>
  new Request("https://api.agentforum.test" + path, { method });
describe("public code-generated discovery contracts in workerd", () => {
  it("serves exact generated models anonymously, with direct authoritative schema links", async () => {
    expect(navigator.userAgent).toContain("Cloudflare-Workers");
    const app = makeWorker();
    for (const [path, model] of [
      [contractPaths.openApi, makeOpenApi()],
      [contractPaths.postSchema, makePostSchema()],
    ] as const) {
      const response = await app.fetch(request(path), env, execution);
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toContain(
        "application/json",
      );
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
      const value: unknown = await response.json();
      expect(value).toEqual(model);
    }
    expect(
      Schema.decodeUnknownSync(
        Schema.Struct({ externalDocs: Schema.Struct({ url: Schema.String }) }),
      )(makeOpenApi()).externalDocs.url,
    ).toBe(contractUrls.postSchema);
  });
  it("keeps safe methods and mutation denials away from service acquisition", async () => {
    let healthCalls = 0;
    const app = makeWorker(
      Layer.sync(Health, () => {
        healthCalls++;
        return { check: Effect.succeed({ status: "ok" as const }) };
      }),
    );
    for (const path of Object.values(contractPaths)) {
      for (const method of [
        "HEAD",
        "OPTIONS",
        "POST",
        "PUT",
        "PATCH",
        "DELETE",
      ]) {
        const response = await app.fetch(request(path, method), env, execution);
        expect(response.status).toBe(
          method === "HEAD" ? 200 : method === "OPTIONS" ? 204 : 404,
        );
        if (method === "HEAD" || method === "OPTIONS")
          expect(await response.text()).toBe("");
      }
    }
    expect(healthCalls).toBe(0);
  });
  it("resolves every generated document-root reference after embedding the published model", () => {
    const model = makePostSchema();
    const record = Schema.Record({ key: Schema.String, value: Schema.Unknown });
    const references = [
      ...JSON.stringify(model).matchAll(/"\$ref":"(#[^"]+)"/g),
    ];
    expect(references.length).toBeGreaterThanOrEqual(2);
    for (const match of references) {
      const reference = Schema.decodeUnknownSync(Schema.String)(match[1]);
      expect(reference.startsWith("#/")).toBe(true);
      let target: unknown = model;
      for (const part of reference.slice(2).split("/"))
        target =
          Schema.decodeUnknownSync(record)(target)[
            part.replace(/~1/g, "/").replace(/~0/g, "~")
          ];
      expect(
        target,
        "Unresolved generated reference " + reference,
      ).not.toBeUndefined();
    }
  });
  it("reuses submission/output ASTs and leaves metadata genuinely open", () => {
    const model = makePostSchema();
    const input = JSONSchema.make(PublicationInput, {
      target: "jsonSchema2020-12",
    });
    const object = Schema.Struct({
      properties: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
      required: Schema.Array(Schema.String),
    });
    const submission = Schema.decodeUnknownSync(object)(model);
    expect(submission.properties).toEqual(
      Schema.decodeUnknownSync(object)(input).properties,
    );
    expect(submission.required).toEqual(["body"]);
    expect(model.$defs.PublishedPost).toEqual(
      JSONSchema.make(PostRecord, { target: "jsonSchema2020-12" }),
    );
    expect(submission.properties.metadata).toEqual({
      type: "object",
      additionalProperties: true,
    });
    expect(model["x-schema-version"]).toBe("v1");
    expect(model["x-authoritative-requirements"]).toEqual(postRequirements);
    expect(model["x-server-established"].fields).toEqual([
      "id",
      "author_id",
      "author_name",
      "published_at",
      "publication_order",
    ]);
  });
});

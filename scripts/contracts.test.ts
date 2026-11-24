import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { JSONSchema } from "effect";
import { machineContract } from "../apps/forum/src/api/definition.js";
import { PostResult, PublishInput } from "../apps/forum/src/api/contracts.js";
import { problemCatalog } from "../apps/forum/src/api/problems.js";

const read = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
describe("generated machine contract consumers", () => {
  it("keeps exactly three operations with equivalent logical method responses", () => {
    const spec = machineContract();
    expect(Object.keys(spec.paths).sort()).toEqual([
      "/v1/publish",
      "/v1/register",
      "/v1/search",
    ]);
    for (const path of Object.values(spec.paths)) {
      expect(path.get?.responses).toEqual(path.post?.responses);
      expect(path.post?.requestBody).toBeDefined();
      for (const operation of [path.get, path.post])
        expect(operation?.responses["400"]?.content).toEqual({
          "application/problem+json": {
            schema: { $ref: "#/components/schemas/BadRequest" },
          },
        });
      expect(path.get?.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "payload",
            in: "query",
            required: true,
          }),
        ]),
      );
    }
  });
  it("declares header Bearer without ambient credentials and does not add an identity operation", () => {
    const spec = machineContract();
    expect(spec.paths["/v1/publish"]?.get?.security).toEqual([{ Bearer: [] }]);
    expect(spec.paths["/v1/publish"]?.post?.security).toEqual([{ Bearer: [] }]);
    expect(spec.servers).toEqual([{ url: "/" }]);
  });
  it("preserves the complete result validator while exposing generated publication input and local guidance metadata", () => {
    const generated = read("apps/forum/generated/post.schema.json");
    assert.ok(typeof generated === "object" && generated !== null);
    assert.ok("$defs" in generated);
    const result = JSONSchema.make(PostResult);
    const input = JSONSchema.make(PublishInput);
    assert.ok("$ref" in input);
    expect(generated).toMatchObject(result);
    expect(generated.$defs).toEqual({ ...result.$defs, ...input.$defs });
    expect(Object.keys(generated).sort()).toEqual(
      [
        "$schema",
        "$ref",
        "$defs",
        "title",
        "description",
        "x-schema-version",
        "x-api-path-version",
        "x-publication-input",
        "x-documentation",
      ].sort(),
    );
    expect(generated).toMatchObject({
      "x-schema-version": machineContract().info.version,
      "x-api-path-version": "v1",
      "x-publication-input": { $ref: input.$ref },
      "x-documentation": {
        publication: "/docs/publication/",
        retrieval: "/docs/retrieval/",
      },
    });
  });
  it("publishes safe installation-local problem documentation from the response catalog", () => {
    for (const [code, detail] of Object.entries(problemCatalog))
      expect(read(`apps/forum/public/docs/problems/${code}.json`)).toEqual({
        title: code.replaceAll("-", " "),
        detail,
      });
  });
});

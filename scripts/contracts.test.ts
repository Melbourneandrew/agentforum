import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { JSONSchema } from "effect";
import { machineContract } from "../apps/forum/src/api/definition.js";
import { PostResult } from "../apps/forum/src/api/contracts.js";
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
  it("generates the Post Schema from the same runtime schema", () => {
    expect(read("apps/forum/generated/post.schema.json")).toEqual(
      JSONSchema.make(PostResult),
    );
  });
  it("publishes safe installation-local problem documentation from the response catalog", () => {
    for (const [code, detail] of Object.entries(problemCatalog))
      expect(read(`apps/forum/public/docs/problems/${code}.json`)).toEqual({
        title: code.replaceAll("-", " "),
        detail,
      });
  });
});

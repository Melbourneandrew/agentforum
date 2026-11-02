import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import SwaggerParser from "@apidevtools/swagger-parser";
import { makeOpenApi } from "../src/contract.js";

const spec = makeOpenApi();
const expected: unknown = spec;
assert.deepEqual(
  JSON.parse(await readFile("generated/openapi.json", "utf8")),
  expected,
  "Regenerate the OpenAPI description",
);
await SwaggerParser.validate("generated/openapi.json");
assert.equal(spec.openapi, "3.1.0");
assert.deepEqual(Object.keys(spec.paths).sort(), [
  "/llms.txt",
  "/skill.md",
  "/v1/health",
]);
for (const path of ["/llms.txt", "/skill.md"]) {
  assert.deepEqual(Object.keys(spec.paths[path] ?? {}), ["get"]);
  assert.ok(
    Object.hasOwn(
      spec.paths[path]?.get?.responses["200"]?.content ?? {},
      "text/markdown; charset=utf-8",
    ),
    "Shared guide must declare its actual text representation",
  );
}
assert.deepEqual(Object.keys(spec.paths["/v1/health"] ?? {}), ["get"]);

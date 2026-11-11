import { SearchInput } from "../src/retrieval/contract.js";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import SwaggerParser from "@apidevtools/swagger-parser";
import { makeInputContracts } from "../src/input/transport.js";
import { JSONSchema, Schema } from "effect";
import { RegistrationInput } from "../src/identity/contract.js";
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
  "/v1/register",
  "/v1/search",
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

assert.deepEqual(
  JSON.parse(await readFile("generated/input-schemas.json", "utf8")),
  makeInputContracts(),
  "Regenerate reusable input schemas",
);

for (const { path, model, statuses } of [
  {
    path: "/v1/register",
    model: JSONSchema.make(RegistrationInput, { target: "jsonSchema2020-12" }),
    statuses: ["201", "400", "401", "405", "409", "413", "415", "500", "503"],
  },
  {
    path: "/v1/search",
    model: JSONSchema.make(SearchInput, { target: "jsonSchema2020-12" }),
    statuses: ["200", "400", "401", "404", "405", "413", "415", "500", "503"],
  },
]) {
  const business = spec.paths[path];
  assert.ok(business?.get && business.post);
  assert.deepEqual(Object.keys(business).sort(), ["get", "post"]);
  assert.deepEqual(
    business.get.responses,
    business.post.responses,
    "Both transports must share success/error contracts",
  );
  assert.deepEqual(Object.keys(business.get.responses).sort(), statuses);
  assert.deepEqual(
    business.get.parameters.map((value) => [
      value.name,
      value.in,
      value.required,
    ]),
    [["payload", "query", true]],
  );
  assert.equal(business.get.requestBody, undefined);
  assert.deepEqual(business.post.parameters, []);
  assert.deepEqual(business.get.security, []);
  assert.deepEqual(business.post.security, []);
  const expectedModel = model;
  const encodedModel = Schema.decodeUnknownSync(
    Schema.Struct({ contentSchema: Schema.Unknown }),
  )(business.get.parameters[0]?.schema);
  assert.deepEqual(
    encodedModel.contentSchema,
    expectedModel,
    "GET JSON must derive from the POST logical model",
  );
  const { $schema, ...bodyModel } = expectedModel;
  assert.equal($schema, "https://json-schema.org/draft/2020-12/schema");
  assert.deepEqual(
    business.post.requestBody?.content["application/json"]?.schema,
    bodyModel,
  );
}

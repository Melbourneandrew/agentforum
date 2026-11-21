import SwaggerParser from "@apidevtools/swagger-parser";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { format } from "prettier";
import { OpenApi } from "@effect/platform";
import { JSONSchema } from "effect";
import { Api } from "../src/api/definition.js";
import { PostResult } from "../src/api/contracts.js";
import { problemCatalog } from "../src/api/problems.js";

if (
  process.argv.length > 3 ||
  (process.argv.length === 3 && process.argv[2] !== "--check")
)
  throw new Error("Unsupported contract command");
const spec = OpenApi.fromApi(Api, { additionalPropertiesStrategy: "strict" });
spec.components.securitySchemes.Bearer = { type: "http", scheme: "bearer" };
// Raw handlers use our original-byte decoder; the boundary replaces all platform
// decode failures with the declared safe problem. Do not advertise its internals.
for (const path of Object.values(spec.paths))
  for (const method of ["get", "post"] as const) {
    const response = path[method]?.responses["400"];
    if (response?.content) delete response.content["application/json"];
  }
const outputs: readonly (readonly [string, unknown])[] = [
  ["generated/openapi.json", spec],
  ["generated/post.schema.json", JSONSchema.make(PostResult)],
  ...Object.entries(problemCatalog).map(
    ([code, detail]): readonly [string, unknown] => [
      `public/docs/problems/${code}.json`,
      { title: code.replaceAll("-", " "), detail },
    ],
  ),
];
for (const [file, value] of outputs) {
  const output = await format(JSON.stringify(value), { parser: "json" });
  if (process.argv[2] === "--check") {
    if (readFileSync(file, "utf8") !== output)
      throw new Error("Regenerate machine contracts and problem documents");
  } else {
    mkdirSync(file.slice(0, file.lastIndexOf("/")), { recursive: true });
    writeFileSync(file, output);
  }
}
await SwaggerParser.validate("generated/openapi.json", {
  resolve: { external: false },
});

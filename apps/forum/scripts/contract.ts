import SwaggerParser from "@apidevtools/swagger-parser";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { format } from "prettier";
import { JSONSchema } from "effect";
import { machineContract } from "../src/api/definition.js";
import { CursorEnvelope } from "../src/api/query.js";
import { PostResult } from "../src/api/contracts.js";
import { problemCatalog } from "../src/api/problems.js";

if (
  process.argv.length > 3 ||
  (process.argv.length === 3 && process.argv[2] !== "--check")
)
  throw new Error("Unsupported contract command");
const spec = machineContract();
const outputs: readonly (readonly [string, unknown])[] = [
  ["generated/openapi.json", spec],
  ["generated/post.schema.json", JSONSchema.make(PostResult)],
  ["generated/cursor.schema.json", JSONSchema.make(CursorEnvelope)],
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

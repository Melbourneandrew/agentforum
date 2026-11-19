import { readFileSync, writeFileSync } from "node:fs";
import { format } from "prettier";
import { OpenApi } from "@effect/platform";
import { Api } from "../src/api/handler.js";
const output = await format(JSON.stringify(OpenApi.fromApi(Api)), {
  parser: "json",
});
const file = "generated/openapi.json";
if (process.argv[2] === "--check") {
  if (readFileSync(file, "utf8") !== output)
    throw new Error("Regenerate the OpenAPI description");
} else if (process.argv.length === 2) writeFileSync(file, output);
else throw new Error("Unsupported contract command");

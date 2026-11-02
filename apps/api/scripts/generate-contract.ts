import { mkdir, writeFile } from "node:fs/promises";
import { format } from "prettier";
import { makeOpenApi } from "../src/contract.js";

await mkdir(new URL("../generated/", import.meta.url), { recursive: true });
await writeFile(
  new URL("../generated/openapi.json", import.meta.url),
  await format(JSON.stringify(makeOpenApi()), { parser: "json" }),
);

import { mkdir, writeFile } from "node:fs/promises";
import { makeOpenApi } from "../src/contract.js";

await mkdir(new URL("../generated/", import.meta.url), { recursive: true });
await writeFile(
  new URL("../generated/openapi.json", import.meta.url),
  `${JSON.stringify(makeOpenApi(), null, 2)}\n`,
);

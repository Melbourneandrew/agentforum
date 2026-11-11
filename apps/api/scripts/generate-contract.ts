import { makePostSchema } from "../src/post-schema.js";
import { mkdir, writeFile } from "node:fs/promises";
import { format } from "prettier";
import { makeInputContracts } from "../src/input/transport.js";
import { makeOpenApi } from "../src/contract.js";

await mkdir(new URL("../generated/", import.meta.url), { recursive: true });
await writeFile(
  new URL("../generated/openapi.json", import.meta.url),
  await format(JSON.stringify(makeOpenApi()), { parser: "json" }),
);

await writeFile(
  new URL("../generated/input-schemas.json", import.meta.url),
  await format(JSON.stringify(makeInputContracts()), { parser: "json" }),
);

await writeFile(
  new URL("../generated/post-schema.json", import.meta.url),
  await format(JSON.stringify(makePostSchema()), { parser: "json" }),
);

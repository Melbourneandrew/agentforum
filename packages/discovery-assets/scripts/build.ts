import { writeFile } from "node:fs/promises";
import { discoveryMediaType } from "../src/index.js";
import { discoverySha256, writeDiscoveryAssets } from "./prepare.js";
const directory = new URL("../dist/", import.meta.url);
await writeDiscoveryAssets(directory);
await writeFile(
  new URL("manifest.json", directory),
  `${JSON.stringify({ mediaType: discoveryMediaType, sha256: discoverySha256() }, null, 2)}\n`,
);

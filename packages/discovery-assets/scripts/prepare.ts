import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { discoveryGuide, discoveryPaths } from "../src/index.js";

/** Build-time only; consumers supply their own explicit output directory. */
export const writeDiscoveryAssets = async (directory: URL): Promise<void> => {
  await mkdir(directory, { recursive: true });
  await Promise.all(
    discoveryPaths.map((path) =>
      writeFile(new URL(path.slice(1), directory), discoveryGuide, "utf8"),
    ),
  );
};
export const discoverySha256 = () =>
  createHash("sha256").update(discoveryGuide, "utf8").digest("hex");

import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { format } from "prettier";

/** Build in memory only. Does NOT register, emit or enable a public capability. */
export async function buildReadClient() {
  const result = await build({
    configFile: false,
    envDir: false,
    logLevel: "error",
    build: {
      write: false,
      minify: true,
      sourcemap: false,
      target: "es2022",
      lib: {
        entry: fileURLToPath(
          new URL("../app/browsing/client-entry.ts", import.meta.url),
        ),
        name: "ForumRead",
        formats: ["iife"],
      },
    },
  });
  const outputs = Array.isArray(result) ? result : [result];
  const chunks = outputs.flatMap((output) => {
    if (!("output" in output))
      throw new Error("Unexpected client build result");
    return output.output;
  });
  const chunk = chunks[0];
  if (
    chunks.length !== 1 ||
    chunk?.type !== "chunk" ||
    chunk.imports.length !== 0 ||
    chunk.dynamicImports.length !== 0
  )
    throw new Error("Client must be one standalone first-party asset");
  const code = await format(chunk.code, { parser: "babel" });
  const digest = createHash("sha256").update(code);
  const hex = digest.copy().digest("hex");
  return {
    code,
    path: `/first-party/read.${hex}.js`,
    integrity: `sha256-${digest.digest("base64")}`,
  };
}

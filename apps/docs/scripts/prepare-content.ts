import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { Schema } from "effect";
import { format } from "prettier";
import { documents } from "../app/content.js";

const raw = await readFile("../api/generated/openapi.json", "utf8");
const contract = Schema.decodeUnknownSync(
  Schema.Struct({
    openapi: Schema.Literal("3.1.0"),
    info: Schema.Struct({ title: Schema.String, version: Schema.String }),
    paths: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  }),
)(JSON.parse(raw));
const identity = {
  ...contract.info,
  openapi: contract.openapi,
  sha256: createHash("sha256").update(raw).digest("hex"),
};
await mkdir("app/generated", { recursive: true });
await writeFile(
  "app/generated/contract-info.ts",
  await format(
    `// Generated from the API-owned artifact. Do not hand-edit.\nexport const contractInfo = ${JSON.stringify(identity)} as const;\n`,
    { parser: "typescript" },
  ),
);
await mkdir("public/markdown", { recursive: true });
await mkdir("public/docs", { recursive: true });
for (const document of documents) {
  const details =
    document.slug === "contract"
      ? `\nAPI title: ${identity.title}\n\nAPI version: ${identity.version}\n\nOpenAPI marker: ${identity.openapi}\n\nSource SHA-256: ${identity.sha256}\n`
      : "";
  await writeFile(
    `public/markdown/${document.slug}.md`,
    await format(
      `# ${document.title}\n\n${document.description}\n\n${document.paragraphs.join("\n\n")}\n${details}`,
      { parser: "markdown" },
    ),
  );
}
await writeFile(
  "public/docs/llms.txt",
  `# Agentforum documentation index\n\nThis is the documentation-only index, not the shared System Discovery Guide.\n\n${documents.map((entry) => `- [${entry.title}](/markdown/${entry.slug}.md)`).join("\n")}\n`,
);

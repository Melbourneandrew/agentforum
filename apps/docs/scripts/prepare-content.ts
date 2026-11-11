import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { Schema } from "effect";
import { format } from "prettier";
import { documents } from "../app/content.js";

const raw = await readFile("../api/generated/openapi.json", "utf8");
const Operation = Schema.Struct({
  operationId: Schema.String,
  security: Schema.optionalWith(
    Schema.Array(
      Schema.Record({ key: Schema.String, value: Schema.Array(Schema.String) }),
    ),
    { default: () => [] },
  ),
  responses: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
});
const contract = Schema.decodeUnknownSync(
  Schema.Struct({
    openapi: Schema.Literal("3.1.0"),
    info: Schema.Struct({ title: Schema.String, version: Schema.String }),
    paths: Schema.Record({
      key: Schema.String,
      value: Schema.Struct({
        get: Schema.optional(Operation),
        post: Schema.optional(Operation),
      }),
    }),
  }),
)(JSON.parse(raw));
const operations = Object.entries(contract.paths).flatMap(([path, methods]) =>
  Object.entries(methods).flatMap(([method, operation]) => {
    if (operation === undefined) return [];
    if (
      operation.security.some((rule) =>
        Object.keys(rule).some((key) => key !== "AgentKey"),
      )
    )
      throw new Error("Unsupported documentation security scheme");
    return [
      {
        path,
        method: method.toUpperCase(),
        id: operation.operationId,
        authentication: operation.security.some(
          (rule) => Object.keys(rule).length > 0,
        )
          ? "Authorization: Bearer"
          : "None",
        success: Object.keys(operation.responses)
          .filter((status) => /^2[0-9]{2}$/.test(status))
          .join(", "),
      },
    ];
  }),
);
const postRaw = await readFile("../api/generated/post-schema.json", "utf8");
const post = Schema.decodeUnknownSync(
  Schema.Struct({
    $id: Schema.String,
    "x-schema-version": Schema.String,
    "x-openapi": Schema.String,
  }),
)(JSON.parse(postRaw));
const identity = {
  ...contract.info,
  operations,
  postSchema: {
    url: post.$id,
    version: post["x-schema-version"],
    sha256: createHash("sha256").update(postRaw).digest("hex"),
  },
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
      ? `\nAPI title: ${identity.title}\n\nAPI version: ${identity.version}\n\nOpenAPI marker: ${identity.openapi}\n\nSource SHA-256: ${identity.sha256}\n\nPost Schema version: ${identity.postSchema.version}\n\nPost Schema SHA-256: ${identity.postSchema.sha256}\n\n| Method | Path | Authentication | Success |\n| --- | --- | --- | --- |\n${operations.map((operation) => `| ${operation.method} | ${operation.path} | ${operation.authentication} | ${operation.success} |`).join("\n")}\n`
      : "";
  await writeFile(
    `public/markdown/${document.slug}.md`,
    await format(
      `# ${document.title}\n\n${document.description}\n\n${document.paragraphs.join("\n\n")}\n\n${document.links.map((link) => `- [${link.title}](${link.href})`).join("\n")}\n${details}`,
      { parser: "markdown" },
    ),
  );
}
await writeFile(
  "public/docs/llms.txt",
  `# Agentforum documentation index\n\nThis is the documentation-only index, not the shared System Discovery Guide.\n\n${documents.map((entry) => `- [${entry.title}](/markdown/${entry.slug}.md)`).join("\n")}\n`,
);

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  discoveryGuide,
  discoveryMediaType,
  discoveryPaths,
  isDiscoveryPath,
} from "../src/index.js";
import { discoverySha256, writeDiscoveryAssets } from "../scripts/prepare.js";

describe("shared bootstrap discovery assets", () => {
  it("uses the required Markdown media type and exact root paths", () => {
    expect(discoveryMediaType).toBe("text/markdown; charset=utf-8");
    expect(discoveryPaths).toEqual(["/llms.txt", "/skill.md"]);
    expect(isDiscoveryPath("/llms.txt")).toBe(true);
    expect(isDiscoveryPath("/skill.md")).toBe(true);
    expect(isDiscoveryPath("/docs/llms.txt")).toBe(false);
    expect(isDiscoveryPath("/llms.txt/other")).toBe(false);
  });
  it("identifies Agentspace and all three audiences and only implemented business instructions", () => {
    expect(discoveryGuide).toContain("# Agentspace (Agentforum)");
    for (const host of [
      "agentforum.site",
      "api.agentforum.site",
      "docs.agentforum.site",
    ])
      expect(discoveryGuide).toContain(`https://${host}`);
    expect(discoveryGuide).toContain("Bootstrap orientation only");
    expect(discoveryGuide).toContain("POST /v1/register");
    expect(discoveryGuide).toContain("POST /v1/search");
    expect(discoveryGuide).toContain("No API key is required");
    expect(discoveryGuide).toContain(
      "partial unread page advances only through returned Posts",
    );
    expect(discoveryGuide).toContain(
      "Metadata filters, text queries and relevance ordering are not yet accepted",
    );
    expect(discoveryGuide).toContain("UpperCamelCase with no separator");
    expect(discoveryGuide).not.toContain("words joined by hyphens");
    expect(discoveryGuide).toContain("may conflict on a requested name");
    expect(discoveryGuide).toContain("exactly one payload");
    expect(discoveryGuide).toContain("there is no recovery or reissue");
    expect(discoveryGuide).not.toContain("Registration, Post publication");

    expect(discoveryGuide).toContain("not implemented in this foundation");
    expect(discoveryGuide).toContain(
      "Humans observe without accounts or participation controls",
    );
  });
  it("has stable UTF-8 bytes without CRLF or BOM", () => {
    expect(discoveryGuide).not.toContain("\r");
    expect(discoveryGuide.startsWith("\uFEFF")).toBe(false);
    expect(discoveryGuide.endsWith("\n")).toBe(true);
    expect(discoverySha256()).toBe(
      createHash("sha256")
        .update(Buffer.from(discoveryGuide, "utf8"))
        .digest("hex"),
    );
  });
  it("emits byte-identical files from the one source and overwrites stale output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentforum-discovery-"));
    try {
      const output = pathToFileURL(`${directory}/`);
      await writeDiscoveryAssets(output);
      for (const path of discoveryPaths)
        expect(await readFile(new URL(path.slice(1), output))).toEqual(
          Buffer.from(discoveryGuide),
        );
      await writeFile(new URL("llms.txt", output), "stale output");
      await writeDiscoveryAssets(output);
      expect(await readFile(new URL("llms.txt", output))).toEqual(
        await readFile(new URL("skill.md", output)),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

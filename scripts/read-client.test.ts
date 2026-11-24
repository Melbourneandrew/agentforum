import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildReadClient } from "../apps/forum/scripts/read-client-build";

describe("inactive first-party read asset (build only, no public registration)", () => {
  it("is byte-deterministic and bound to one exact SHA256 path/SRI value", async () => {
    const first = await buildReadClient();
    const second = await buildReadClient();
    expect(second).toEqual(first);
    const hash = createHash("sha256").update(first.code);
    expect(first.path).toBe(
      `/first-party/read.${hash.copy().digest("hex")}.js`,
    );
    expect(first.integrity).toBe(`sha256-${hash.digest("base64")}`);
    expect(new TextEncoder().encode(first.code).byteLength).toBeLessThan(
      32_768,
    );
  });
  it("contains no inline evaluator, storage, backend/auth or query implementation", async () => {
    const { code } = await buildReadClient();
    expect(/\beval\s*\(|new\s+Function\s*\(/.test(code)).toBe(false);
    for (const value of [
      "D1Database",
      "ForumQueries",
      "Authorization",
      "apiKey",
      "localStorage",
      "sessionStorage",
      "indexedDB",
      "renderMarkdown",
    ])
      expect(code).not.toContain(value);
  });
});

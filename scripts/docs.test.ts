import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("static operating documentation", () => {
  it("keeps generated output, local links, safe interactions and all examples aligned with the authoritative contract", () => {
    const output = execFileSync(
      "pnpm",
      ["--filter", "@agentforum/forum", "exec", "tsx", "scripts/docs-check.ts"],
      {
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    expect(output).toContain("Documentation checks passed:");
  }, 40_000);
});

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const execute = (command: string, args: string[], cwd = root) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return { status: result.status, output: result.stdout + result.stderr };
};
const negativeFixture = (
  path: string,
  source: string,
  args: string[],
  diagnostic: string,
) => {
  writeFileSync(path, source, { flag: "wx" });
  try {
    const result = execute("pnpm", args);
    expect(result.output).toContain(diagnostic);
    expect(result.status).not.toBe(0);
  } finally {
    rmSync(path);
  }
};
const temporary = (test: (path: string) => void) => {
  const path = mkdtempSync(resolve(tmpdir(), "agentforum-ci-"));
  try {
    test(path);
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
};
const baseline = {
  openapi: "3.1.0",
  info: { title: "CI fixture", version: "1.0.0" },
  paths: {
    "/v1/health": {
      get: {
        responses: {
          "200": {
            description: "Healthy",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["status"],
                  properties: { status: { type: "string", enum: ["ok"] } },
                },
              },
            },
          },
        },
      },
    },
  },
};
const compare = (revision: object) => {
  let status: number | null = null;
  temporary((path) => {
    writeFileSync(resolve(path, "base.json"), JSON.stringify(baseline));
    writeFileSync(resolve(path, "revision.json"), JSON.stringify(revision));
    status = execute(resolve("node_modules/.cache/oasdiff/oasdiff"), [
      "breaking",
      resolve(path, "base.json"),
      resolve(path, "revision.json"),
      "--fail-on",
      "WARN",
    ]).status;
  });
  return status;
};

describe("required gates detect real introduced failures", () => {
  it("keeps all affected-consumer verification mandatory and isolated", () => {
    const workflow = readFileSync(".github/workflows/bootstrap.yml", "utf8");
    for (const required of [
      "pull_request:",
      "merge_group:",
      "branches: [main]",
      "contents: read",
      "name: Bootstrap tooling",
      "persist-credentials: false",
      "fetch-depth: 0",
      "pnpm install --frozen-lockfile",
      "pnpm ci:setup",
      "pnpm dependency:check",
      "run: pnpm check",
      "contract:check",
      "contract:generate",
      "contract:compat",
      "run: pnpm build",
      "pnpm --filter @agentforum/web bundle:smoke",
      "pnpm --filter @agentforum/docs bundle:smoke",
      "playwright install --with-deps chromium",
      "bundle:smoke",
      "security:check",
      "git diff --exit-code",
    ])
      expect(workflow).toContain(required);
    expect(workflow).not.toMatch(
      /paths(?:-ignore)?:|continue-on-error:|secrets\.|pull_request_target:|contents: write/,
    );
    // The only condition is the always-run evidence step, never a skipped gate.
    expect(workflow.match(/if:/g)).toHaveLength(1);
    expect(workflow).toContain("if: always()");
  });
  it("rejects formatting drift", () => {
    negativeFixture(
      "scripts/ci-probe.ts",
      "export const drift={value:1}\n",
      ["exec", "prettier", "--check", "scripts/ci-probe.ts"],
      "Code style issues",
    );
  }, 60_000);

  it("rejects a typed lint violation", () => {
    negativeFixture(
      "scripts/ci-probe.ts",
      "export async function unnecessaryAsync() { return 1; }\n",
      ["exec", "eslint", "scripts/ci-probe.ts", "--max-warnings", "0"],
      "@typescript-eslint/require-await",
    );
  }, 60_000);

  it("rejects unchecked index access in the actual app typecheck", () => {
    negativeFixture(
      "apps/api/test/ci-probe.ts",
      'export const unchecked: string = ["one"][9];\n',
      ["--filter", "@agentforum/api", "typecheck"],
      "TS2322",
    );
  }, 60_000);

  it("rejects an actual Effect language-service diagnostic", () => {
    negativeFixture(
      "apps/api/test/ci-probe.ts",
      'import { Effect } from "effect";\nexport const failed = Effect.gen(function* () { yield* Effect.fail("fixture"); });\n',
      ["--filter", "@agentforum/api", "effect:check"],
      "missingReturnYieldStar",
    );
  }, 60_000);

  it("rejects an actual failing unit test", () => {
    negativeFixture(
      "scripts/ci-probe.test.ts",
      'import { expect, it } from "vitest";\nit("negative fixture", () => { expect(1).toBe(2); });\n',
      ["exec", "vitest", "run", "scripts/ci-probe.test.ts"],
      "AssertionError",
    );
  }, 60_000);

  it("accepts identical and additive routes but rejects removed routes and required input", () => {
    expect(compare(baseline)).toBe(0);
    expect(
      compare({
        ...baseline,
        paths: {
          ...baseline.paths,
          "/v2/health": baseline.paths["/v1/health"],
        },
      }),
    ).toBe(0);
    expect(compare({ ...baseline, paths: {} })).not.toBe(0);
    expect(
      compare({
        ...baseline,
        paths: {
          "/v1/health": {
            get: {
              ...baseline.paths["/v1/health"].get,
              parameters: [
                {
                  name: "required",
                  in: "query",
                  required: true,
                  schema: { type: "string" },
                },
              ],
            },
          },
        },
      }),
    ).not.toBe(0);
  });

  it("fails closed for an unavailable contract baseline", () => {
    expect(
      execute("pnpm", ["contract:compat", "refs/heads/ci-nonexistent-baseline"])
        .status,
    ).not.toBe(0);
    const initial = execute("git", [
      "rev-list",
      "--first-parent",
      "--max-parents=0",
      "HEAD",
    ]);
    expect(initial.status).toBe(0);
    const result = execute("pnpm", ["contract:compat", initial.output.trim()]);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain(
      "Required base OpenAPI contract is unavailable.",
    );
  });

  it("rejects stale generated contracts via the real validator", () => {
    temporary((path) => {
      mkdirSync(resolve(path, "generated"));
      writeFileSync(
        resolve(path, "generated/openapi.json"),
        JSON.stringify(baseline),
      );
      const result = execute(
        resolve("apps/api/node_modules/.bin/tsx"),
        [resolve("apps/api/scripts/verify-contract.ts")],
        path,
      );
      expect(result.status).not.toBe(0);
      expect(result.output).toContain("Regenerate the OpenAPI description");
    });
  });

  it("rejects an oversized production bundle before launching a runtime", () => {
    temporary((path) => {
      mkdirSync(resolve(path, "dist"));
      writeFileSync(
        resolve(path, "dist/worker.js"),
        randomBytes(3 * 1024 * 1024 + 256 * 1024),
      );
      const result = execute(
        resolve("apps/api/node_modules/.bin/tsx"),
        [resolve("apps/api/scripts/bundle-smoke.ts")],
        path,
      );
      expect(result.status).not.toBe(0);
      expect(result.output).toContain("3 MiB compressed bundle limit");
    });
  });
});

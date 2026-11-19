import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { ESLint } from "eslint";
import { getFileInfo } from "prettier";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const read = (path: string): string => readFileSync(path, "utf8");
const json = (path: string): unknown => JSON.parse(read(path));

// These test real tool behavior, not only the presence of configuration keys.
describe("repository toolchain", () => {
  it("pins the running Node and package manager", () => {
    expect(process.versions.node).toBe(read(".node-version").trim());
    expect(read(".nvmrc")).toBe(read(".node-version"));
    expect(json("package.json")).toMatchObject({
      packageManager: "pnpm@10.34.9",
      engines: { node: read(".node-version").trim(), pnpm: "10.34.9" },
    });
  });

  it("enables all mandatory strict compiler settings and excludes vendored source", () => {
    const file = ts.readConfigFile("tsconfig.json", (path) =>
      ts.sys.readFile(path),
    );
    expect(file.error).toBeUndefined();
    const config = ts.parseJsonConfigFileContent(
      file.config,
      ts.sys,
      process.cwd(),
    );
    expect(config.errors).toEqual([]);
    expect(config.options).toMatchObject({
      strict: true,
      noUncheckedIndexedAccess: true,
      exactOptionalPropertyTypes: true,
    });
    expect(config.fileNames.length).toBeGreaterThan(0);
    expect(config.fileNames.some((name) => name.includes(".repos/"))).toBe(
      false,
    );
  });

  it("enforces strictness on negative compilation fixtures", () => {
    const options: ts.CompilerOptions = {
      strict: true,
      noUncheckedIndexedAccess: true,
      exactOptionalPropertyTypes: true,
      noEmit: true,
      types: [],
    };
    const host = ts.createCompilerHost(options);
    const original = host.getSourceFile.bind(host);
    host.getSourceFile = (
      name,
      languageVersion,
      onError,
      shouldCreateNewSourceFile,
    ) =>
      name === "negative.ts"
        ? ts.createSourceFile(
            name,
            "const xs: string[] = []; const x: string = xs[0]; const y: { value?: string } = { value: undefined };",
            languageVersion,
          )
        : original(name, languageVersion, onError, shouldCreateNewSourceFile);
    const diagnostics = ts.getPreEmitDiagnostics(
      ts.createProgram(["negative.ts"], options, host),
    );
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ taskId: "@agentforum/forum#build" }),
        expect.objectContaining({ taskId: "@agentforum/forum#test" }),
      ]),
    );
    expect(json("turbo.json")).toMatchObject({
      tasks: {
        build: { dependsOn: ["^build"] },
        lint: { dependsOn: ["build"] },
        typecheck: { dependsOn: ["build"] },
        test: { dependsOn: ["^build"] },
        dev: { cache: false, persistent: true },
      },
    });
  });
});

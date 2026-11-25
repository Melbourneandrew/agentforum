import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkOperationalMigrations } from "../sqlite-migrations.js";
import { CONTROL_FILE } from "./release-control.js";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "wo34-op-safety-"));
  roots.push(root);
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: root, env, encoding: "utf8" }).trim();
  git(["init", "--quiet"]);
  git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "baseline",
  ]);
  const base = git(["rev-parse", "HEAD"]),
    directory = join(root, "scripts/delivery/control-migrations");
  mkdirSync(directory, { recursive: true });
  const sql = readFileSync(
      `scripts/delivery/control-migrations/${CONTROL_FILE}`,
      "utf8",
    ),
    path = join(directory, CONTROL_FILE);
  writeFileSync(path, sql);
  return { root, base, path, directory, sql, git };
};
describe("frozen operational native parser/history safety", () => {
  it("parses/authorizes exact v1 through actual SQLite and pinned Wrangler chunks", async () => {
    const f = setup();
    await expect(checkOperationalMigrations(f.root, f.base)).resolves.toEqual({
      migrations: 1,
      statements: 1,
    });
  });
  it("preserves exact trusted-base bytes", async () => {
    const f = setup();
    f.git(["add", "."]);
    f.git([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "control",
    ]);
    await expect(
      checkOperationalMigrations(f.root, f.git(["rev-parse", "HEAD"])),
    ).resolves.toMatchObject({ migrations: 1 });
    writeFileSync(f.path, f.sql + "\n");
    await expect(checkOperationalMigrations(f.root, f.base)).rejects.toThrow(
      "history",
    );
  });
  it("rejects unreviewed additions/business SQL and symlinked streams", async () => {
    const f = setup();
    writeFileSync(
      join(f.directory, "0002_unreviewed.sql"),
      "DELETE FROM posts;",
    );
    await expect(checkOperationalMigrations(f.root, f.base)).rejects.toThrow(
      "layout",
    );
    rmSync(join(f.directory, "0002_unreviewed.sql"));
    rmSync(f.path);
    symlinkSync(join(f.root, "absent"), f.path);
    await expect(checkOperationalMigrations(f.root, f.base)).rejects.toThrow();
  });
});

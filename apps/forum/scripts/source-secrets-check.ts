import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
const fixture = new URL("../../../.dev.vars", import.meta.url);
const marker = `synthetic-never-ship-${randomUUID()}`;
// Never replace an owner's file. This synthetic source fixture is owned only
// after exclusive creation; a pre-existing file fails without changing it.
await writeFile(fixture, `UNDECLARED_SYNTHETIC_SECRET=${marker}\n`, {
  flag: "wx",
  mode: 0o600,
});
try {
  execFileSync("pnpm", ["build"], {
    stdio: "pipe",
    env: { ...process.env, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false" },
    timeout: 60_000,
  });
  const files = await readdir("dist", { recursive: true, withFileTypes: true });
  for (const file of files)
    if (file.isFile()) {
      const contents = await readFile(`${file.parentPath}/${file.name}`);
      assert.ok(
        !contents.includes(marker),
        "A production artifact captured a source secret",
      );
    }
  console.log(
    "Actual Vite/Cloudflare build excludes undeclared .dev.vars values from every artifact.",
  );
} finally {
  await rm(fixture);
}

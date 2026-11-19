import { lstatSync, rmSync } from "node:fs";
import { resolve } from "node:path";
// Explicit local reset only. Deployment/retry paths never invoke this command.
if (process.argv.length !== 2)
  throw new Error("Local D1 reset accepts no arguments");
const root = resolve(import.meta.dirname, "..");
for (const part of [
  ".wrangler",
  ".wrangler/state",
  ".wrangler/state/v3",
  ".wrangler/state/v3/d1",
]) {
  const path = resolve(root, part);
  try {
    if (lstatSync(path).isSymbolicLink())
      throw new Error("Refusing a symlinked local state path");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
  }
}
rmSync(resolve(root, ".wrangler/state/v3/d1"), {
  recursive: true,
  force: true,
});
console.log(
  "Disposable local D1 state removed. Run pnpm db:migrate:local before development.",
);

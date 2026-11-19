import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { gzipSync } from "node:zlib";
import { chromium } from "playwright";

const files = (await readdir("dist/server", { recursive: true })).filter(
  (path) => /\.m?js$/.test(path),
);
assert.ok(files.length > 0, "Missing production Worker modules");
const bytes = (
  await Promise.all(
    files.map(
      async (path) =>
        gzipSync(await readFile(join("dist/server", path))).byteLength,
    ),
  )
).reduce((sum, size) => sum + size, 0);
assert.ok(
  bytes <= 3 * 1024 * 1024,
  "Worker exceeds the 3 MiB compressed bundle limit",
);
const state = await mkdtemp(join(tmpdir(), "agent-forum-runtime-"));
const environment = {
  ...process.env,
  CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
  WRANGLER_SEND_METRICS: "false",
};
let server: ReturnType<typeof spawn> | undefined;
try {
  execFileSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "migrations",
      "apply",
      "DB",
      "--local",
      "--config",
      "../../wrangler.jsonc",
      "--persist-to",
      state,
    ],
    { env: environment, stdio: "pipe", timeout: 30_000 },
  );
  server = spawn(
    "pnpm",
    [
      "exec",
      "wrangler",
      "dev",
      "--config",
      "dist/server/wrangler.json",
      "--local",
      "--no-bundle",
      "--persist-to",
      state,
      "--inspector-port",
      "0",
      "--ip",
      "127.0.0.1",
      "--port",
      "8792",
    ],
    { env: environment, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let log = "";
  server.stdout?.on("data", (chunk: Buffer) => {
    log += chunk.toString();
  });
  server.stderr?.on("data", (chunk: Buffer) => {
    log += chunk.toString();
  });
  const origin = "http://127.0.0.1:8792";
  let ready = false;
  for (let i = 0; i < 150; i++) {
    if (server.exitCode !== null)
      throw new Error(`Production runtime exited: ${log}`);
    try {
      if ((await fetch(origin, { signal: AbortSignal.timeout(500) })).ok) {
        ready = true;
        break;
      }
    } catch {
      /* startup only */
    }
    await setTimeout(100);
  }
  assert.ok(ready, `Production runtime failed readiness: ${log}`);
  const response = await fetch(origin);
  const html = await response.text();
  assert.match(html, /One installation/);
  assert.match(html, /data-database="available"/);
  assert.doesNotMatch(html, /<script\b|<form\b|<iframe\b|<[a-z][^>]*\son\w+=/i);
  assert.match(
    response.headers.get("Content-Security-Policy") ?? "",
    /script-src 'none'/,
  );
  const css = /href="([^"]+\.css)"/.exec(html)?.[1];
  assert.ok(css, "SSR must link a real local stylesheet");
  assert.equal((await fetch(new URL(css, origin))).status, 200);
  const docs = await fetch(origin + "/docs/");
  assert.equal(docs.status, 200);
  assert.match(await docs.text(), /not a complete installation/);
  assert.equal((await fetch(origin + "/missing")).status, 404);
  for (const method of ["GET", "POST"])
    for (const operation of ["register", "publish", "search"]) {
      const result = await fetch(`${origin}/v1/${operation}`, { method });
      assert.equal(result.status, 501);
      assert.match(
        result.headers.get("Content-Type") ?? "",
        /application\/problem\+json/,
      );
      assert.match(result.headers.get("Cache-Control") ?? "", /no-store/);
    }
  for (const method of ["HEAD", "OPTIONS"]) {
    const result = await fetch(origin + "/v1/publish", { method });
    assert.equal(result.status, 204);
    assert.equal(await result.text(), "");
  }
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto(origin);
    assert.match(
      await page.locator("main").innerText(),
      /Local D1 binding available/,
    );
    await page.getByRole("link", { name: "Runtime documentation" }).click();
    assert.match(page.url(), /\/docs\//);
    assert.match(
      await page.locator("main").innerText(),
      /not a complete installation/,
    );
    await context.close();
  } finally {
    await browser.close();
  }
  console.log(
    `Production Worker: ${String(bytes)} compressed bytes; real D1, SSR/static/API/safe methods and no-JavaScript browser checks passed.`,
  );
} finally {
  try {
    await stop(server);
  } finally {
    await rm(state, { recursive: true, force: true });
  }
}
async function stop(child: ReturnType<typeof spawn> | undefined) {
  if (child?.pid === undefined) return;
  const signal = (name: NodeJS.Signals) => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, name);
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ESRCH"
      ))
        throw error;
    }
  };
  const exited =
    child.exitCode === null && child.signalCode === null
      ? once(child, "exit")
      : Promise.resolve();
  signal("SIGTERM");
  if (
    !(await Promise.race([exited.then(() => true), setTimeout(5_000, false)]))
  ) {
    signal("SIGKILL");
    await exited;
  }
  signal("SIGKILL");
}

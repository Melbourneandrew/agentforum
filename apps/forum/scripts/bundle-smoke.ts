import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { gzipSync } from "node:zlib";
import { chromium } from "playwright";
import { Schema } from "effect";

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
let migration: ReturnType<typeof spawn> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const controller = new AbortController();
const interrupt = () => {
  controller.abort();
  process.exitCode = 1;
  void browser?.close().catch(() => undefined);
};
// Wrappers may forward signals repeatedly; retain these through all cleanup.
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
try {
  migration = spawn(
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
    { env: environment, detached: true, stdio: "ignore" },
  );
  try {
    const completion: unknown = await once(migration, "exit", {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
    });
    assert.ok(
      Schema.is(Schema.Tuple(Schema.Literal(0), Schema.Null))(completion),
      "Local migration failed",
    );
  } finally {
    await stop(migration);
    migration = undefined;
  }
  controller.signal.throwIfAborted();
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
    controller.signal.throwIfAborted();
    if (server.exitCode !== null)
      throw new Error(`Production runtime exited: ${log}`);
    try {
      if (
        (await boundedFetch(origin, { signal: AbortSignal.timeout(500) })).ok
      ) {
        ready = true;
        break;
      }
    } catch {
      /* startup only */
    }
    await setTimeout(100);
  }
  assert.ok(ready, `Production runtime failed readiness: ${log}`);
  const response = await boundedFetch(origin);
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
  assert.equal((await boundedFetch(new URL(css, origin))).status, 200);
  const docs = await boundedFetch(origin + "/docs/");
  assert.equal(docs.status, 200);
  assert.match(await docs.text(), /not a complete installation/);
  assert.equal((await boundedFetch(origin + "/missing")).status, 404);
  for (const method of ["GET", "POST"])
    for (const operation of ["register", "publish", "search"]) {
      const body = JSON.stringify(
        operation === "publish" ? { body: "fixture" } : {},
      );
      const result = await boundedFetch(
        `${origin}/v1/${operation}` +
          (method === "GET" ? `?payload=${encodeURIComponent(body)}` : ""),
        method === "POST"
          ? { method, headers: { "Content-Type": "application/json" }, body }
          : { method },
      );
      assert.equal(
        result.status,
        operation === "register" ? 200 : operation === "publish" ? 401 : 501,
      );
      assert.match(
        result.headers.get("Content-Type") ?? "",
        operation === "register"
          ? /application\/json/
          : /application\/problem\+json/,
      );
      assert.match(result.headers.get("Cache-Control") ?? "", /no-store/);
    }
  assert.equal(
    (await boundedFetch(origin + "/docs/problems/invalid-request.json")).status,
    200,
  );
  for (const method of ["HEAD", "OPTIONS"]) {
    const result = await boundedFetch(origin + "/v1/publish", { method });
    assert.equal(result.status, 204);
    assert.equal(await result.text(), "");
  }
  controller.signal.throwIfAborted();
  browser = await chromium.launch({
    headless: true,
    timeout: 10_000,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });
  try {
    controller.signal.throwIfAborted();
    console.log("production_smoke_browser_started");
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
    try {
      await stop(migration);
    } finally {
      await stop(server);
    }
  } finally {
    await rm(state, { recursive: true, force: true });
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
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
    !(await Promise.race([
      exited.then(() => true),
      setTimeout(5_000, false, { ref: false }),
    ]))
  ) {
    signal("SIGKILL");
    await exited;
  }
  signal("SIGKILL");
}

function boundedFetch(input: string | URL, init?: RequestInit) {
  return fetch(input, {
    ...init,
    signal: AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(5_000),
      ...(init?.signal ? [init.signal] : []),
    ]),
  });
}

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, readdir } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { gzipSync } from "node:zlib";
import { chromium } from "playwright";
import { startObservationFixture } from "./observation-fixture.js";
import { verifyObservationJourneys } from "./observation-journeys.js";

const modules = (await readdir("dist/ssr", { recursive: true })).filter(
  (path) => /\.m?js$/.test(path),
);
assert.ok(modules.length > 0, "Missing production Worker modules");
const compressed = (
  await Promise.all(
    modules.map(
      async (path) => gzipSync(await readFile(`dist/ssr/${path}`)).byteLength,
    ),
  )
).reduce((sum, bytes) => sum + bytes, 0);
assert.ok(
  compressed <= 3 * 1024 * 1024,
  "Web Worker exceeds the 3 MiB compressed script budget",
);
const fixture = await startObservationFixture();
const server = spawn(
  "pnpm",
  [
    "exec",
    "wrangler",
    "dev",
    "--config",
    "dist/ssr/wrangler.json",
    "--local",
    "--no-bundle",
    "--var",
    "API_ORIGIN:" + fixture.origin,
    "--inspector-port",
    "0",
    "--ip",
    "127.0.0.1",
    "--port",
    "8791",
  ],
  {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  },
);
let log = "";
server.stdout.on("data", (chunk: Buffer) => {
  log += chunk.toString();
});
server.stderr.on("data", (chunk: Buffer) => {
  log += chunk.toString();
});
const base = "http://127.0.0.1:8791";
try {
  let ready = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (server.exitCode !== null)
      throw new Error(`Production runtime exited: ${log}`);
    try {
      if ((await fetch(base, { signal: AbortSignal.timeout(500) })).ok) {
        ready = true;
        break;
      }
    } catch {
      /* startup only */
    }
    await setTimeout(100);
  }
  assert.ok(ready, `Production runtime did not become ready: ${log}`);
  for (const path of ["/", "/runtime"]) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 200);
    assert.match(
      response.headers.get("Content-Security-Policy") ?? "",
      /script-src 'none'/,
    );
    const html = await response.text();
    assert.match(html, /<main/);
    if (path === "/runtime") assert.match(html, /Cloudflare-Workers/);
    assert.match(html, path === "/" ? /Agent posts/ : /Read-only by design/);
    assert.doesNotMatch(
      html,
      /<script\b|<form\b|<iframe\b|<[a-z][^>]*\son\w+=/i,
    );
  }
  assert.equal((await fetch(`${base}/missing`)).status, 404);
  assert.equal((await fetch(`${base}/shell.css`)).status, 200);
  const icon = await fetch(`${base}/favicon.svg`);
  assert.equal(icon.status, 200);
  assert.match(icon.headers.get("Content-Type") ?? "", /image\/svg\+xml/);
  for (const method of ["POST", "PUT", "PATCH", "DELETE"])
    assert.equal((await fetch(base, { method })).status, 405);
  for (const method of ["HEAD", "OPTIONS"]) {
    const response = await fetch(base, { method });
    assert.equal(response.status, method === "HEAD" ? 200 : 204);
    assert.equal(await response.text(), "");
  }
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    await verifyObservationJourneys(browser, base, fixture);
    for (const width of [390, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const failures: string[] = [];
      const mutations: string[] = [];
      const unexpectedRequests: string[] = [];
      page.on("pageerror", (error) => {
        failures.push(error.message);
      });
      page.on("console", (message) => {
        if (
          message.type() === "error" ||
          /Content Security Policy/i.test(message.text())
        )
          failures.push(message.text());
      });
      page.on("request", (request) => {
        if (request.method() !== "GET") mutations.push(request.url());
        const url = new URL(request.url());
        if (
          url.origin !== base ||
          /\/v1\/(register|publish)/.test(url.pathname)
        )
          unexpectedRequests.push(request.url());
      });
      await page.goto(base);
      await page.getByRole("heading", { name: "Agent posts" }).waitFor();
      assert.equal(
        await page.locator("script, form, input, textarea, button").count(),
        0,
      );
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        true,
      );
      assert.equal(
        await page
          .locator("main")
          .evaluate(
            (element) =>
              getComputedStyle(element).marginLeft !== "0px" ||
              getComputedStyle(element).paddingLeft !== "0px",
          ),
        true,
      );
      await page.goto(base + "/runtime");
      await page
        .getByRole("heading", { name: "Read-only by design." })
        .waitFor();
      const content = page.locator("article.untrusted-post");
      assert.equal(await content.count(), 2);
      const rendered = content.first();
      assert.equal(await rendered.locator("table").count(), 1);
      assert.match(
        await rendered.innerText(),
        /Untrusted Agent-authored content/,
      );
      assert.equal(
        await content
          .locator(
            "script, iframe, img, svg, form, input, a[href], [src], [srcdoc], [style], [onload], [onerror]",
          )
          .count(),
        0,
      );
      assert.equal(
        await page.evaluate(() => document.body.dataset.contentExecuted),
        undefined,
      );
      assert.equal(await rendered.locator(".untrusted-destination").count(), 4);
      await rendered.getByText("Raw Markdown", { exact: true }).click();
      assert.match(
        await rendered.locator(".raw-markdown").innerText(),
        /<script>/,
      );
      await rendered
        .getByText("Structured metadata (JSON)", { exact: true })
        .click();
      assert.match(
        await rendered.locator(".structured-metadata").innerText(),
        /<script>active-looking data<\/script>/,
      );
      assert.match(
        await content.last().getByRole("status").innerText(),
        /Markdown can't be rendered/,
      );
      await rendered.locator(".untrusted-destination").first().hover();
      await rendered.locator(".untrusted-destination").first().click();
      await page.waitForTimeout(200);
      assert.equal(page.url(), `${base}/runtime`);
      await page
        .getByRole("link", { name: "Return to observation site" })
        .click();
      await page.getByRole("heading", { name: "Agent posts" }).waitFor();
      assert.deepEqual(failures, []);
      assert.deepEqual(mutations, []);
      assert.deepEqual(unexpectedRequests, []);
      await page.evaluate(() => {
        const script = document.createElement("script");
        script.textContent = "document.body.dataset.cspProbe='executed'";
        document.body.append(script);
      });
      assert.equal(
        await page.evaluate(() => document.body.dataset.cspProbe),
        undefined,
      );
      await page.close();
    }
  } finally {
    await browser.close();
  }
  console.log(
    `Production web workerd/browser smoke passed; compressed Worker modules: ${String(compressed)} bytes`,
  );
} finally {
  try {
    if (server.pid !== undefined && server.exitCode === null) {
      const exited = once(server, "exit");
      process.kill(-server.pid, "SIGTERM");
      await exited;
    }
  } finally {
    await fixture.stop();
  }
}

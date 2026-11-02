import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { access, readFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { gzipSync } from "node:zlib";
import { chromium } from "playwright";
import { documents } from "../app/content.js";

assert.ok(
  gzipSync(await readFile("dist/worker.js")).byteLength <= 3 * 1024 * 1024,
  "Documentation Worker exceeds the 3 MiB compressed budget",
);
await access("build/client/index.html");
const identity = createHash("sha256")
  .update(await readFile("../api/generated/openapi.json"))
  .digest("hex");
const server = spawn(
  "pnpm",
  [
    "exec",
    "wrangler",
    "dev",
    "dist/worker.js",
    "--no-bundle",
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    "8792",
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
const base = "http://127.0.0.1:8792";
const normalize = (text: string) => text.replace(/\s+/g, " ");
try {
  let ready = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (server.exitCode !== null)
      throw new Error(`Static runtime exited: ${log}`);
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
  assert.ok(ready, `Static documentation failed to become ready: ${log}`);
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage({
      javaScriptEnabled: false,
      viewport: { width: 390, height: 900 },
    });
    const failures: string[] = [];
    const externalRequests: string[] = [];
    page.on("console", (message) => {
      if (/Content Security Policy/i.test(message.text()))
        failures.push(message.text());
    });
    page.on("request", (request) => {
      if (new URL(request.url()).origin !== base)
        externalRequests.push(request.url());
    });
    for (const path of [
      "/",
      ...documents.map((entry) => `/docs/${entry.slug}`),
    ]) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("Content-Type") ?? "", /text\/html/);
      const html = await response.text();
      assert.match(html, /<h1[^>]*>/);
      assert.doesNotMatch(html, /<script\b|<form\b|<iframe\b/i);
      if (path === "/docs/contract")
        assert.ok(
          html.includes(identity),
          "Generated contract identity drifted",
        );
      await page.goto(`${base}${path}`);
      await page.getByRole("heading", { level: 1 }).waitFor();
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      const links = await page
        .locator('a[href^="/"]')
        .evaluateAll((elements) =>
          elements
            .map((element) => element.getAttribute("href"))
            .filter((href) => href !== null),
        );
      for (const href of links)
        assert.equal(
          (await fetch(new URL(href, base))).status,
          200,
          `Broken static link ${href}`,
        );
    }
    await page.goto(base);
    await page
      .getByRole("navigation", { name: "Documentation" })
      .getByRole("link", { name: "Runtime", exact: true })
      .click();
    await page
      .getByRole("heading", {
        name: "Static documentation runtime",
        exact: true,
      })
      .waitFor();
    assert.deepEqual(failures, []);
    assert.deepEqual(externalRequests, []);
    await page.close();
  } finally {
    await browser.close();
  }
  for (const document of documents) {
    const response = await fetch(`${base}/markdown/${document.slug}.md`);
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("Content-Type"),
      "text/markdown; charset=utf-8",
    );
    const markdown = normalize(await response.text());
    assert.ok(markdown.includes(`# ${document.title}`));
    for (const paragraph of document.paragraphs)
      assert.ok(markdown.includes(normalize(paragraph)));
    if (document.slug === "contract") assert.ok(markdown.includes(identity));
  }
  const index = await fetch(`${base}/docs/llms.txt`);
  assert.equal(
    index.headers.get("Content-Type"),
    "text/markdown; charset=utf-8",
  );
  for (const path of ["/llms.txt", "/skill.md", "/not-pre-rendered"])
    assert.equal(
      (await fetch(`${base}${path}`)).status,
      404,
      "Reserved or unknown paths must not become documentation client shells",
    );
  for (const method of ["POST", "PUT", "PATCH", "DELETE"])
    assert.equal((await fetch(base, { method })).status, 405);
  for (const method of ["HEAD", "OPTIONS"]) {
    const response = await fetch(base, { method });
    assert.equal(response.status, method === "HEAD" ? 200 : 204);
    assert.equal(await response.text(), "");
  }
  console.log(
    "Production static documentation crawl, raw Markdown and no-JavaScript browser navigation passed",
  );
} finally {
  if (server.pid !== undefined && server.exitCode === null) {
    process.kill(-server.pid, "SIGTERM");
    await once(server, "exit");
  }
}

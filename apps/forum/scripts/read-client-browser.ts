// Isolated module/presentation harness. NOT the registered production Worker or D1 acceptance.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium, type Browser } from "playwright";
import { BrowsePage } from "../app/browsing/presentation";
import { EditorialShell } from "../app/presentation/editorial";
import type { BrowseModel } from "../app/browsing/data.server";
import { buildReadClient } from "./read-client-build";

const asset = await buildReadClient();
const requests: URL[] = [];
const holds = new Map<
  string,
  ReturnType<typeof Promise.withResolvers<undefined>>
>();
let failOnce = true;
const model = (url: URL): BrowseModel => {
  const controls = {
    q: url.searchParams.get("q") ?? "",
    author: url.searchParams.get("author") ?? "",
    parent: url.searchParams.get("parent") ?? "",
    tags: url.searchParams.getAll("tag"),
    tagMatch: url.searchParams.get("tagMatch") ?? "all",
    order: url.searchParams.get("order") ?? "newest",
  };
  if (controls.q === "unavailable" && failOnce) {
    failOnce = false;
    return {
      kind: "failure",
      controls,
      title: "Posts could not be loaded",
      message: "Public Posts are unavailable. Please try again.",
      retry: url.pathname + url.search,
    };
  }
  return {
    kind: "ready",
    controls,
    filtered: url.search !== "",
    next: null,
    previous: null,
    first: "/",
    posts: [
      {
        id: "AAAAAAAAAAAAAAAAAAAAA",
        authorId: "BBBBBBBBBBBBBBBBBBBBB",
        reply_to: null,
        body: `Result ${controls.q || "initial"}`,
        tags: [],
        publishedAt: "2026-11-22T00:00:00.000Z",
        publicationOrder: "1",
      },
    ],
  };
};
const canonicalOrigin = "https://canonical.fixture.example";
const markup = (value: BrowseModel) =>
  renderToStaticMarkup(
    createElement(
      "html",
      { lang: "en" },
      createElement(
        "head",
        null,
        createElement("title", null, `Module fixture ${value.controls.q}`),
        value.controls.q === "current"
          ? null
          : createElement("meta", {
              name: "description",
              content: "Isolated browser-module test only",
              "data-forum-head": "description",
            }),
        value.controls.q === "current"
          ? null
          : createElement("link", {
              rel: "canonical",
              href: canonicalOrigin + "/",
              "data-forum-head": "canonical",
            }),
        createElement("link", {
          rel: "alternate",
          href: "/forbidden-resource",
          type: "text/markdown",
        }),
        createElement("script", {
          defer: true,
          src: asset.path,
          integrity: asset.integrity,
          crossOrigin: "anonymous",
        }),
      ),
      createElement(
        "body",
        null,
        createElement(EditorialShell, {
          navigation: [{ label: "Posts", href: "/" }],
          children: [
            createElement("p", {
              key: "status",
              id: "forum-read-status",
              role: "status",
              "aria-live": "polite",
              hidden: true,
            }),
            createElement(BrowsePage, { key: "browse", model: value }),
          ],
        }),
        createElement(
          "script",
          null,
          'document.documentElement.setAttribute("data-untrusted-executed","true")',
        ),
        createElement("script", { src: "/not-trusted.js" }),
      ),
    ),
  );
const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  requests.push(url);
  if (url.pathname === asset.path) {
    response.writeHead(200, { "Content-Type": "text/javascript" });
    response.end(asset.code);
    return;
  }
  if (url.pathname !== "/" || request.method !== "GET") {
    response.writeHead(404);
    response.end();
    return;
  }
  const run = async () => {
    await holds.get(url.searchParams.get("q") ?? "")?.promise;
    if (response.destroyed) return;
    const value = model(url);
    let html = markup(value);
    if (value.controls.q === "hostile")
      html = html.replace(
        "</main>",
        '<img src="/forbidden-resource"><script>document.documentElement.setAttribute("data-untrusted-executed","true")</script></main>',
      );
    if (value.controls.q === "bad-canonical")
      html = html.replace(canonicalOrigin + "/", "https://untrusted.example/");
    if (value.controls.q === "query-canonical")
      html = html.replace(
        canonicalOrigin + "/",
        canonicalOrigin + "/?payload=sensitive",
      );
    if (value.controls.q === "bad-representation")
      html = html.replace(
        "</head>",
        '<link rel="alternate" type="text/markdown" data-forum-head="representation" href="' +
          canonicalOrigin +
          '/unsupported-post.md"></head>',
      );
    response.writeHead(value.kind === "failure" ? 503 : 200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": `default-src 'none'; script-src '${asset.integrity}'; script-src-attr 'none'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
    });
    response.end(html);
  };
  void run().catch(() => {
    response.destroy();
  });
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address !== null && typeof address === "object");
const origin = `http://127.0.0.1:${String(address.port)}`;
let browser: Browser | null = null;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  context.setDefaultTimeout(10_000);
  const page = await context.newPage();
  await page.goto(origin, { waitUntil: "networkidle" });
  const initialTitle = await page.title();
  // Inject a stale platform-owned representation only to prove removal on commit.
  await page.evaluate((href) => {
    const link = document.createElement("link");
    link.rel = "alternate";
    link.type = "text/markdown";
    link.href = href;
    link.dataset.forumHead = "representation";
    document.head.append(link);
  }, canonicalOrigin + "/docs/index.md");

  assert.equal(
    requests.filter((url) => url.pathname === "/").length,
    1,
    "No artificial mount reread",
  );
  assert.equal(await page.locator("[data-untrusted-executed]").count(), 0);
  assert.equal(
    requests.filter((url) => url.pathname === "/not-trusted.js").length,
    0,
    "No broad same-origin script trust",
  );
  const search = page.getByRole("searchbox", { name: "Search" });
  const gate = Promise.withResolvers<undefined>();
  holds.set("sunrise", gate);
  const requested = page.waitForRequest(
    (request) => new URL(request.url()).searchParams.get("q") === "sunrise",
  );
  await search.fill("s");
  await search.fill("sun");
  await search.fill("sunrise");
  await requested;
  assert.equal(await page.locator("main").getAttribute("aria-busy"), "true");
  assert.equal(
    await page.locator("#forum-read-status").innerText(),
    "Loading public page…",
  );
  assert.equal(new URL(page.url()).searchParams.get("q"), "sunrise");
  assert.equal(
    await page
      .locator('link[data-forum-head="canonical"]')
      .getAttribute("href"),
    canonicalOrigin + "/",
  );
  assert.equal(await page.title(), initialTitle); // pending head follows displayed content, not intent URL.

  assert.equal(
    requests.filter((url) =>
      ["s", "sun"].includes(url.searchParams.get("q") ?? ""),
    ).length,
    0,
  );
  gate.resolve(undefined);
  await page
    .getByRole("link", { name: "Result sunrise", exact: true })
    .waitFor();
  assert.equal(
    await search.evaluate((node) => node === document.activeElement),
    true,
    "Focus restored after live form move",
  );
  assert.equal(
    await search.evaluate((node) =>
      node instanceof HTMLInputElement ? node.selectionStart : null,
    ),
    7,
  );
  assert.equal(await page.locator("main").getAttribute("aria-busy"), "false");
  assert.equal(
    await page.locator('link[data-forum-head="representation"]').count(),
    0,
    "Absent representation removes previous owned node",
  );
  const oldGate = Promise.withResolvers<undefined>();
  holds.set("obsolete", oldGate);
  const oldRequested = page.waitForRequest(
    (request) => new URL(request.url()).searchParams.get("q") === "obsolete",
  );
  await search.fill("obsolete");
  await oldRequested;
  await search.fill("current");
  await page
    .getByRole("link", { name: "Result current", exact: true })
    .waitFor();
  oldGate.resolve(undefined);
  await page.waitForTimeout(100);
  assert.equal(
    await page
      .getByRole("link", { name: "Result obsolete", exact: true })
      .count(),
    0,
  );
  assert.equal(new URL(page.url()).searchParams.get("q"), "current");
  assert.equal(await page.title(), "Module fixture current");
  assert.equal(
    await page.locator('link[data-forum-head="canonical"]').count(),
    0,
  );
  assert.equal(await page.locator('meta[name="description"]').count(), 0);

  const beforeIme = requests.filter((url) => url.pathname === "/").length;
  await search.dispatchEvent("compositionstart", { data: "日" });
  await search.fill("日本");
  await page.waitForTimeout(350);
  assert.equal(
    requests.filter((url) => url.pathname === "/").length,
    beforeIme,
    "No read during IME",
  );
  const imeRequest = page.waitForRequest(
    (request) => new URL(request.url()).searchParams.get("q") === "日本",
  );
  await search.dispatchEvent("compositionend", { data: "日本" });
  await imeRequest;
  await page.getByRole("link", { name: "Result 日本", exact: true }).waitFor();
  await page.getByText("Filters and ordering", { exact: true }).click();
  const tag = page.getByLabel("Tag 1", { exact: true });
  await tag.fill(" Exact /Tag ");
  await page.waitForRequest(
    (request) =>
      new URL(request.url()).searchParams.get("tag") === " Exact /Tag ",
  );
  await page.waitForFunction(
    () => document.querySelector("main")?.getAttribute("aria-busy") === "false",
  );
  assert.equal(await tag.inputValue(), " Exact /Tag ");
  assert.equal(await page.getByLabel("Tag 2", { exact: true }).count(), 1);
  const failure = page.waitForResponse(
    (response) =>
      new URL(response.url()).searchParams.get("q") === "unavailable",
  );
  await search.fill("unavailable");
  assert.equal((await failure).status(), 503);
  await page
    .getByRole("heading", { name: "Posts could not be loaded" })
    .waitFor();
  await page.getByRole("link", { name: "Try again", exact: true }).click();
  await page
    .getByRole("link", { name: "Result unavailable", exact: true })
    .waitFor();
  const retainedTitle = await page.title();
  const retainedCanonical = await page
    .locator('link[data-forum-head="canonical"]')
    .getAttribute("href");
  await search.fill("hostile");
  await page.locator('#forum-read-status a[data-forum-retry="true"]').waitFor();
  assert.equal(
    await page
      .getByRole("link", { name: "Result unavailable", exact: true })
      .count(),
    1,
    "Rejected active main did not replace previous document",
  );
  assert.equal(
    requests.filter((url) => url.pathname === "/forbidden-resource").length,
    0,
    "Template parsed without resource reads",
  );
  assert.equal(await page.locator("[data-untrusted-executed]").count(), 0);
  assert.equal(await page.title(), retainedTitle);
  assert.equal(
    await page
      .locator('link[data-forum-head="canonical"]')
      .getAttribute("href"),
    retainedCanonical,
  );

  await page.goBack();
  await page.waitForFunction(
    () =>
      document.querySelector("main")?.getAttribute("aria-busy") === "false" &&
      !document.querySelector('#forum-read-status a[data-forum-retry="true"]'),
  );
  assert.notEqual(new URL(page.url()).searchParams.get("q"), "hostile");
  const beforeRejectedMetadata = await page.title();
  const beforeRejectedCanonical = await page
    .locator('link[data-forum-head="canonical"]')
    .getAttribute("href");
  for (const query of [
    "bad-canonical",
    "query-canonical",
    "bad-representation",
  ]) {
    await search.fill(query);
    await page
      .locator('#forum-read-status a[data-forum-retry="true"]')
      .waitFor();
    assert.equal(await page.title(), beforeRejectedMetadata);
    assert.equal(
      await page
        .locator('link[data-forum-head="canonical"]')
        .getAttribute("href"),
      beforeRejectedCanonical,
    );
    assert.equal(
      await page.locator('link[data-forum-head="representation"]').count(),
      0,
    );
  }
  const nojs = await browser.newContext({ javaScriptEnabled: false });
  const native = await nojs.newPage();
  await native.goto(origin);
  await native.getByRole("searchbox", { name: "Search" }).fill("native");
  await Promise.all([
    native.waitForURL("**/?q=native&**"),
    native.getByRole("searchbox", { name: "Search" }).press("Enter"),
  ]);
  await native
    .getByRole("link", { name: "Result native", exact: true })
    .waitFor();
  assert.equal(
    requests.filter((url) => url.pathname.startsWith("/v1")).length,
    0,
  );
  assert.equal(
    await native
      .locator('link[data-forum-head="canonical"]')
      .getAttribute("href"),
    canonicalOrigin + "/",
  );
  assert.equal(
    await page.locator('link[data-forum-head="representation"]').count(),
    0,
  );
  console.log(
    "PASS isolated browser-module/presentation fixture: external hash-only CSP, no mount reread, debounce, actual pending HTTP body, stale cancellation, focus/caret, IME, exact Tags/new control, authoritative503/retry, inert template/hostile resources, URL/history and native Enter. NOT registered production Worker/D126/27/28 acceptance.",
  );
  console.log(
    JSON.stringify({
      path: asset.path,
      integrity: asset.integrity,
      bytes: Buffer.byteLength(asset.code),
    }),
  );
} finally {
  for (const hold of holds.values()) hold.resolve(undefined);
  await browser?.close();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    }),
  );
}

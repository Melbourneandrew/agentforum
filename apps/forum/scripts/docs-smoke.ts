// Run against the actual production local Worker, never an external installation.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { readClient } from "../app/browsing/client-manifest";

const origin = process.env.DOCS_ORIGIN ?? "http://127.0.0.1:8794";
const url = new URL(origin);
assert.ok(
  ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname),
  "Local Worker only",
);
const evidence = process.env.DOCS_EVIDENCE ?? "/tmp/wo29-evidence";
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    ignoreHTTPSErrors: true,
  });
  context.setDefaultTimeout(15_000);
  const requests: string[] = [];
  const errors: string[] = [];
  context.on("request", (request) => requests.push(request.url()));
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  for (const width of [1280, 375, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of [
      "/docs/",
      "/docs/publication/",
      "/docs/retrieval/",
      "/docs/api/",
    ]) {
      const response = await page.goto(origin + path);
      assert.equal(response?.status(), 200);
      assert.match(response.headers()["content-type"] ?? "", /text\/html/);
      assert.match(
        response.headers()["content-security-policy"] ?? "",
        /script-src 'none'/,
      );
      assert.match(
        response.headers()["content-security-policy"] ?? "",
        /font-src 'self'/,
      );
      await page.evaluate(() => document.fonts.ready);
      assert.equal(await page.locator("h1").count(), 1);
      assert.equal(await page.locator("main").count(), 1);
      assert.equal(
        await page
          .locator("script, form, iframe, button, link[rel=prefetch]")
          .count(),
        0,
      );
      assert.ok(
        await page.evaluate(() =>
          document.fonts.check('16px "Libre Franklin"'),
        ),
      );
      assert.ok(
        (
          await page
            .locator("body")
            .evaluate((element) => getComputedStyle(element).fontFamily)
        ).includes("Libre Franklin"),
      );
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        `Page overflow: ${path}`,
      );
      for (const code of await page.locator("pre").all()) {
        assert.equal(await code.getAttribute("tabindex"), "0");
        assert.ok(await code.getAttribute("aria-label"));
      }
      await page.screenshot({
        path: `${evidence}/${path.split("/").filter(Boolean).join("-")}-${String(width)}.png`,
        fullPage: false,
      });
    }
  }
  await page.goto(origin + "/docs/");
  const publicLink = page.getByRole("link", {
    name: "Public site",
    exact: true,
  });
  await Promise.all([page.waitForURL(origin + "/"), publicLink.click()]);
  assert.equal(await page.locator('main[data-forum-view="posts"]').count(), 1);
  assert.equal(
    await page.getByRole("heading", { level: 1 }).innerText(),
    "Public forum, for Agents",
  );
  assert.equal(
    await page.getByRole("searchbox", { name: "Search" }).count(),
    1,
  );
  assert.ok(
    (await page.locator("main").innerText()).includes(
      "No Posts have been published in this installation.",
    ),
  );
  await page.goto(origin + "/docs/");
  await page.keyboard.press("Tab");
  assert.equal(await page.locator(":focus").innerText(), "Skip to content");
  await page.keyboard.press("Enter");
  assert.equal(
    await page.locator(":focus").getAttribute("id"),
    "forum-content",
  );
  await page
    .getByRole("link", { name: "Registration and publication", exact: true })
    .first()
    .click();
  assert.equal(new URL(page.url()).pathname, "/docs/publication/");
  await page.getByRole("link", { name: "Raw Markdown", exact: true }).click();
  assert.ok(
    (await page.locator("body").innerText()).includes(
      "# Registration and publication",
    ),
  );
  await page.goto(origin + "/docs/api/");
  const disclosure = page
    .locator("#publishPost details")
    .filter({ has: page.getByText("Request body schema", { exact: true }) });
  await disclosure.locator("summary").focus();
  const before = requests.length;
  await page.keyboard.press("Enter");
  assert.equal(await disclosure.getAttribute("open"), "");
  assert.ok((await disclosure.innerText()).includes("PublishInput"));
  assert.equal(
    requests.length,
    before,
    "Contract interaction must not invoke API or fetch another resource",
  );
  await page.keyboard.press("Enter");
  assert.equal(await disclosure.getAttribute("open"), null);
  await page.getByRole("link", { name: "GET /v1/search", exact: true }).click();
  assert.equal(new URL(page.url()).hash, "#searchGet");
  await page.locator("#searchGet details").first().locator("summary").click();
  assert.ok((await page.locator("#searchGet").innerText()).includes("payload"));
  const contract = await context.request.get(origin + "/docs/openapi.json");
  assert.equal(contract.status(), 200);
  assert.match(contract.headers()["content-type"] ?? "", /json/);
  const raw = await context.request.get(origin + "/docs/retrieval.md");
  assert.equal(raw.status(), 200);
  assert.match(
    raw.headers()["content-type"] ?? "",
    /text\/markdown|text\/plain|application\/octet-stream/,
  );
  assert.equal(errors.length, 0);
  assert.ok(
    requests.every((request) => new URL(request).origin === url.origin),
    "No external resources or fonts",
  );
  assert.ok(
    requests.some((request) =>
      request.includes("/fonts/libre-franklin-variable.ttf"),
    ),
    "Real local font requested",
  );
  assert.ok(
    requests.every((request) => !new URL(request).pathname.startsWith("/v1/")),
    "Documentation must not invoke any business operation",
  );
  console.log(
    "Documentation browser checks passed: actual production Worker, JavaScript disabled; desktop/mobile/320px reflow; local fonts/CSP/styles; keyboard/skip/disclosures; raw Markdown/contract; no external or API requests.",
  );
  await context.close();
  for (const javaScriptEnabled of [false, true]) {
    const journeyContext = await browser.newContext({
      javaScriptEnabled,
      ignoreHTTPSErrors: true,
    });
    const forbidden: string[] = [];
    journeyContext.on("request", (request) => {
      const target = new URL(request.url());
      if (
        target.origin !== origin ||
        target.pathname.startsWith("/v1") ||
        request.method() !== "GET" ||
        request.headers().authorization !== undefined ||
        request.headers().cookie !== undefined
      )
        forbidden.push("Forbidden observer request");
    });
    try {
      const journey = await journeyContext.newPage();
      journey.on("pageerror", () => forbidden.push("Browser error"));
      const navigation = () =>
        journey.getByRole("navigation", { name: "Main navigation" });
      const documentClick = async (
        path: string,
        click: () => Promise<void>,
      ) => {
        const [response] = await Promise.all([
          journey.waitForResponse(
            (response) =>
              response.url() === origin + path &&
              response.request().isNavigationRequest() &&
              response.request().resourceType() === "document",
          ),
          click(),
        ]);
        assert.equal(response.status(), 200);
        await journey.waitForLoadState("load");
        assert.equal(new URL(journey.url()).pathname, path);
        return response;
      };
      const postsShell = async () => {
        assert.equal(
          await journey.locator('main[data-forum-view="posts"]').count(),
          1,
        );
        assert.equal(await journey.locator("#forum-read-status").count(), 1);
        const script = journey.locator("script");
        assert.equal(await script.count(), 1);
        assert.equal(await script.getAttribute("src"), readClient.path);
        assert.equal(
          await script.getAttribute("integrity"),
          readClient.integrity,
        );
      };
      for (const path of [
        "/docs/",
        "/docs/publication/",
        "/docs/retrieval/",
        "/docs/api/",
      ]) {
        assert.equal((await journey.goto(origin + "/"))?.status(), 200);
        await postsShell();
        const response = await documentClick("/docs/", () =>
          navigation().getByRole("link", { name: "Docs", exact: true }).click(),
        );
        const entryPolicy = response.headers()["content-security-policy"];
        assert.ok(entryPolicy?.includes("script-src 'none'"));
        const docsResponse = await journey.goto(origin + path);
        assert.ok(docsResponse);
        assert.equal(docsResponse.status(), 200);
        const policy = docsResponse.headers()["content-security-policy"];
        assert.ok(policy?.includes("script-src 'none'"));
        assert.ok(policy?.includes("default-src 'none'"));
        assert.doesNotMatch(policy ?? "", /connect-src(?! 'none')/);
        assert.ok(policy?.includes("form-action 'none'"));
        assert.equal(
          await journey
            .locator(
              "script, form, #forum-read-status, [data-forum-navigation]",
            )
            .count(),
          0,
        );
        assert.deepEqual(
          await navigation()
            .locator("a")
            .evaluateAll((links) =>
              links.map((link) => link.getAttribute("href")),
            ),
          ["/", "/authors", "/about", "/docs/"],
        );
        assert.equal(
          await navigation().locator('[aria-disabled="true"]').count(),
          0,
        );
        const posts = navigation().getByRole("link", {
          name: "Posts",
          exact: true,
        });
        assert.equal(await posts.getAttribute("href"), "/");
        assert.equal(await posts.getAttribute("data-forum-navigation"), null);
        if (path === "/docs/")
          await journey.screenshot({
            path: `${evidence}/docs-posts-link-${javaScriptEnabled ? "js" : "nojs"}.png`,
            fullPage: false,
          });
        await documentClick("/", () => posts.click());
        await postsShell();
      }
      assert.deepEqual(forbidden, []);
      console.log(
        `Native Posts→Docs→Posts PASS: all four Docs pages, JavaScript ${javaScriptEnabled ? "on" : "off"}, actual document requests200, script-free restrictive Docs CSP/native links, unchanged sole client/SRI/root status and local credential-free GET-only/no API or external reads.`,
      );
    } finally {
      await journeyContext.close();
    }
  }
} finally {
  await browser.close();
}

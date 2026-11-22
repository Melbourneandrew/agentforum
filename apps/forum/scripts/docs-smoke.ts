// Run against the actual production local Worker, never an external installation.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

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
} finally {
  await browser.close();
}

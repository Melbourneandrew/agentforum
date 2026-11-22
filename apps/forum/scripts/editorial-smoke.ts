// Test-only representative content. No fixture route is published by the Worker.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium } from "playwright";
import {
  EditorialShell,
  PageState,
  PaginationLinks,
  PublicationFacts,
  SectionHeading,
} from "../app/presentation/editorial";

const origin = process.env.EDITORIAL_ORIGIN ?? "http://127.0.0.1:8793";
const evidence = process.env.EDITORIAL_EVIDENCE ?? "/tmp/wo48-evidence";
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ javaScriptEnabled: false });
  context.setDefaultTimeout(15_000);
  const requests: string[] = [];
  context.on("request", (request) => requests.push(request.url()));
  const page = await context.newPage();
  const response = await page.goto(origin);
  assert.equal(response?.status(), 200);
  const css = await page
    .locator('link[rel="stylesheet"]')
    .first()
    .getAttribute("href");
  assert.ok(css);
  const policy = response.headers()["content-security-policy"] ?? "";
  let actualFontLoaded = false;
  for (const [name, width] of [
    ["desktop", 1280],
    ["mobile", 375],
    ["zoom-200", 640],
    ["reflow-400", 320],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(origin);
    await page.evaluate(() => document.fonts.ready);
    actualFontLoaded = await page.evaluate(() =>
      document.fonts.check('16px "Libre Franklin"'),
    );
    assert.equal(
      await page
        .getByRole("navigation", { name: "Main navigation" })
        .getByRole("link")
        .count(),
      1,
    );
    assert.equal(
      await page.getByRole("link", { name: "Runtime documentation" }).count(),
      1,
    );
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.screenshot({
      path: join(evidence, `app-${name}.png`),
      fullPage: true,
    });
  }
  await page.goto(origin);
  await page.keyboard.press("Tab");
  assert.equal(await page.locator(":focus").innerText(), "Skip to content");
  await page.keyboard.press("Enter");
  assert.equal(
    await page.locator(":focus").getAttribute("id"),
    "forum-content",
  );
  await page.keyboard.press("Tab");
  assert.equal(
    await page.locator(":focus").innerText(),
    "Runtime documentation",
  );
  console.log(
    "PASS actual SSR shell: desktop/mobile/zoom-equivalent reflow, keyboard skip and inert unavailable navigation",
  );

  const fixture = (search: boolean) =>
    renderToStaticMarkup(
      h(EditorialShell, {
        children: h(
          "main",
          null,
          h(
            "p",
            { className: "compact-intro" },
            "Representative component fixture — not live forum data.",
          ),
          h(SectionHeading, {
            children: "Latest posts",
            control: search
              ? h("input", { type: "search", "aria-label": "Search posts" })
              : h(
                  "button",
                  { className: "text-control", type: "button" },
                  "Search",
                ),
          }),
          h(
            "article",
            { className: "listing-row" },
            h(
              "h3",
              null,
              h("a", { href: "/fixture-post" }, "Representative post link"),
            ),
            h("p", null, "Selectable excerpt. ".repeat(12)),
          ),
          h(PublicationFacts, {
            facts: [
              { label: "Author", value: "fixture-agent" },
              { label: "Post", value: "long-exact-identifier-".repeat(12) },
              { label: "Order", value: "9007199254740993" },
            ],
          }),
          h(
            "div",
            { className: "post-content" },
            h("p", null, "unbroken".repeat(80)),
            h("p", null, h("em", null, "Italic font specimen")),
            h(
              "pre",
              { tabIndex: 0, "aria-label": "Code example" },
              h("code", null, "long_code_segment_".repeat(60)),
            ),
            h(
              "div",
              {
                className: "table-scroll",
                tabIndex: 0,
                role: "region",
                "aria-label": "Example table",
              },
              h(
                "table",
                null,
                h(
                  "tbody",
                  null,
                  h(
                    "tr",
                    null,
                    Array.from({ length: 40 }, (_, index) =>
                      h("td", { key: index }, "value"),
                    ),
                  ),
                ),
              ),
            ),
          ),
          h(PageState, { kind: "loading", children: "Loading posts…" }),
          h(PageState, { kind: "empty", children: "No posts match." }),
          h(PageState, {
            kind: "error",
            retryHref: "/?retry=fixture",
            children: "Posts could not be loaded.",
          }),
          h(PaginationLinks, { next: "/?cursor=fixture" }),
        ),
      }),
    );
  let searchVisible = false;
  await context.route(`${origin}/__test-only-editorial`, async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${css}"></head><body>${fixture(searchVisible)}</body></html>`,
    });
  });
  for (const width of [1280, 375, 320]) {
    await page.setViewportSize({ width, height: 900 });
    searchVisible = false;
    await page.goto(`${origin}/__test-only-editorial`);
    await page.evaluate(() => document.fonts.ready);
    const before = await page.locator(".listing-row").boundingBox();
    assert.ok(before);
    searchVisible = true;
    await page.reload();
    await page.evaluate(() => document.fonts.ready);
    const after = await page.locator(".listing-row").boundingBox();
    assert.ok(after);
    assert.equal(
      after.y,
      before.y,
      "Same-row search must not shift the listing",
    );
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    assert.ok(
      await page
        .locator("pre")
        .evaluate((element) => element.scrollWidth > element.clientWidth),
    );
    assert.ok(
      await page
        .locator(".table-scroll")
        .evaluate((element) => element.scrollWidth > element.clientWidth),
    );
    await page.getByRole("searchbox", { name: "Search posts" }).focus();
    assert.equal(
      await page
        .locator(":focus")
        .evaluate((element) => getComputedStyle(element).outlineStyle),
      "solid",
    );
    assert.equal(
      await page
        .getByRole("alert")
        .getByRole("link", { name: "Try again" })
        .count(),
      1,
    );
    assert.ok(
      await page.evaluate(() =>
        document.fonts.check('italic 16px "Libre Franklin"'),
      ),
    );
    await page.screenshot({
      path: join(evidence, `components-${String(width)}.png`),
      fullPage: true,
    });
    // Text-only 200% zoom, independent of viewport reflow.
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
    });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.screenshot({
      path: join(evidence, `text-zoom-${String(width)}.png`),
      fullPage: true,
    });
  }
  console.log(
    "PASS test-only components: search geometry, long facts/text, code/table overflow, states/retry, italic and 200% text zoom",
  );
  assert.ok(
    requests.every((url) => new URL(url).origin === origin),
    "No external/Google font requests",
  );
  for (const asset of [
    "libre-franklin-variable.ttf",
    "libre-franklin-variable-italic.ttf",
    "OFL.txt",
  ]) {
    assert.equal((await fetch(`${origin}/fonts/${asset}`)).status, 200);
  }
  console.log(`Evidence: ${evidence}`);
  assert.ok(
    actualFontLoaded,
    `Real-app Libre Franklin blocked. Parent CSP integration required; policy: ${policy}`,
  );
  console.log("PASS actual app local fonts without external requests");
  await context.close();
} finally {
  await browser.close();
}

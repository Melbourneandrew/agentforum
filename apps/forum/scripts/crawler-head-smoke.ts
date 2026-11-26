// Invoked by the parent-owned production harness after real central hooks are present.
// Never starts/provisions a provider installation and never substitutes a fixture server.
import assert from "node:assert/strict";
import { Schema } from "effect";
import type { Browser, Page } from "playwright";
import { PostResult, RegistrationResult } from "../src/api/contracts";
import {
  fixedPublicPaths,
  type PublicResource,
} from "../src/crawling/resources";
import { publicHead } from "../src/crawling/head";

const readHead = (page: Page) =>
  page.evaluate(() => ({
    title: document.title,
    description:
      document.head
        .querySelector('meta[name="description"]')
        ?.getAttribute("content") ?? null,
    canonical:
      document.head
        .querySelector('link[data-forum-head="canonical"]')
        ?.getAttribute("href") ?? null,
    representations: [
      ...document.head.querySelectorAll(
        'link[data-forum-head="representation"]',
      ),
    ].map((node) => ({
      href: node.getAttribute("href"),
      type: node.getAttribute("type"),
    })),
  }));
export async function productionCrawlerHeadSmoke(
  browser: Browser,
  origin: string,
) {
  assert.ok(
    ["127.0.0.1", "localhost", "[::1]"].includes(new URL(origin).hostname),
    "Private local production Worker only",
  );
  const seed = await browser.newContext({ ignoreHTTPSErrors: true });
  const ui = await browser.newContext({ ignoreHTTPSErrors: true });
  const native = await browser.newContext({
    ignoreHTTPSErrors: true,
    javaScriptEnabled: false,
  });
  try {
    const name = `Crawler${crypto.randomUUID().slice(0, 8)}`;
    const registration = await seed.request.post(origin + "/v1/register", {
      data: { name },
    });
    assert.equal(registration.status(), 201);
    const identity: unknown = await registration.json();
    assert.ok(Schema.is(RegistrationResult)(identity));
    const published = await seed.request.post(origin + "/v1/publish", {
      headers: { Authorization: `Bearer ${identity.apiKey}` },
      data: {
        body: "Local crawler smoke Post. Synthetic metadata-safety body.",
        tags: ["SyntheticTagNotForHead"],
      },
    });
    assert.equal(published.status(), 201);
    const post: unknown = await published.json();
    assert.ok(Schema.is(PostResult)(post));
    const page = await ui.newPage();
    const direct = await native.newPage();
    const requests: URL[] = [];
    ui.on("request", (request) => requests.push(new URL(request.url())));
    const destinations: readonly { path: string; resource: PublicResource }[] =
      [
        { path: "/", resource: { kind: "posts" } },
        {
          path: `/?author=${post.authorId}&tag=SyntheticTagNotForHead&order=oldest`,
          resource: { kind: "posts" },
        },
        { path: `/posts/${post.id}`, resource: { kind: "post", id: post.id } },
        { path: "/authors", resource: { kind: "authors" } },
        {
          path: `/authors/${identity.name.toLowerCase()}`,
          resource: { kind: "identity", name: identity.name },
        },
        { path: "/about", resource: { kind: "about" } },
      ];
    for (const destination of destinations) {
      assert.equal(
        (await direct.goto(origin + destination.path))?.status(),
        200,
      );
      assert.deepEqual(
        await readHead(direct),
        publicHead(origin, destination.resource),
      );
    }
    await page.goto(origin);
    for (const destination of destinations.slice(1)) {
      // A platform-owned navigation fixture within the actual Worker document; never Agent content.
      await page.evaluate((href) => {
        const link = document.createElement("a");
        link.textContent = "Crawler smoke destination";
        link.href = href;
        link.dataset.forumNavigation = "true";
        document.querySelector("main")?.append(link);
      }, destination.path);
      await page
        .getByRole("link", { name: "Crawler smoke destination", exact: true })
        .click();
      await page.waitForFunction(
        () =>
          document.querySelector("main")?.getAttribute("aria-busy") ===
            "false" && !document.querySelector('a[data-forum-retry="true"]'),
      );
      await direct.goto(origin + destination.path);
      assert.deepEqual(await readHead(page), await readHead(direct));
    }
    await page.goBack();
    await page.waitForFunction(
      () =>
        document.querySelector("main")?.getAttribute("aria-busy") === "false",
    );
    await direct.goto(page.url());
    assert.deepEqual(await readHead(page), await readHead(direct));
    assert.equal(
      requests.filter((url) => url.pathname.startsWith("/v1/")).length,
      0,
      "Enhanced observation issued no business request",
    );
    assert.equal(
      requests.filter((url) => /\.(?:md|xml)$/.test(url.pathname)).length,
      0,
      "No metadata-destination fetches",
    );
    const robots = await seed.request.get(origin + "/robots.txt");
    assert.equal(robots.status(), 200);
    const rules = await robots.text();
    assert.match(rules, /Disallow: \/v1\/register/);
    assert.match(rules, /Disallow: \/v1\/publish/);
    const indexes = Array.from(
      rules.matchAll(/^Sitemap: (.+)$/gm),
      (match) => match[1]?.trim() ?? "",
    );
    assert.ok(
      indexes.length > 0,
      "Standard complete sitemap discovery is required",
    );
    const found = new Set<string>();
    for (const indexUrl of indexes) {
      assert.equal(new URL(indexUrl).origin, origin);
      const response = await seed.request.get(indexUrl);
      assert.equal(response.status(), 200);
      const index = await response.text();
      assert.match(index, /<sitemapindex\b/);
      const pages = Array.from(
        index.matchAll(/<loc>([^<]+)<\/loc>/g),
        (match) => match[1] ?? "",
      );
      assert.ok(pages.length <= 50_000);
      assert.ok(Buffer.byteLength(index) <= 50 * 1024 * 1024);
      for (const pageUrl of pages) {
        assert.equal(new URL(pageUrl).origin, origin);
        const content = await seed.request.get(pageUrl);
        assert.equal(content.status(), 200);
        const xml = await content.text();
        assert.match(xml, /<urlset\b/); // no nested sitemap indexes
        assert.ok(Buffer.byteLength(xml) <= 50 * 1024 * 1024);
        const locations = Array.from(
          xml.matchAll(/<loc>([^<]+)<\/loc>/g),
          (match) => match[1] ?? "",
        );
        assert.ok(locations.length <= 50_000);
        for (const href of locations) {
          const url = new URL(href);
          assert.equal(url.origin, origin);
          assert.equal(url.search, "");
          assert.equal(url.hash, "");
          assert.ok(!/^\/v1\/(?:register|publish|search)$/.test(url.pathname));
          assert.ok(!found.has(href), "No duplicate preferred resource");
          found.add(href);
        }
      }
    }
    for (const path of [
      ...fixedPublicPaths,
      `/posts/${post.id}`,
      `/authors/${identity.name}`,
    ])
      assert.ok(found.has(origin + path), "Missing public resource");
    console.log(
      "PASS actual private production Worker/D1: owned direct/noJS versus enhanced/Back head, exact registered casing, no metadata/business fetches and standard sitemap inventory; not provider evidence.",
    );
  } finally {
    await ui.close();
    await native.close();
    await seed.close();
  }
}

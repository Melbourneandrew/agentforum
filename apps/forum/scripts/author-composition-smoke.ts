// Real registered production Worker/D1 journey across composed routes.
import assert from "node:assert/strict";
import { Schema } from "effect";
import type { Browser, Page } from "playwright";
import {
  AgentPageResult,
  PostPageResult,
  PostResult,
  RegistrationResult,
} from "../src/api/contracts.js";
import { readClient } from "../app/browsing/client-manifest";

export async function productionAuthorCompositionSmoke(
  browser: Browser,
  origin: string,
  fault: (() => Promise<() => Promise<void>>) | undefined,
  capture: (page: Page, name: string) => Promise<void>,
) {
  const seed = await browser.newContext({ ignoreHTTPSErrors: true });
  const ui = await browser.newContext({ ignoreHTTPSErrors: true });
  const native = await browser.newContext({
    ignoreHTTPSErrors: true,
    javaScriptEnabled: false,
  });
  const attempts: string[] = [];
  const errors: string[] = [];
  for (const context of [ui, native])
    context.on("request", (request) => {
      const url = new URL(request.url());
      if (
        url.origin !== origin ||
        url.pathname.startsWith("/v1") ||
        request.method() !== "GET" ||
        request.headers().authorization !== undefined ||
        request.headers().cookie !== undefined
      )
        attempts.push("Forbidden automatic observer request");
    });
  let release: (() => void) | undefined;
  try {
    const register = async (name: string) => {
      const response = await seed.request.post(origin + "/v1/register", {
        data: { name },
      });
      assert.equal(response.status(), 201);
      const value: unknown = await response.json();
      assert.ok(Schema.is(RegistrationResult)(value));
      return value;
    };
    const prefix = "authors-composed-" + crypto.randomUUID().slice(0, 8);
    const identity = await register(prefix);
    for (let index = 0; index < 11; index++)
      await register(prefix + "-" + String(index));
    const publication = await seed.request.post(origin + "/v1/publish", {
      headers: { Authorization: `Bearer ${identity.apiKey}` },
      data: {
        body: "wo28composed public publishing activity",
        tags: ["exact\0tag"],
      },
    });
    assert.equal(publication.status(), 201);
    const post: unknown = await publication.json();
    assert.ok(Schema.is(PostResult)(post));
    const snapshot = async () => {
      const postsResponse = await seed.request.get(origin + "/v1/search", {
        params: { payload: JSON.stringify({ limit: 100 }) },
      });
      const posts: unknown = await postsResponse.json();
      assert.ok(Schema.is(PostPageResult)(posts));
      assert.equal(posts.pageCursor, null, "Complete fixture Post snapshot");
      const agentsResponse = await seed.request.get(origin + "/v1/search", {
        params: { payload: JSON.stringify({ resource: "agents", limit: 100 }) },
      });
      const agents: unknown = await agentsResponse.json();
      assert.ok(Schema.is(AgentPageResult)(agents));
      assert.equal(
        agents.pageCursor,
        null,
        "Complete fixture publishing-activity snapshot",
      );
      return { posts, agents };
    };
    const before = await snapshot();
    const parent = before.posts.posts.find((value) =>
      value.body.startsWith("wo27composed full body"),
    );
    assert.ok(
      parent,
      "Verified Post dependency has seeded real parent/replies",
    );
    const postPath = `/posts/${parent.id}`;
    const page = await ui.newPage();
    page.on("pageerror", () => errors.push("Composed browser error"));
    await page.goto(origin + "/?q=wo27composed", { waitUntil: "networkidle" });
    const styleHrefs = await page
      .locator('link[rel="stylesheet"]')
      .evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("href")).sort(),
      );
    const shell = async (view: string) => {
      await page
        .locator(`main[data-forum-view="${view}"]:not([aria-busy="true"])`)
        .waitFor();
      assert.equal(
        await page.locator("#forum-content > #forum-read-status").count(),
        1,
      );
      assert.equal(await page.locator("main #forum-read-status").count(), 0);
      assert.equal(await page.locator("script").count(), 1);
      assert.equal(
        await page.locator("script").getAttribute("src"),
        readClient.path,
      );
      assert.equal(
        await page.locator("script").getAttribute("integrity"),
        readClient.integrity,
      );
      assert.deepEqual(
        await page
          .locator('link[rel="stylesheet"]')
          .evaluateAll((nodes) =>
            nodes.map((node) => node.getAttribute("href")).sort(),
          ),
        styleHrefs,
        "All views use already-loaded root CSS, never fetched resources",
      );
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
    };
    const readAfter = async (
      path: string,
      action: () => Promise<unknown>,
      status = 200,
    ) => {
      const [response] = await Promise.all([
        page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === path &&
            !response.request().isNavigationRequest(),
        ),
        action(),
      ]);
      assert.equal(response.status(), status);
      await page.locator('main[aria-busy="false"]').waitFor();
    };
    const header = (name: string) =>
      page
        .getByRole("navigation", { name: "Main navigation" })
        .getByRole("link", { name, exact: true });
    await readAfter(postPath, () =>
      page.locator(`tbody a[href="${postPath}"]`).click(),
    );
    await readAfter(postPath, () =>
      page.getByRole("link", { name: "Next replies", exact: true }).click(),
    );
    assert.equal(
      await page.locator('article[aria-label^="Reply "]').count(),
      2,
    );
    await readAfter(postPath, () =>
      page.getByRole("link", { name: "First replies", exact: true }).click(),
    );
    const replyLink = page
      .locator('article[aria-label^="Reply "] h3 a')
      .first();
    const replyPath = await replyLink.getAttribute("href");
    assert.ok(replyPath);
    await readAfter(replyPath, () => replyLink.click());
    await readAfter(postPath, () =>
      page
        .getByRole("link", { name: `Parent Post ${parent.id}`, exact: true })
        .click(),
    );
    assert.deepEqual(
      await page.locator(".post-markdown table").evaluate((node) => ({
        display: getComputedStyle(node).display,
        overflow: getComputedStyle(node).overflowX,
      })),
      { display: "block", overflow: "auto" },
    );
    const held = Promise.withResolvers<undefined>();
    release = () => {
      held.resolve(undefined);
    };
    let heldOnce = false;
    await page.route("**/*", async (route) => {
      const request = route.request();
      if (
        !heldOnce &&
        !request.isNavigationRequest() &&
        new URL(request.url()).pathname === "/authors"
      ) {
        heldOnce = true;
        const response = await route.fetch();
        assert.equal(response.status(), 200);
        await held.promise;
        await route.fulfill({ response });
      } else await route.continue();
    });
    const authorsRead = readAfter("/authors", async () => {
      await header("Authors").focus();
      await page.keyboard.press("Enter");
    });
    await page.locator('main[aria-busy="true"]').waitFor();
    assert.equal(
      await page.locator("#forum-read-status").innerText(),
      "Loading public page…",
    );
    assert.equal(
      await page.locator("#forum-read-status").getAttribute("hidden"),
      null,
    );
    await capture(page, "authors-composition-real-pending");
    release();
    await authorsRead;
    await shell("authors");
    assert.equal(
      await page.evaluate(() => document.activeElement?.textContent),
      "Authors",
    );
    assert.equal(
      await page.locator('section[aria-label="Local Authors"] article').count(),
      10,
    );
    const identityPath = `/authors/${identity.name}`;
    await readAfter(identityPath, () =>
      page.getByRole("link", { name: identity.name, exact: true }).click(),
    );
    assert.ok(
      (await page.locator("main").innerText()).includes(
        `Author ${identity.name}`,
      ),
    );
    assert.equal(
      await page
        .getByRole("link", {
          name: `Request Posts by ${identity.name} (JSON API)`,
          exact: true,
        })
        .getAttribute("data-forum-navigation"),
      null,
    );
    await readAfter("/authors", () =>
      page.getByRole("link", { name: "All Authors", exact: true }).click(),
    );
    await readAfter("/authors", () =>
      page.getByRole("link", { name: "Next Authors", exact: true }).click(),
    );
    await readAfter("/authors", () =>
      page.getByRole("link", { name: "First Authors", exact: true }).click(),
    );
    await readAfter("/about", () => header("About").click());
    await shell("about");
    assert.equal(
      await page.evaluate(() => document.activeElement?.textContent),
      "About",
    );
    assert.equal(await page.locator("main section.listing-row").count(), 8);
    await page.setViewportSize({ width: 320, height: 900 });
    await shell("about");
    await capture(page, "authors-composition-about-mobile");
    await readAfter("/authors", () => page.goBack());
    await shell("authors");
    await capture(page, "authors-composition-history-mobile");
    await readAfter(identityPath, () =>
      page.getByRole("link", { name: identity.name, exact: true }).click(),
    );
    await readAfter("/about", () => header("About").click());
    if (fault !== undefined) {
      const restore = await fault();
      try {
        await readAfter(identityPath, () => page.goBack(), 503);
        assert.ok(
          (await page.locator("main").innerText()).includes(
            "could not be loaded",
          ),
        );
        await readAfter("/about", () => header("About").click());
        await shell("about");
        await readAfter("/authors", () => header("Authors").click(), 503);
        assert.doesNotMatch(
          await page.locator("main").innerText(),
          /SQL|D1_ERROR|stack|no such table/,
        );
        await capture(page, "authors-composition-real-503");
      } finally {
        await restore();
      }
      await readAfter("/authors", () =>
        page.getByRole("link", { name: "Try again", exact: true }).click(),
      );
      await shell("authors");
      await capture(page, "authors-composition-real-retry");
    }
    await readAfter("/about", () => header("About").click());
    await readAfter("/authors", () =>
      page.getByRole("link", { name: "Browse Authors", exact: true }).click(),
    );
    await readAfter("/", () => header("Posts").click());
    await shell("posts");
    const nojs = await native.newPage();
    assert.equal((await nojs.goto(origin + "/authors"))?.status(), 200);
    await nojs.getByRole("link", { name: identity.name, exact: true }).click();
    assert.ok(
      (await nojs.locator("main").innerText()).includes(
        `Author ${identity.name}`,
      ),
    );
    await nojs
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("link", { name: "About", exact: true })
      .click();
    assert.equal(await nojs.locator("main section.listing-row").count(), 8);
    await capture(nojs, "authors-composition-nojs-about");
    const missing = await nojs.goto(origin + "/authors/NoSuchComposedIdentity");
    assert.equal(missing?.status(), 404);
    assert.ok(
      missing
        ?.headers()
        ["content-security-policy"]?.includes("script-src 'none'"),
    );
    const invalid = await native.request.get(origin + "/about?unowned=1");
    assert.equal(invalid.status(), 400);
    const policy = invalid.headers()["content-security-policy"];
    assert.ok(policy?.includes("script-src 'none'"));
    assert.deepEqual(
      await snapshot(),
      before,
      "All observer routes preserve real Post/identity/publishing activity",
    );
    assert.deepEqual(attempts, []);
    assert.deepEqual(errors, []);
    console.log(
      "Production Authors composition PASS: actual Posts→Post→Replies/Parent→Authors/identity/paging→About/Back/error503/retry→Posts, real pending/keyboard-owned focus/rootCSS/mobile, full SSR/noJS/final statuses, data-independent About during D1 fault, native explicit JSON/Docs/research links, unchanged native Post/identity activity, local credential-free GET-only/no automatic API/external/mutation reads and one client/SRI/status.",
    );
  } finally {
    release?.();
    await ui.close();
    await native.close();
    await seed.close();
  }
}

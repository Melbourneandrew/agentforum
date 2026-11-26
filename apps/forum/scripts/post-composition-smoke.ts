// Actual registered compiled HTTPS Worker/private D1, not a mocked page fixture.
import assert from "node:assert/strict";
import { Schema } from "effect";
import type { APIResponse, Browser, Page } from "playwright";
import {
  AgentPageResult,
  PostPageResult,
  PostResult,
  RegistrationResult,
} from "../src/api/contracts.js";
import { readClient } from "../app/browsing/client-manifest";
import { encodeTagControl } from "../app/browsing/tag-control";

export async function productionPostCompositionSmoke(
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
    const registration = await seed.request.post(origin + "/v1/register", {
      data: { name: "post-composition-" + crypto.randomUUID().slice(0, 8) },
    });
    assert.equal(registration.status(), 201);
    const identity: unknown = await registration.json();
    assert.ok(Schema.is(RegistrationResult)(identity));
    const publish = async (
      body: string,
      tags: readonly string[] = [],
      parent?: string,
    ) => {
      const response: APIResponse = await seed.request.post(
        origin + "/v1/publish",
        {
          headers: { Authorization: `Bearer ${identity.apiKey}` },
          data: {
            body,
            tags,
            ...(parent === undefined ? {} : { reply_to: parent }),
          },
        },
      );
      assert.equal(response.status(), 201);
      const value: unknown = await response.json();
      assert.ok(Schema.is(PostResult)(value));
      return value;
    };
    const tags = [
      "a\nb",
      "a\rb",
      "a\r\nb",
      "a\0b",
      "\\n",
      "\\u0000",
      "%0A",
      "\\unknown",
    ];
    const columns = Array.from(
      { length: 24 },
      (_, index) => `Column ${String(index)}`,
    );
    const table = `| ${columns.join(" | ")} |\n| ${columns.map(() => "---").join(" | ")} |\n| ${columns.map(() => "Exact cell").join(" | ")} |`;
    const parent = await publish(
      `wo27composed full body\n\n**Reading prose** and *italic*.\n\n${table}\n\n<script>window.__postExecuted=1</script><form data-forum-search="true"><input name="q"></form><header class="site-header"><a data-forum-navigation="true" href="/v1/register">fake</a></header>\n\n[mutation](/v1/publish?payload=x) [external](https://external.invalid/) ![image](https://external.invalid/image)`,
      tags,
    );
    const replies: string[] = [];
    for (let index = 0; index < 12; index++)
      replies.push(
        (
          await publish(
            `Direct composition reply ${String(index)}`,
            [],
            parent.id,
          )
        ).id,
      );
    const firstReply = replies[0];
    assert.ok(firstReply);
    const nested = await publish("Nested composition reply", [], firstReply);
    const fallback = await publish(
      "> ".repeat(100) + "<script>window.__postExecuted=2</script>",
    );
    const snapshot = async () => {
      const postResponse = await seed.request.get(origin + "/v1/search", {
        params: { payload: JSON.stringify({ limit: 100 }) },
      });
      const posts: unknown = await postResponse.json();
      assert.ok(Schema.is(PostPageResult)(posts));
      assert.equal(posts.pageCursor, null, "Complete fixture Post snapshot");
      const agentResponse = await seed.request.get(origin + "/v1/search", {
        params: { payload: JSON.stringify({ resource: "agents", limit: 100 }) },
      });
      const agents: unknown = await agentResponse.json();
      assert.ok(Schema.is(AgentPageResult)(agents));
      assert.equal(
        agents.pageCursor,
        null,
        "Complete fixture identity/activity snapshot",
      );
      return { posts, agents };
    };
    const before = await snapshot();
    const page = await ui.newPage();
    page.on("pageerror", () => errors.push("Post browser error"));
    await page.goto(origin + "/?q=wo27composed", { waitUntil: "networkidle" });
    const styles = await page
      .locator('link[rel="stylesheet"]')
      .evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("href")).sort(),
      );
    const postPath = `/posts/${parent.id}`;
    const assertPost = async () => {
      await page
        .locator('main[data-forum-view="post"]:not([aria-busy="true"])')
        .waitFor();
      assert.equal(
        await page.locator('article[aria-label^="Reply "]').count(),
        10,
      );
      assert.deepEqual(
        await page.locator(".post-tags li").allTextContents(),
        tags.map(encodeTagControl),
      );
      assert.ok(!(await page.locator("main").innerText()).includes(nested.id));
      assert.equal(await page.locator("[data-agent-content]").count(), 11);
      assert.equal(
        await page
          .locator(
            "[data-agent-content] form,[data-agent-content] [data-forum-navigation],[data-agent-content] [id^='forum-'],[data-agent-content] script",
          )
          .count(),
        0,
      );
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
        styles,
        "No fetched route CSS installed by a main-only swap",
      );
      assert.deepEqual(
        await page.locator(".post-markdown table").evaluate((node) => {
          const style = getComputedStyle(node);
          return { display: style.display, overflow: style.overflowX };
        }),
        { display: "block", overflow: "auto" },
        "Actual Post CSS is already root-owned",
      );
      assert.ok(
        await page
          .locator(".direct-replies")
          .evaluate(
            (node) => Number.parseFloat(getComputedStyle(node).marginTop) > 0,
          ),
      );
      assert.equal(
        await page
          .locator("#forum-read-status")
          .evaluate((node) => getComputedStyle(node).position),
        "sticky",
      );
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      assert.ok(!(await page.evaluate(() => "__postExecuted" in window)));
    };
    const readAfter = async (action: () => Promise<unknown>, status = 200) => {
      const [response] = await Promise.all([
        page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname.startsWith("/posts/") &&
            !response.request().isNavigationRequest(),
        ),
        action(),
      ]);
      assert.equal(response.status(), status);
      await page.locator('main[aria-busy="false"]').waitFor();
    };
    const held = Promise.withResolvers<undefined>();
    let heldOnce = false;
    release = () => {
      held.resolve(undefined);
    };
    await page.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (
        !heldOnce &&
        !request.isNavigationRequest() &&
        url.pathname === postPath &&
        url.search === ""
      ) {
        heldOnce = true;
        const response = await route.fetch();
        assert.equal(response.status(), 200);
        await held.promise;
        await route.fulfill({ response });
      } else await route.continue();
    });
    const firstRead = readAfter(() =>
      page.locator(`tbody a[href="${postPath}"]`).click(),
    );
    await page.locator('main[aria-busy="true"]').waitFor();
    assert.equal(
      await page.locator("#forum-read-status").innerText(),
      "Loading public page…",
    );
    assert.equal(
      await page.locator("#forum-read-status").getAttribute("hidden"),
      null,
    );
    await capture(page, "post-composition-real-pending");
    release();
    await firstRead;
    await assertPost();
    assert.equal(
      await page.evaluate(() => document.activeElement?.tagName),
      "H1",
    );
    assert.equal(
      await page.evaluate(() => document.activeElement?.textContent),
      "Post",
    );
    await page.setViewportSize({ width: 320, height: 900 });
    await assertPost();
    await capture(page, "post-composition-mobile-root-css");
    await readAfter(() =>
      page.getByRole("link", { name: "Next replies", exact: true }).click(),
    );
    assert.equal(
      await page.locator('article[aria-label^="Reply "]').count(),
      2,
    );
    await readAfter(() =>
      page.getByRole("link", { name: "First replies", exact: true }).click(),
    );
    await assertPost();
    const reply = replies.at(-1);
    assert.ok(reply);
    await readAfter(() =>
      page.getByRole("link", { name: `Reply ${reply}`, exact: true }).click(),
    );
    await readAfter(() =>
      page
        .getByRole("link", { name: `Parent Post ${parent.id}`, exact: true })
        .click(),
    );
    await assertPost();
    await readAfter(() => page.goBack());
    assert.equal(new URL(page.url()).pathname, `/posts/${reply}`);
    await readAfter(() => page.goForward());
    await assertPost();
    if (fault !== undefined) {
      const restore = await fault();
      try {
        await readAfter(
          () =>
            page
              .getByRole("link", { name: "Next replies", exact: true })
              .click(),
          503,
        );
        await page
          .getByRole("heading", {
            name: "Post could not be loaded",
            exact: true,
          })
          .waitFor();
        assert.doesNotMatch(
          await page.locator("main").innerText(),
          /SQL|D1_ERROR|stack|no such table/,
        );
        await capture(page, "post-composition-real-503");
      } finally {
        await restore();
      }
      await readAfter(() =>
        page.getByRole("link", { name: "Try again", exact: true }).click(),
      );
      await assertPost();
      await capture(page, "post-composition-real-retry");
    }
    const nojs = await native.newPage();
    assert.equal((await nojs.goto(origin + postPath))?.status(), 200);
    assert.deepEqual(
      await nojs.locator(".post-tags li").allTextContents(),
      tags.map(encodeTagControl),
    );
    await nojs.getByRole("link", { name: "Next replies", exact: true }).click();
    assert.equal(
      await nojs.locator('article[aria-label^="Reply "]').count(),
      2,
    );
    await nojs
      .getByRole("link", { name: "First replies", exact: true })
      .click();
    assert.equal(
      await nojs.locator('article[aria-label^="Reply "]').count(),
      10,
    );
    assert.equal(
      (await nojs.goto(origin + `/posts/${fallback.id}`))?.status(),
      200,
    );
    assert.ok(
      (await nojs.locator("main").innerText()).includes(
        "Markdown can't be rendered",
      ),
    );
    assert.equal(
      await nojs.locator("[data-agent-content] pre").innerText(),
      fallback.body,
    );
    assert.equal(
      (await nojs.goto(origin + "/posts/" + "M".repeat(21)))?.status(),
      404,
    );
    assert.ok(
      (await nojs.locator("main").innerText()).includes("Post not found"),
    );
    const invalid = await native.request.get(
      origin + postPath + "?replyCursor=bad",
    );
    assert.equal(invalid.status(), 400);
    const invalidPolicy = invalid.headers()["content-security-policy"];
    assert.ok(invalidPolicy?.includes("script-src 'none'"));
    assert.deepEqual(
      await snapshot(),
      before,
      "Observer reads preserve actual Post and identity/publishing state",
    );
    assert.deepEqual(attempts, []);
    assert.deepEqual(errors, []);
    console.log(
      "Production Post composition PASS: full SSR/noJS/final statuses, actual enhanced pending/replies/parent/Back/Forward/503/retry, root-owned computed Post CSS after main swaps, mobile/focus, inert Agent wrappers/raw fallback/lossless Tags, unchanged native Post/identity activity and local GET-only/no API/external/mutation automatic reads.",
    );
  } finally {
    release?.();
    await ui.close();
    await native.close();
    await seed.close();
  }
}

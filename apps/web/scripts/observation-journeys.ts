import assert from "node:assert/strict";
import { SearchResult } from "@agentforum/contracts";
import { Option, Schema } from "effect";
import type { Browser } from "playwright";
import type { startObservationFixture } from "./observation-fixture.js";

export const verifyObservationJourneys = async (
  browser: Browser,
  base: string,
  fixture: Awaited<ReturnType<typeof startObservationFixture>>,
) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    await context.addCookies([
      { name: "observer-fixture", value: "must-not-forward", url: base },
    ]);
    const page = await context.newPage();
    const errors: string[] = [],
      unexpected: string[] = [];
    const continuationRequests: URL[] = [];
    page.on("pageerror", (error) => {
      errors.push(error.message);
    });
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (
        request.method() !== "GET" ||
        url.origin !== base ||
        /\/v1\/(publish|register)/.test(url.pathname)
      )
        unexpected.push(request.url());
      if (request.isNavigationRequest() && url.searchParams.has("scan"))
        continuationRequests.push(url);
    });
    const release = fixture.hold();
    try {
      const response = await fetch(base, { signal: AbortSignal.timeout(5000) });
      const reader = response.body?.getReader();
      if (reader === undefined) throw new Error("Native response missing body");
      try {
        const chunk = await reader.read();
        const html = new TextDecoder().decode(chunk.value);
        assert.match(html, /Loading forum content/);
        assert.doesNotMatch(html, /forum-result/);
        assert.equal(response.headers.get("Content-Encoding"), "identity");
      } finally {
        await reader.cancel();
      }
      await page.goto(base, { waitUntil: "commit" });
      await page
        .getByRole("heading", { name: "Loading forum content…", exact: true })
        .waitFor();
      assert.equal(await page.getByRole("table").count(), 0);
    } finally {
      release();
    }
    await page
      .getByRole("heading", { name: "No Posts to display", exact: true })
      .waitFor();
    assert.equal(
      await page.getByRole("link", { name: /Next page/ }).count(),
      0,
    );
    assert.equal(
      await page.getByRole("link", { name: /Previous page/ }).count(),
      0,
    );
    assert.deepEqual(await fixture.allPosts(), []);
    const records = await fixture.seed();
    const baseline = await fixture.allPosts();
    assert.equal(baseline.length, 400);
    const firstResponse = await fixture.search({ limit: 20 });
    assert.equal(firstResponse.status, 200);
    const firstResult = Schema.decodeUnknownSync(SearchResult)(
      await firstResponse.json(),
    );
    const pageCursor = Option.getOrThrow(firstResult.page_cursor);
    const tampered =
      pageCursor.slice(0, 10) +
      (pageCursor[10] === "A" ? "B" : "A") +
      pageCursor.slice(11);
    for (const payload of [
      { cursor: firstResult.read_cursor },
      { read_cursor: pageCursor },
      { cursor: pageCursor, reply_to: records.parent.id },
      { cursor: tampered },
    ]) {
      assert.equal(
        (await fixture.search(payload)).status,
        400,
        "Actual API accepted a wrong-purpose/query/tampered cursor",
      );
    }
    for (const payload of [
      { cursor: firstResult.read_cursor },
      { cursor: pageCursor, reply_to: records.parent.id },
      { cursor: tampered },
    ]) {
      const parameters = new URLSearchParams({
        ...payload,
        anchor: pageCursor,
        scan: pageCursor,
      });
      await page.goto(base + "/?" + parameters.toString());
      await page
        .getByRole("heading", {
          name: "Forum content could not be loaded",
          exact: true,
        })
        .waitFor();
      assert.equal(
        await page.locator('meta[http-equiv="refresh"]').count(),
        0,
        "Invalid cursor continued replay",
      );
    }
    for (const query of [
      "unknown=value",
      "cursor=a&cursor=b&anchor=a",
      "scan=a",
      "anchor=a",
      "post_id=" + records.parent.id + "&reply_to=" + records.parent.id,
    ]) {
      const before = fixture.searchCount();
      await page.goto(base + "/?" + query);
      await page
        .getByRole("heading", {
          name: "Forum content could not be loaded",
          exact: true,
        })
        .waitFor();
      assert.equal(
        fixture.searchCount(),
        before,
        "Invalid UI query acquired API I/O",
      );
    }
    const pages: string[][] = [],
      urls: string[] = [];
    const ids = () =>
      page
        .locator("tbody tr a")
        .evaluateAll((links) =>
          links.map((link) => link.getAttribute("href") ?? ""),
        );
    await page.goto(base);
    await page.getByRole("table").waitFor();
    for (let index = 0; index < 20; index++) {
      await page.getByRole("table").waitFor();
      pages.push(await ids());
      urls.push(page.url());
      assert.equal(pages[index]?.length, 20);
      if (index < 19)
        await page
          .getByRole("link", { name: "Next page →", exact: true })
          .click();
    }
    assert.deepEqual(
      pages.flat(),
      baseline.map((post) => "/posts/" + post.id),
    );
    assert.equal(new Set(pages.flat()).size, 400);
    const concurrent = await fixture.concurrentPost();
    const afterPublication = await fixture.allPosts();
    assert.equal(afterPublication.length, 401);
    for (let index = 18; index >= 16; index--) {
      const expected = pages[index];
      assert.ok(expected !== undefined);
      const first = expected[0];
      assert.ok(first !== undefined);
      const target = new URL(page.url());
      const continuationStart = continuationRequests.length;
      await page
        .getByRole("link", { name: "Previous page", exact: true })
        .click();
      await page
        .locator('tbody tr:first-child a[href="' + first + '"]')
        .waitFor({ timeout: 60000 });
      assert.deepEqual(await ids(), expected);
      assert.equal(new URL(page.url()).searchParams.has("scan"), false);
      const replay = continuationRequests.slice(continuationStart);
      assert.equal(
        replay.length,
        index >= 17 ? 2 : 1,
        "Previous did not use the exact bounded continuation count",
      );
      assert.equal(
        new Set(replay.map((url) => url.searchParams.get("scan"))).size,
        replay.length,
        "Replay did not advance its scan",
      );
      for (const url of replay) {
        assert.equal(
          url.searchParams.get("cursor"),
          target.searchParams.get("cursor"),
        );
        assert.equal(
          url.searchParams.get("anchor"),
          target.searchParams.get("anchor"),
        );
      }
      await page.reload();
      await page.getByRole("table").waitFor();
      assert.deepEqual(await ids(), expected);
    }
    const second = urls[1];
    assert.ok(second !== undefined);
    await page.goto(second);
    await page.getByRole("table").waitFor();
    await page
      .getByRole("link", { name: "Previous page", exact: true })
      .click();
    await page.waitForURL(base + "/");
    await page.getByRole("table").waitFor();
    assert.equal((await ids())[0], "/posts/" + concurrent.id);
    const releaseDetail = fixture.hold();
    try {
      await page.goto(base + "/posts/" + records.parent.id, {
        waitUntil: "commit",
      });
      await page
        .getByRole("heading", { name: "Loading forum content…", exact: true })
        .waitFor();
      assert.equal(await page.locator("article").count(), 0);
    } finally {
      releaseDetail();
    }
    await page
      .getByRole("heading", { name: "Actual parent", exact: true })
      .first()
      .waitFor();
    await page.goto(base + "/posts/" + records.fallback.id);
    await page
      .getByRole("status")
      .filter({ hasText: "Markdown can't be rendered" })
      .waitFor();
    await page.getByText("Raw Markdown", { exact: true }).click();
    assert.match(
      await page.locator(".raw-markdown").innerText(),
      /Actual deep Markdown/,
    );
    await page.goto(base + "/posts/" + records.reply.id);
    await page
      .getByRole("link", { name: "View parent Post", exact: true })
      .click();
    assert.equal(new URL(page.url()).pathname, "/posts/" + records.parent.id);
    await page
      .getByRole("link", {
        name: "Browse Posts replying to this Post",
        exact: true,
      })
      .click();
    await page.getByRole("table").waitFor();
    assert.equal(await page.locator("tbody tr").count(), 1);
    await page.goto(base + "/posts/" + records.hostile.id);
    await page.getByText("Structured metadata (JSON)", { exact: true }).click();
    await page.getByText("Raw Markdown", { exact: true }).click();
    assert.match(await page.locator("article").innerText(), /<iframe/);
    assert.match(
      await page.locator("article").innerText(),
      /window.__untrustedExecuted=true/,
    );
    assert.equal(
      await page
        .locator("script,iframe,form,img,input,textarea,button")
        .count(),
      0,
    );
    const inert = page.locator(".untrusted-destination").first();
    await inert.hover();
    await inert.click();
    assert.equal(new URL(page.url()).pathname, "/posts/" + records.hostile.id);
    await page.goto(base + "/posts/_____________________");
    await page
      .getByRole("heading", { name: "Post not found", exact: true })
      .waitFor();
    await page.goto(base + "/?cursor=invalid");
    await page
      .getByRole("heading", {
        name: "Forum content could not be loaded",
        exact: true,
      })
      .waitFor();
    assert.equal(
      await page
        .getByRole("link", { name: "Retry this page", exact: true })
        .getAttribute("href"),
      "/?cursor=invalid",
    );
    fixture.fail();
    await page.goto(base);
    await page
      .getByRole("heading", {
        name: "Forum content could not be loaded",
        exact: true,
      })
      .waitFor();
    fixture.recover();
    await page
      .getByRole("link", { name: "Retry this page", exact: true })
      .click();
    await page.getByRole("table").waitFor();
    fixture.redirect();
    await page.goto(base);
    await page
      .getByRole("heading", {
        name: "Forum content could not be loaded",
        exact: true,
      })
      .waitFor();
    fixture.recover();
    await page
      .getByRole("link", { name: "Retry this page", exact: true })
      .click();
    await page.getByRole("table").waitFor();
    assert.deepEqual(
      await fixture.allPosts(),
      afterPublication,
      "Observation changed actual forum state",
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
    fixture.assertBoundary();
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const path of ["/", "/posts/" + records.hostile.id]) {
        await page.goto(base + path);
        if (path.startsWith("/posts/")) {
          await page.getByText("Raw Markdown", { exact: true }).click();
          await page
            .getByText("Structured metadata (JSON)", { exact: true })
            .click();
        } else await page.getByRole("table").waitFor();
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
          true,
          "Observer overflow at " + String(width),
        );
      }
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
    fixture.assertBoundary();
  } finally {
    fixture.recover();
    await context.close();
  }
};

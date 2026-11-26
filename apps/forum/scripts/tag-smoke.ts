// Regression on the genuine compiled HTTPS Worker and disposable native D1.
import assert from "node:assert/strict";
import { Schema } from "effect";
import type { APIResponse, Browser, Page } from "playwright";
import { PostResult, RegistrationResult } from "../src/api/contracts.js";
import { encodeTagControl } from "../app/browsing/tag-control";

export async function productionTagSmoke(
  browser: Browser,
  origin: string,
  fault: (() => Promise<() => Promise<void>>) | undefined,
  capture: (page: Page, name: string) => Promise<void>,
) {
  const tags = [
    "a\nb",
    "a\rb",
    "a\r\nb",
    "a\0b",
    "\\n\\r\\0",
    "mixed\\\n\\r\0end",
    "%0A",
    "\\u0000",
    "\\unknown",
  ];
  const seed = await browser.newContext({ ignoreHTTPSErrors: true });
  const native = await browser.newContext({
    ignoreHTTPSErrors: true,
    javaScriptEnabled: false,
  });
  const ui = await browser.newContext({ ignoreHTTPSErrors: true });
  const ids: string[] = [];
  const attempts: string[] = [];
  const redirects: string[] = [];
  const errors: string[] = [];
  for (const context of [native, ui]) {
    context.on("request", (request) => {
      const url = new URL(request.url());
      if (
        url.origin !== origin ||
        url.pathname.startsWith("/v1") ||
        request.method() !== "GET"
      )
        attempts.push("Forbidden observer request");
    });
  }
  native.on("response", (response) => {
    if (response.status() === 303) redirects.push(response.url());
  });
  const href = (tag: string) =>
    origin +
    "/?" +
    new URLSearchParams({ q: "wo26losslesstag", tag }).toString();
  const check = async (page: Page, tag: string, oldest = false, count = 10) => {
    await page.locator('main:not([aria-busy="true"])').waitFor();
    const url = new URL(page.url());
    assert.deepEqual(
      url.searchParams.getAll("tag"),
      [tag],
      "Raw backend tag survives the URL",
    );
    assert.equal(
      url.searchParams.has("tagText"),
      false,
      "Form notation never becomes a public URL alias",
    );
    assert.equal(
      await page.getByLabel("Tag 1", { exact: true }).inputValue(),
      encodeTagControl(tag),
    );
    const found = await page
      .locator("tbody tr > td:first-child > code")
      .allTextContents();
    assert.deepEqual(
      found,
      (oldest ? ids : [...ids].reverse()).slice(0, count),
      "Actual matched Post identities, not sanitized-tag decoys",
    );
  };
  const readAfter = async (page: Page, action: () => Promise<unknown>) => {
    const [response] = await Promise.all([
      page.waitForResponse(
        (value) =>
          new URL(value.url()).pathname === "/" &&
          !value.request().isNavigationRequest(),
      ),
      action(),
    ]);
    assert.equal(response.status(), 200);
    await page.locator('main[aria-busy="false"]').waitFor();
  };
  try {
    const registration = await seed.request.post(origin + "/v1/register", {
      data: { name: "tag-roundtrip-" + crypto.randomUUID().slice(0, 8) },
    });
    assert.equal(registration.status(), 201);
    const identity: unknown = await registration.json();
    assert.ok(Schema.is(RegistrationResult)(identity));
    for (let index = 0; index < 14; index++) {
      const response: APIResponse = await seed.request.post(
        origin + "/v1/publish",
        {
          headers: { Authorization: `Bearer ${identity.apiKey}` },
          data: {
            body: `wo26losslesstag orchard ${String(index)}`,
            tags: index < 12 ? tags : ["ab", "a�b"],
          },
        },
      );
      assert.equal(response.status(), 201);
      const post: unknown = await response.json();
      assert.ok(Schema.is(PostResult)(post));
      if (index < 12) ids.push(post.id);
    }
    const nojs = await native.newPage();
    const enhanced = await ui.newPage();
    enhanced.on("pageerror", () => errors.push("Browser script error"));
    for (const [index, tag] of tags.entries()) {
      assert.equal(
        (await nojs.goto(href(tag), { waitUntil: "networkidle" }))?.status(),
        200,
      );
      // No enhancer is present: SSR input and browser-native FormData are authoritative.
      assert.equal(
        await nojs.getByLabel("Tag 1", { exact: true }).inputValue(),
        encodeTagControl(tag),
      );
      assert.deepEqual(
        await nojs
          .locator("tbody tr > td:first-child > code")
          .allTextContents(),
        [...ids].reverse().slice(0, 10),
      );
      await nojs.getByText("Filters and ordering", { exact: true }).click();
      await nojs.getByLabel("Ordering").selectOption("oldest");
      await nojs
        .getByRole("searchbox", { name: "Search" })
        .fill("wo26losslesstag orchard");
      const document = nojs.waitForResponse(
        (response) =>
          response.request().isNavigationRequest() &&
          new URL(response.url()).pathname === "/" &&
          !new URL(response.url()).searchParams.has("tagText"),
      );
      await nojs.getByRole("searchbox", { name: "Search" }).press("Enter");
      assert.equal((await document).status(), 200);
      // No JS means no aria-busy attribute; check native facts directly.
      assert.deepEqual(new URL(nojs.url()).searchParams.getAll("tag"), [tag]);
      assert.equal(new URL(nojs.url()).searchParams.has("tagText"), false);
      assert.equal(
        await nojs.getByLabel("Tag 1", { exact: true }).inputValue(),
        encodeTagControl(tag),
      );
      assert.deepEqual(
        await nojs
          .locator("tbody tr > td:first-child > code")
          .allTextContents(),
        ids.slice(0, 10),
      );
      await nojs.getByRole("link", { name: "Next", exact: true }).click();
      assert.deepEqual(new URL(nojs.url()).searchParams.getAll("tag"), [tag]);
      assert.equal(await nojs.locator("tbody tr").count(), 2);
      await nojs.getByText("Filters and ordering", { exact: true }).click();
      await nojs.getByLabel("Ordering").selectOption("newest");
      await nojs
        .getByLabel("Tag 1", { exact: true })
        .fill(encodeTagControl(tag));
      const reset = nojs.waitForResponse(
        (response) =>
          response.request().isNavigationRequest() &&
          response.status() === 200 &&
          new URL(response.url()).pathname === "/",
      );
      await nojs.getByLabel("Tag 1", { exact: true }).press("Enter");
      await reset;
      assert.equal(new URL(nojs.url()).searchParams.has("pageCursor"), false);
      assert.equal(new URL(nojs.url()).searchParams.has("previous"), false);
      assert.deepEqual(new URL(nojs.url()).searchParams.getAll("tag"), [tag]);
      assert.deepEqual(
        await nojs
          .locator("tbody tr > td:first-child > code")
          .allTextContents(),
        [...ids].reverse().slice(0, 10),
      );
      await nojs.goBack();
      assert.deepEqual(new URL(nojs.url()).searchParams.getAll("tag"), [tag]);
      assert.equal(new URL(nojs.url()).searchParams.has("pageCursor"), true);
      assert.equal(await nojs.locator("tbody tr").count(), 2);
      await nojs.goForward();
      assert.deepEqual(new URL(nojs.url()).searchParams.getAll("tag"), [tag]);
      assert.equal(new URL(nojs.url()).searchParams.has("pageCursor"), false);
      if (tag === "a\0b") await capture(nojs, "lossless-tags-native-nul");

      assert.equal(
        (
          await enhanced.goto(href(tag), { waitUntil: "networkidle" })
        )?.status(),
        200,
      );
      await check(enhanced, tag);
      await enhanced.getByText("Filters and ordering", { exact: true }).click();
      await readAfter(enhanced, () =>
        enhanced.getByLabel("Ordering").selectOption("oldest"),
      );
      await check(enhanced, tag, true);
      await readAfter(enhanced, () =>
        enhanced
          .getByRole("searchbox", { name: "Search" })
          .fill("wo26losslesstag orchard"),
      );
      await check(enhanced, tag, true);
      const edited = tags[(index + 1) % tags.length];
      assert.ok(edited !== undefined);
      await readAfter(enhanced, () =>
        enhanced
          .getByLabel("Tag 1", { exact: true })
          .fill(encodeTagControl(edited)),
      );
      await check(enhanced, edited, true);
      await readAfter(enhanced, () => enhanced.goBack());
      await check(enhanced, tag, true);
      await readAfter(enhanced, () =>
        enhanced.getByRole("link", { name: "Next", exact: true }).click(),
      );
      assert.equal(await enhanced.locator("tbody tr").count(), 2);
      assert.deepEqual(new URL(enhanced.url()).searchParams.getAll("tag"), [
        tag,
      ]);
      await enhanced.getByText("Filters and ordering", { exact: true }).click();
      await readAfter(enhanced, () =>
        enhanced.getByLabel("Ordering").selectOption("newest"),
      );
      await check(enhanced, tag);
      assert.equal(
        new URL(enhanced.url()).searchParams.has("pageCursor"),
        false,
      );
      assert.equal(new URL(enhanced.url()).searchParams.has("previous"), false);
      await readAfter(enhanced, () =>
        enhanced.getByRole("link", { name: "Next", exact: true }).click(),
      );
      assert.equal(await enhanced.locator("tbody tr").count(), 2);
      await readAfter(enhanced, () =>
        enhanced
          .getByRole("searchbox", { name: "Search" })
          .fill("wo26losslesstag"),
      );
      await check(enhanced, tag);
      assert.equal(
        new URL(enhanced.url()).searchParams.has("pageCursor"),
        false,
      );
      assert.equal(new URL(enhanced.url()).searchParams.has("previous"), false);
      if (tag === "a\0b") await capture(enhanced, "lossless-tags-enhanced-nul");
    }
    assert.equal(
      redirects.length,
      tags.length * 2,
      "Each native form validates then redirects exactly once to raw public tags",
    );
    for (const query of [
      "tag=a&tagText=b",
      "tagText=a&unknown=x",
      "tagText=a&order=oldest&order=newest",
      "tagText=%FF",
      "tagText=a&pageCursor=x",
    ]) {
      const response = await native.request.get(origin + "/?" + query, {
        maxRedirects: 0,
      });
      assert.equal(response.status(), 400, "Reject native form: " + query);
      assert.equal(response.headers().location, undefined);
    }
    if (fault !== undefined) {
      const tag = "a\0b";
      await enhanced.goto(href(tag), { waitUntil: "networkidle" });
      await enhanced.getByText("Filters and ordering", { exact: true }).click();
      const restore = await fault();
      try {
        const unavailable = enhanced.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === "/" &&
            !response.request().isNavigationRequest(),
        );
        await enhanced.getByLabel("Ordering").selectOption("oldest");
        assert.equal((await unavailable).status(), 503);
        await enhanced
          .getByRole("heading", { name: "Posts could not be loaded" })
          .waitFor();
        assert.deepEqual(new URL(enhanced.url()).searchParams.getAll("tag"), [
          tag,
        ]);
        assert.equal(
          await enhanced.getByLabel("Tag 1", { exact: true }).inputValue(),
          encodeTagControl(tag),
        );
        // The accepted finite public cache may serve a previously visited URL.
        // Use a fresh, equivalent FTS selection to exercise the actual D1 fault.
        const nativeFault = new URL(href(tag));
        nativeFault.searchParams.set("q", 'wo26losslesstag "orchard"');
        assert.equal((await nojs.goto(nativeFault.href))?.status(), 503);
        assert.equal(
          await nojs.getByLabel("Tag 1", { exact: true }).inputValue(),
          encodeTagControl(tag),
        );
        assert.deepEqual(
          new URL(
            (await nojs
              .getByRole("link", { name: "Try again", exact: true })
              .getAttribute("href")) ?? "",
            origin,
          ).searchParams.getAll("tag"),
          [tag],
        );
      } finally {
        await restore();
      }
      await readAfter(enhanced, () =>
        enhanced.getByRole("link", { name: "Try again", exact: true }).click(),
      );
      await check(enhanced, tag, true);
      await nojs.getByRole("link", { name: "Try again", exact: true }).click();
      assert.deepEqual(new URL(nojs.url()).searchParams.getAll("tag"), [tag]);
      assert.deepEqual(
        await nojs
          .locator("tbody tr > td:first-child > code")
          .allTextContents(),
        [...ids].reverse().slice(0, 10),
      );
    }
    assert.deepEqual(attempts, []);
    assert.deepEqual(errors, []);
    console.log(
      "Production lossless Tags PASS: actual HTTPS Worker/private D1 CR/LF/CRLF/NUL, mixed backslash/escapes/literal encoded-looking tags; complete SSR/no-JS native Enter and canonical303, enhanced edits/order/query, cursor resets/Back/history, actual503/retry, exact matched Post identities and no observer API/external/mutating requests; raw tag URL/backend contracts and strict unknown/mixed fields preserved.",
    );
  } finally {
    await ui.close();
    await native.close();
    await seed.close();
  }
}

// Actual compiled local Worker/private D1 only; called while bundle-smoke owns it.
import assert from "node:assert/strict";
import { Schema } from "effect";
import type { APIResponse, Browser } from "playwright";
import { RegistrationResult, PostResult } from "../src/api/contracts.js";
import { readClient } from "../app/browsing/client-manifest";

export async function productionBrowseSmoke(browser: Browser, origin: string) {
  assert.ok(
    ["127.0.0.1", "localhost", "[::1]"].includes(new URL(origin).hostname),
  );
  const seed = await browser.newContext({ ignoreHTTPSErrors: true });
  const ui = await browser.newContext({ ignoreHTTPSErrors: true });
  const native = await browser.newContext({
    javaScriptEnabled: false,
    ignoreHTTPSErrors: true,
  });
  let release: (() => void) | undefined;
  try {
    const registered = await seed.request.post(origin + "/v1/register", {
      data: { name: `browse-${crypto.randomUUID().slice(0, 8)}` },
    });
    assert.equal(registered.status(), 201);
    const identity: unknown = await registered.json();
    assert.ok(
      Schema.is(RegistrationResult)(identity),
      "Native registration shape",
    );
    for (let index = 0; index < 14; index++) {
      const published: APIResponse = await seed.request.post(
        origin + "/v1/publish",
        {
          headers: { Authorization: `Bearer ${identity.apiKey}` },
          data: {
            body: `wo26orchard ${String(index)}\n\nNative green pear. <script>fetch('/v1/register')</script> [mutation](/v1/register)`,
            tags: [" Exact /Tag "],
          },
        },
      );
      assert.equal(published.status(), 201);
      const value: unknown = await published.json();
      assert.ok(Schema.is(PostResult)(value), "Native publication shape");
    }
    const requests: {
      readonly url: URL;
      readonly cookie: boolean;
      readonly auth: boolean;
    }[] = [];
    ui.on("request", (request) =>
      requests.push({
        url: new URL(request.url()),
        cookie: request.headers().cookie !== undefined,
        auth: request.headers().authorization !== undefined,
      }),
    );
    await ui.addCookies([
      { name: "synthetic-browse-cookie", value: "test-only", url: origin },
    ]);
    const page = await ui.newPage();
    const errors: string[] = [];
    page.on("pageerror", () => errors.push("Browser script error"));
    const first = await page.goto(origin, { waitUntil: "networkidle" });
    assert.equal(first?.status(), 200);
    assert.ok(first);
    const policy = first.headers()["content-security-policy"] ?? "";
    assert.ok(policy.includes(`script-src '${readClient.integrity}'`));
    assert.equal(await page.locator("script").count(), 1);
    assert.equal(
      await page.locator("script").getAttribute("integrity"),
      readClient.integrity,
    );
    assert.equal(
      await page.locator("script").getAttribute("src"),
      readClient.path,
    );
    assert.equal(
      requests.filter((value) => value.url.pathname === "/").length,
      1,
      "No mount re-fetch",
    );
    assert.equal(await page.locator("form").getAttribute("action"), "/");
    assert.equal(
      await page.getByRole("button", { name: "Apply filters" }).count(),
      0,
    );
    const search = page.getByRole("searchbox", { name: "Search" });
    let held = false;
    const gate = Promise.withResolvers<undefined>();
    release = () => {
      gate.resolve(undefined);
    };
    await page.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (
        !held &&
        !request.isNavigationRequest() &&
        url.pathname === "/" &&
        url.searchParams.get("q") === "wo26orchard"
      ) {
        held = true;
        assert.equal(request.headers().cookie, undefined);
        assert.equal(request.headers().authorization, undefined);
        // Delay transfer of a GENUINE native Worker response, never fabricate data/status.
        const response = await route.fetch();
        assert.equal(response.status(), 200);
        await gate.promise;
        await route.fulfill({ response });
      } else await route.continue();
    });
    const searchBefore = await search.boundingBox();
    assert.ok(searchBefore);
    const reading = page.waitForRequest(
      (request) =>
        new URL(request.url()).searchParams.get("q") === "wo26orchard",
    );
    await search.fill("wo");
    await search.fill("wo26");
    await search.fill("wo26orchard");
    await reading;
    await page.locator('main[aria-busy="true"]').waitFor();
    const searchPending = await search.boundingBox();
    assert.ok(searchPending);
    assert.equal(
      searchPending.y,
      searchBefore.y,
      "Search stays in place during real read",
    );
    assert.equal(
      await page.locator("#forum-read-status").innerText(),
      "Loading public page…",
    );
    assert.equal(
      requests.filter((value) =>
        ["wo", "wo26"].includes(value.url.searchParams.get("q") ?? ""),
      ).length,
      0,
    );
    gate.resolve(undefined);
    await page.waitForFunction(
      () =>
        document.querySelector("main")?.getAttribute("aria-busy") === "false",
    );
    assert.equal(await page.locator("tbody tr").count(), 10);
    assert.equal(
      await search.evaluate((node) => document.activeElement === node),
      true,
    );
    assert.equal(
      await search.evaluate((node) =>
        node instanceof HTMLInputElement ? node.selectionStart : null,
      ),
      11,
    );
    await page.getByRole("link", { name: "Next", exact: true }).click();
    await page.waitForFunction(
      () =>
        document.querySelector("main")?.getAttribute("aria-busy") === "false",
    );
    assert.equal(await page.locator("tbody tr").count(), 4);
    assert.ok(new URL(page.url()).searchParams.has("pageCursor"));
    await page.getByRole("link", { name: "Previous", exact: true }).click();
    await page.waitForFunction(
      () =>
        document.querySelector("main")?.getAttribute("aria-busy") === "false",
    );
    assert.equal(await page.locator("tbody tr").count(), 10);
    await search.fill("wo26absent");
    await page
      .getByText("No Posts match these filters and Text Query.", {
        exact: true,
      })
      .waitFor();
    assert.equal(new URL(page.url()).searchParams.has("pageCursor"), false);
    assert.equal(new URL(page.url()).searchParams.has("previous"), false);
    const invalid = page.waitForResponse(
      (response) =>
        new URL(response.url()).searchParams.get("q") === '"unterminated',
    );
    await search.fill('"unterminated');
    assert.equal((await invalid).status(), 400);
    await page.getByRole("heading", { name: "Invalid Posts query" }).waitFor();
    await search.fill("wo26orchard");
    await page.locator("tbody tr").first().waitFor();
    await page.getByText("Filters and ordering", { exact: true }).click();
    await page.getByLabel("Tag 1", { exact: true }).fill(" Exact /Tag ");
    await page.waitForRequest(
      (request) =>
        new URL(request.url()).searchParams.get("tag") === " Exact /Tag ",
    );
    await page.waitForFunction(
      () =>
        document.querySelector("main")?.getAttribute("aria-busy") === "false",
    );
    assert.equal(await page.getByLabel("Tag 2", { exact: true }).count(), 1);
    assert.equal(await page.locator("tbody tr").count(), 10);
    assert.equal(
      await page
        .locator("main script, main iframe, main img, [onclick]")
        .count(),
      0,
    );
    assert.equal(
      requests.filter((value) => value.url.pathname.startsWith("/v1")).length,
      0,
      "Observer UI never calls a business operation",
    );
    assert.ok(requests.every((value) => value.url.origin === origin));
    assert.deepEqual(errors, []);
    const nojs = await native.newPage();
    await nojs.goto(origin);
    await nojs.getByRole("searchbox", { name: "Search" }).fill("wo26orchard");
    await Promise.all([
      nojs.waitForURL("**/?q=wo26orchard&**"),
      nojs.getByRole("searchbox", { name: "Search" }).press("Enter"),
    ]);
    assert.equal(await nojs.locator("tbody tr").count(), 10);
    const bad = await native.request.get(origin + "/?q=%22unterminated");
    assert.equal(bad.status(), 400);
    assert.ok(
      bad.headers()["content-security-policy"]?.includes("script-src 'none'"),
    );
    assert.match(await bad.text(), /Invalid Posts query/);
    console.log(
      "Production browse PASS: actual HTTPS Worker/private native D1, hash-only external script, no mount read/API/Agent execution, real debounce/held actual response loading, native cursor Next/Previous/reset, focus/caret, exact Tags, real400/empty distinction and complete no-JS Enter/status.",
    );
  } finally {
    release?.();
    await ui.close();
    await native.close();
    await seed.close();
  }
}

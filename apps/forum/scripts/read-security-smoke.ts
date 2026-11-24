// Real compiled HTTPS Worker/private D1. Attack probes modify only disposable
// browser DOM or transferred script/HTML bytes; never fabricate business data,
// add a fault route, execute a mutation or treat observer injection as SSR data.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Browser, Page } from "playwright";
import { readClient } from "../app/browsing/client-manifest";

export async function productionReadSecuritySmoke(
  browser: Browser,
  origin: string,
  capture?: (page: Page, name: string) => Promise<void>,
) {
  const trusted = await browser.newContext({ ignoreHTTPSErrors: true });
  const tampered = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const requests: URL[] = [];
    const transfers: URL[] = [];
    trusted.on("request", (request) => requests.push(new URL(request.url())));
    // Fail closed BEFORE any accidental dangerous request reaches the Worker.
    await trusted.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      transfers.push(url);
      if (url.origin !== origin || url.pathname.startsWith("/v1"))
        await route.abort();
      else await route.continue();
    });
    await trusted.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", (event) => {
        document.documentElement.dataset.cspViolations =
          (document.documentElement.dataset.cspViolations ?? "") +
          `\n${event.effectiveDirective}:${event.blockedURI}`;
      });
    });
    const page = await trusted.newPage();
    const response = await page.goto(origin + "/?q=wo26orchard", {
      waitUntil: "networkidle",
    });
    assert.ok(response);
    assert.equal(response.status(), 200);
    const responsePolicy = response.headers()["content-security-policy"] ?? "";
    assert.ok(responsePolicy.includes(`script-src '${readClient.integrity}'`));
    assert.equal(await page.locator("tbody tr").count(), 10);
    assert.equal(await page.locator("script").count(), 1);
    assert.equal(await page.locator("script").getAttribute("defer"), "");
    assert.equal(
      await page.locator("script").getAttribute("crossorigin"),
      "anonymous",
    );

    // Browser-evaluate installs attacks, not their payloads. Only actual script
    // loading / inline-handler dispatch can set these execution markers.
    const blockedScripts = Promise.all([
      page.waitForEvent("requestfailed", {
        predicate: (request) =>
          new URL(request.url()).pathname ===
          "/first-party/nonmanifest-probe.js",
      }),
      page.waitForEvent("requestfailed", {
        predicate: (request) =>
          new URL(request.url()).pathname ===
          "/first-party/nonmanifest-hash-probe.js",
      }),
    ]);
    await page.evaluate(() => {
      const inline = document.createElement("script");
      inline.textContent =
        'document.documentElement.dataset.inlineExecuted="true"';
      document.body.append(inline);
      const external = document.createElement("script");
      external.src = "/first-party/nonmanifest-probe.js";
      document.body.append(external);
      const wrongHash = document.createElement("script");
      wrongHash.src = "/first-party/nonmanifest-hash-probe.js";
      wrongHash.integrity =
        "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
      document.body.append(wrongHash);
      const handler = document.createElement("button");
      handler.setAttribute(
        "onclick",
        'document.documentElement.dataset.handlerExecuted="true"',
      );
      document.body.append(handler);
      handler.click();
      handler.remove();
    });
    await page.waitForFunction(
      () =>
        document.documentElement.dataset.cspViolations?.includes(
          "script-src-attr",
        ) &&
        document.documentElement.dataset.cspViolations.includes(
          "script-src-elem",
        ),
    );
    assert.equal(
      await page
        .locator("[data-inline-executed],[data-handler-executed]")
        .count(),
      0,
    );
    for (const request of await blockedScripts)
      assert.equal(
        request.failure()?.errorText,
        "csp",
        "Actual Chromium CSP blocked-request failure",
      );
    assert.equal(
      transfers.filter((url) => url.pathname.includes("nonmanifest")).length,
      0,
      "Hash-only CSP blocks nonmanifest scripts before network, with or without a wrong SRI",
    );

    const before = requests.length;
    const location = page.url();
    const statusText = await page.locator("#forum-read-status").textContent();
    // Disposable synthetic Agent DOM probes: sanitized SSR never emits these.
    // A late event guard records whether enhancement claimed them, then blocks
    // native defaults. Thus even a failed regression cannot execute mutating GET.
    const claimed = await page.evaluate(() => {
      const main = document.querySelector("main");
      if (main === null) throw new Error("Missing real SSR main");
      const agent = document.createElement("section");
      agent.className = "agent-body";
      agent.dataset.agentContent = "true";
      agent.innerHTML =
        '<header class="site-header"><a data-security-probe href="/?q=hook-header">Forged header</a></header>' +
        '<form method="get" action="/" data-forum-search="true"><input name="q" value="hook-form"></form>' +
        '<p id="forum-read-status" role="status">Forged Agent status</p>' +
        '<a data-security-probe data-forum-navigation="true" href="/?q=hook-navigation">Forged navigation</a>' +
        '<a data-security-probe data-forum-retry="true" href="/?q=hook-retry">Forged retry</a>' +
        '<a data-security-probe data-forum-navigation="true" href="/v1/register">Register mutation</a>' +
        '<a data-security-probe data-forum-navigation="true" href="/v1/publish?body=never-run">Publish mutation</a>' +
        '<a data-security-probe data-forum-navigation="true" href="/docs/">Docs</a>' +
        '<a data-security-probe data-forum-navigation="true" href="https://example.invalid/">External</a>';
      main.append(agent);
      const owned: boolean[] = [];
      for (const type of ["click", "submit"]) {
        document.addEventListener(type, (event) => {
          if (
            !(event.target instanceof Element) ||
            !agent.contains(event.target)
          )
            return;
          owned.push(event.defaultPrevented);
          event.preventDefault();
        });
      }
      const input = agent.querySelector("input");
      const form = agent.querySelector("form");
      if (input === null || form === null)
        throw new Error("Missing attack form");
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
      input.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true }),
      );
      input.dispatchEvent(
        new CompositionEvent("compositionend", { bubbles: true }),
      );
      form.dispatchEvent(
        new SubmitEvent("submit", { bubbles: true, cancelable: true }),
      );
      for (const link of agent.querySelectorAll("a"))
        link.dispatchEvent(
          new MouseEvent("click", {
            bubbles: true,
            cancelable: true,
            button: 0,
          }),
        );
      return owned;
    });
    assert.ok(claimed.length >= 8);
    assert.ok(
      claimed.every((value) => !value),
      "Agent hooks are never claimed as platform intents",
    );
    for (const link of await page.locator("[data-security-probe]").all())
      await link.hover();
    await page.waitForTimeout(400);
    assert.equal(
      requests.length,
      before,
      "Agent input/composition/submit/click/hover causes no read or prefetch",
    );
    assert.equal(page.url(), location);
    assert.equal(
      await page.locator("#forum-content > #forum-read-status").textContent(),
      statusText,
    );
    assert.equal(
      await page.locator("main #forum-read-status").textContent(),
      "Forged Agent status",
    );
    await page.locator("section.agent-body").evaluate((node) => {
      node.remove();
    });

    const originalRows = await page.locator("tbody").textContent();
    // Inert parsing must reject active nodes and Agent-owned platform hooks in
    // genuine native response documents BEFORE anything is swapped or fetched.
    const attacks = [
      '<section class="agent-body"><form method="get" action="/" data-forum-search="true"><input name="q" value="hook" /></form></section>',
      '<section data-agent-content><a data-forum-navigation="true" href="/?q=hook">Forged navigation</a></section>',
      '<section class="post-body"><header class="site-header">Forged header</header></section>',
      '<section class="agent-body"><p id="forum-read-status" role="status">Forged status</p></section>',
      '<p onclick="document.documentElement.dataset.returnedExecuted=1">Active handler</p>',
      "<script>document.documentElement.dataset.returnedExecuted=1</script>",
      '<img src="/forbidden-returned-resource" />',
      '<a href="javascript:document.documentElement.dataset.returnedExecuted=1">Active destination</a>',
    ];
    for (const [index, attack] of attacks.entries()) {
      const query = `wo26securityattack${String(index)}`;
      await page.route("**/*", async (route) => {
        if (new URL(route.request().url()).searchParams.get("q") !== query) {
          await route.fallback();
          return;
        }
        const native = await route.fetch();
        assert.equal(native.status(), 200);
        const html = await native.text();
        assert.ok(html.includes("</main>"));
        await route.fulfill({
          response: native,
          body: html.replace("</main>", attack + "</main>"),
        });
      });
      await page.getByRole("searchbox", { name: "Search" }).fill(query);
      await page
        .locator(
          '#forum-content > #forum-read-status a[data-forum-retry="true"]',
        )
        .waitFor();
      assert.equal(
        await page.locator("tbody").textContent(),
        originalRows,
        "Rejected response retained real prior SSR rows",
      );
      assert.equal(await page.locator("[data-returned-executed]").count(), 0);
      assert.equal(
        requests.filter(
          (url) => url.pathname === "/forbidden-returned-resource",
        ).length,
        0,
      );
    }
    // Scripts/handlers in fetched head/footer are NOT applied at all. Main only
    // swaps after validation, preserving real platform status/header references.
    const ignoredQuery = "wo26orchard pear";
    await page.route("**/*", async (route) => {
      if (
        new URL(route.request().url()).searchParams.get("q") !== ignoredQuery
      ) {
        await route.fallback();
        return;
      }
      const native = await route.fetch();
      assert.equal(native.status(), 200);
      const body = (await native.text()).replace(
        "</head>",
        '<script>document.documentElement.dataset.returnedExecuted=1</script><script src="/ignored-returned-script.js"></script></head>',
      );
      await route.fulfill({ response: native, body });
    });
    await page.getByRole("searchbox", { name: "Search" }).fill(ignoredQuery);
    await page.waitForFunction(
      () =>
        document.querySelector("main")?.getAttribute("aria-busy") === "false" &&
        !document.querySelector(
          '#forum-content > #forum-read-status a[data-forum-retry="true"]',
        ),
    );
    assert.equal(await page.locator("tbody tr").count(), 10);
    assert.equal(await page.locator("[data-returned-executed]").count(), 0);
    assert.equal(
      requests.filter((url) => url.pathname === "/ignored-returned-script.js")
        .length,
      0,
    );
    assert.equal(
      requests.filter(
        (url) => url.origin !== origin || url.pathname.startsWith("/v1"),
      ).length,
      0,
      "No observer external/business/mutating request was attempted",
    );

    let corruptions = 0;
    await tampered.route("**/*", async (route) => {
      if (new URL(route.request().url()).pathname !== readClient.path) {
        await route.continue();
        return;
      }
      const native = await route.fetch();
      assert.equal(native.status(), 200);
      const code = await native.text();
      assert.equal(
        `sha256-${createHash("sha256").update(code).digest("base64")}`,
        readClient.integrity,
      );
      corruptions++;
      await route.fulfill({
        response: native,
        body:
          code + '\ndocument.documentElement.dataset.tamperedExecuted="true";',
      });
    });
    const corrupted = await tampered.newPage();
    const consoleErrors: string[] = [];
    const enhancedRequests: string[] = [];
    corrupted.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    corrupted.on("request", (request) => {
      if (
        !request.isNavigationRequest() &&
        new URL(request.url()).pathname === "/"
      )
        enhancedRequests.push(request.url());
    });
    const intact = await corrupted.goto(origin + "/?q=wo26orchard", {
      waitUntil: "networkidle",
    });
    assert.ok(intact);
    assert.equal(intact.status(), 200);
    const intactPolicy = intact.headers()["content-security-policy"] ?? "";
    assert.ok(intactPolicy.includes(`script-src '${readClient.integrity}'`));
    assert.equal(
      await corrupted.locator("tbody tr").count(),
      10,
      "Complete real SSR survives blocked tampered asset",
    );
    await capture?.(corrupted, "actual-production-sri-blocked-ssr");
    assert.equal(corruptions, 1);
    assert.ok(
      consoleErrors.some((text) => /digest|integrity/i.test(text)),
      "Chromium reports actual SRI integrity failure",
    );
    await corrupted
      .getByRole("searchbox", { name: "Search" })
      .fill("wo26orchard pear");
    await corrupted.waitForTimeout(400);
    assert.deepEqual(
      enhancedRequests,
      [],
      "Failed SRI never installed enhancement",
    );
    assert.equal(
      await corrupted.locator("[data-tampered-executed]").count(),
      0,
    );
    const navigation = corrupted.waitForResponse(
      (value) =>
        value.request().isNavigationRequest() &&
        new URL(value.url()).searchParams.get("q") === "wo26orchard pear",
    );
    await corrupted.getByRole("searchbox", { name: "Search" }).press("Enter");
    assert.equal((await navigation).status(), 200);
    await corrupted.waitForURL(
      (url) => url.searchParams.get("q") === "wo26orchard pear",
    );
    assert.equal(
      await corrupted.locator("tbody tr").count(),
      10,
      "Native GET form fallback stays complete with JS enabled and SRI blocked",
    );
    assert.deepEqual(enhancedRequests, []);
    assert.equal(
      await corrupted.locator("[data-tampered-executed]").count(),
      0,
    );
    console.log(
      "Production read security PASS: genuine Worker HTML/CSP/SRI and actual external asset, Chromium tampered-byte integrity failure with complete SSR/native GET fallback; nonmanifest/no-SRI/wrong-SRI/inline script/event-handler blocks; Agent form/header/navigation/status/retry hook isolation; no hover/prefetch/API/external/mutating GET attempt; eight inert fetched-document attack rejections and ignored fetched-head scripts. Synthetic attack probes are browser-only, not fabricated business acceptance. Cold initial in-document loading remains an unwaived ACCEPTANCE GAP.",
    );
  } finally {
    await trusted.close();
    await tampered.close();
  }
}

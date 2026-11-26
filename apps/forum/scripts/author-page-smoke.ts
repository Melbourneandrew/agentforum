// Local-only production verification. No fixture or fault endpoint is installed.
import assert from "node:assert/strict";
import { readClient } from "../app/browsing/client-manifest";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, request as httpsRequest } from "node:https";
import { setTimeout } from "node:timers/promises";
import { chromium } from "playwright";
import { Schema } from "effect";
import {
  RegistrationResult,
  PostResult,
  AgentPageResult,
  PostPageResult,
} from "../src/api/contracts.js";

const evidence = process.env.AUTHOR_PAGE_EVIDENCE ?? "/tmp/wo28-evidence";
await mkdir(evidence, { recursive: true });
const state = await mkdtemp(join(tmpdir(), "agent-forum-author-pages-"));
const origin = "https://127.0.0.1:8795";
const environment = {
  ...process.env,
  CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
  WRANGLER_SEND_METRICS: "false",
};
const controller = new AbortController();
let server: ReturnType<typeof spawn> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let agent: Agent | undefined;
const interrupt = () => {
  controller.abort();
  process.exitCode = 1;
  void browser?.close().catch(() => undefined);
};
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
const command = (...args: string[]) =>
  execFileSync("pnpm", ["exec", "wrangler", ...args], {
    env: environment,
    timeout: 30_000,
    stdio: "pipe",
  });
const badShape = (): never => {
  throw new Error("Production test response failed shared schema validation");
};
const decode = <A, I>(schema: Schema.Schema<A, I>, response: Response) =>
  response.json().then(Schema.decodeUnknownPromise(schema)).catch(badShape);
try {
  const key = join(state, "localhost.key");
  const certificate = join(state, "localhost.crt");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      certificate,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=IP:127.0.0.1,DNS:localhost",
    ],
    { stdio: "ignore" },
  );
  agent = new Agent({ ca: await readFile(certificate) });
  command(
    "d1",
    "migrations",
    "apply",
    "DB",
    "--local",
    "--config",
    "../../wrangler.jsonc",
    "--persist-to",
    state,
  );
  server = spawn(
    "pnpm",
    [
      "exec",
      "wrangler",
      "dev",
      "--config",
      "dist/server/wrangler.json",
      "--local",
      "--no-bundle",
      "--persist-to",
      state,
      "--inspector-port",
      "0",
      "--ip",
      "127.0.0.1",
      "--port",
      "8795",
      "--local-protocol",
      "https",
      "--local-upstream",
      "127.0.0.1:8795",
      "--upstream-protocol",
      "https",
      "--https-key-path",
      key,
      "--https-cert-path",
      certificate,
      "--var",
      `CANONICAL_ORIGIN:${origin}`,
    ],
    { env: environment, detached: true, stdio: "ignore" },
  );
  let ready = false;
  for (let index = 0; index < 150; index++) {
    controller.signal.throwIfAborted();
    if (server.exitCode !== null)
      throw new Error("Production Authors Worker exited before readiness");
    try {
      if ((await get("/")).status === 200) {
        ready = true;
        break;
      }
    } catch {
      /* startup only */
    }
    await setTimeout(100);
  }
  assert.ok(ready, "Production Authors Worker did not become ready");
  const publicSearch = async (selection: unknown) => {
    const response = await get(
      "/v1/search?payload=" + encodeURIComponent(JSON.stringify(selection)),
    );
    assert.equal(response.status, 200);
    return response;
  };
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    javaScriptEnabled: false,
    ignoreHTTPSErrors: true,
  });
  context.setDefaultTimeout(15_000);
  const requests: {
    readonly url: string;
    readonly method: string;
    readonly credential: boolean;
  }[] = [];
  context.on("request", (request) =>
    requests.push({
      url: request.url(),
      method: request.method(),
      credential:
        request.headers().authorization !== undefined ||
        request.headers().cookie !== undefined,
    }),
  );
  const page = await context.newPage();
  const empty = await page.goto(origin + "/authors");
  assert.equal(empty?.status(), 200);
  assert.ok(
    (await page.locator("main").innerText()).includes(
      "No Authors on this directory page.",
    ),
  );
  await page.screenshot({
    path: join(evidence, "authors-empty.png"),
    fullPage: true,
  });
  const identities: (typeof RegistrationResult.Type)[] = [];
  const longName = "Long" + "A".repeat(35);
  for (let index = 0; index < 12; index++) {
    const response = await get("/v1/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: index === 11 ? longName : `PublicAuthor${String(index)}`,
      }),
    });
    assert.equal(response.status, 201);
    identities.push(await decode(RegistrationResult, response));
  }
  const first = identities[0];
  const second = identities[1];
  const quiet = identities[3];
  assert.ok(first && second && quiet);
  const published: (typeof PostResult.Type)[] = [];
  for (const identity of [first, second]) {
    const response = await get("/v1/publish", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${identity.apiKey}`,
      },
      body: JSON.stringify({
        body: "Publication content stays in Post Retrieval, not identity pages.",
        tags: ["NotADirectoryField"],
      }),
    });
    assert.equal(response.status, 201);
    published.push(await decode(PostResult, response));
  }
  const beforeAgents = await decode(
    AgentPageResult,
    await publicSearch({ resource: "agents", limit: 100 }),
  );
  const beforePosts = await decode(
    PostPageResult,
    await publicSearch({ resource: "posts", limit: 100 }),
  );
  assert.equal(beforeAgents.agents.length, 12);
  assert.equal(beforePosts.posts.length, 2);
  assert.ok(
    beforeAgents.agents
      .slice(0, 2)
      .every((agent) => agent.latestPublishingTime !== null),
  );
  assert.ok(
    beforeAgents.agents
      .slice(2)
      .every((agent) => agent.latestPublishingTime === null),
  );
  for (const path of ["/authors", `/authors/${first.name}`, "/about"]) {
    const response = await get(path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "no-store, private");
    const policy = response.headers.get("Content-Security-Policy") ?? "";
    assert.ok(policy.includes(`script-src '${readClient.integrity}'`));
    assert.ok(policy.includes("script-src-attr 'none'"));
    assert.ok(policy.includes("connect-src 'self'"));
    assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval|script-src 'self'/);
    assert.equal(response.headers.has("Access-Control-Allow-Origin"), false);
    const html = await response.text();
    for (const identity of identities)
      assert.ok(!html.includes(identity.apiKey));
    assert.doesNotMatch(
      html,
      /<(form|img|iframe)\b|<script(?![^>]+src="\/first-party\/read\.)|<link[^>]+(?:prefetch|preload)|href="\/v1\/(?:register|publish)|href="\/posts\/|href="\/\?author=/i,
    );
    assert.equal((await get(path, { method: "HEAD" })).status, 200);
    assert.equal(await (await get(path, { method: "HEAD" })).text(), "");
    assert.equal((await get(path, { method: "OPTIONS" })).status, 204);
    assert.equal((await get(path, { method: "POST" })).status, 405);
  }
  const localFonts = async (italic: boolean) => {
    await page.waitForLoadState("load");
    await page.evaluate(() => document.fonts.ready);
    assert.ok(
      await page.evaluate(
        (includeItalic) =>
          (includeItalic ? ["normal", "italic"] : ["normal"]).every((style) =>
            Array.from(document.fonts).some(
              (face) =>
                face.family.includes("Libre Franklin") &&
                face.style === style &&
                face.status === "loaded",
            ),
          ) &&
          getComputedStyle(document.body).fontFamily.includes("Libre Franklin"),
        italic,
      ),
    );
  };
  for (const [name, width] of [
    ["desktop", 1280],
    ["mobile", 375],
    ["reflow-200", 640],
    ["reflow-400", 320],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal((await page.goto(origin + "/authors"))?.status(), 200);
    await localFonts(true);
    const names = await page
      .locator('section[aria-label="Local Authors"] h2 a')
      .allTextContents();
    assert.deepEqual(
      names,
      beforeAgents.agents.slice(0, 10).map((agent) => agent.name),
    );
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    assert.equal(await page.locator("form,img,iframe").count(), 0);
    assert.equal(await page.locator("script").count(), 1);
    assert.equal(
      await page.locator("script").getAttribute("src"),
      readClient.path,
    );
    assert.equal(
      await page.locator("script").getAttribute("integrity"),
      readClient.integrity,
    );
    assert.equal(
      await page
        .getByRole("navigation", { name: "Main navigation" })
        .getByRole("link", { name: "Posts", exact: true })
        .getAttribute("href"),
      "/",
    );
    await page.screenshot({
      path: join(evidence, `authors-${name}.png`),
      fullPage: true,
    });
  }
  await page.goto(origin + "/authors");
  await page.keyboard.press("Tab");
  assert.equal(await page.locator(":focus").innerText(), "Skip to content");
  assert.ok(
    await page
      .locator(":focus")
      .evaluate((element) => getComputedStyle(element).outlineStyle !== "none"),
  );
  await page.screenshot({ path: join(evidence, "authors-keyboard-focus.png") });
  await page.keyboard.press("Enter");
  assert.equal(
    await page.locator(":focus").getAttribute("id"),
    "forum-content",
  );
  await page.getByRole("link", { name: "Next Authors", exact: true }).click();
  assert.deepEqual(
    await page
      .locator('section[aria-label="Local Authors"] h2 a')
      .allTextContents(),
    beforeAgents.agents.slice(10).map((agent) => agent.name),
  );
  assert.ok(new URL(page.url()).searchParams.has("pageCursor"));
  await page.screenshot({
    path: join(evidence, "authors-next.png"),
    fullPage: true,
  });
  await page.getByRole("link", { name: "First Authors", exact: true }).click();
  assert.equal(new URL(page.url()).search, "");
  await page.getByRole("link", { name: first.name, exact: true }).click();
  assert.equal(
    await page.getByRole("heading", { level: 1 }).innerText(),
    `Author ${first.name}`,
  );
  assert.ok(
    (await page.locator("main").innerText()).includes(
      published[0]?.publishedAt ?? "missing",
    ),
  );
  await localFonts(false);
  await page.screenshot({
    path: join(evidence, "author-publishing.png"),
    fullPage: true,
  });
  const link = page.getByRole("link", {
    name: `Request Posts by ${first.name} (JSON API)`,
    exact: true,
  });
  const href = await link.getAttribute("href");
  assert.ok(href);
  assert.equal(new URL(href, origin).origin, origin);
  assert.equal(new URL(href, origin).pathname, "/v1/search");
  assert.deepEqual(
    JSON.parse(new URL(href, origin).searchParams.get("payload") ?? "null"),
    { resource: "posts", author: first.id },
  );
  const [apiResponse] = await Promise.all([
    page.waitForResponse((response) => response.url() === origin + href),
    link.click(),
  ]);
  assert.equal(apiResponse.status(), 200);
  const apiPosts = await Schema.decodeUnknownPromise(PostPageResult)(
    await apiResponse.json(),
  ).catch(badShape);
  assert.equal(apiPosts.posts.length, 1);
  assert.equal(apiPosts.posts[0]?.authorId, first.id);
  await page.goBack();
  await page.getByRole("link", { name: "All Authors", exact: true }).click();
  assert.equal(new URL(page.url()).pathname, "/authors");
  await page.goto(`${origin}/authors/${quiet.name.toLowerCase()}`);
  assert.equal(
    await page.getByRole("heading", { level: 1 }).innerText(),
    `Author ${quiet.name}`,
  );
  assert.ok(
    (await page.locator("main").innerText()).includes("No publishing activity"),
  );
  await page.screenshot({
    path: join(evidence, "author-no-activity.png"),
    fullPage: true,
  });
  const quietLink = await page
    .getByRole("link", {
      name: `Request Posts by ${quiet.name} (JSON API)`,
      exact: true,
    })
    .getAttribute("href");
  assert.ok(quietLink);
  assert.equal(
    (await decode(PostPageResult, await get(quietLink))).posts.length,
    0,
  );
  await page.goto(`${origin}/authors/${longName}`);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  assert.equal(
    await page.evaluate(
      () => getComputedStyle(document.documentElement).fontSize,
    ),
    "32px",
  );
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  assert.equal(
    await page.getByRole("heading", { level: 1 }).innerText(),
    `Author ${longName}`,
  );
  await page.screenshot({
    path: join(evidence, "author-text-zoom.png"),
    fullPage: true,
  });
  const missing = await page.goto(origin + "/authors/NoSuchLocalAuthor");
  assert.equal(missing?.status(), 404);
  assert.ok(
    (await page.locator("main").innerText()).includes("Author not found"),
  );
  await page.screenshot({
    path: join(evidence, "author-not-found.png"),
    fullPage: true,
  });
  for (const path of [
    "/authors?pageCursor=bad",
    "/authors?pageCursor=x&pageCursor=y",
    "/authors?profile=private",
    `/authors/${first.name}?pageCursor=x`,
    "/authors/" + encodeURIComponent("<script>neverExecute()</script>"),
    "/about?profile=x",
  ]) {
    const invalid = await page.goto(origin + path);
    assert.ok(invalid);
    assert.equal(invalid.status(), 400);
    const invalidPolicy = invalid.headers()["content-security-policy"];
    assert.ok(invalidPolicy?.includes("script-src 'none'"));
    assert.equal(await page.locator("form,iframe,img").count(), 0);
    assert.equal(await page.locator("script").count(), 1);
    assert.equal(
      await page.locator("script").getAttribute("src"),
      readClient.path,
    );
    assert.equal(
      await page.locator("script").getAttribute("integrity"),
      readClient.integrity,
    );
  }
  await page.screenshot({
    path: join(evidence, "authors-invalid-state.png"),
    fullPage: true,
  });
  await page.goto(origin + "/authors");
  await page
    .locator('nav[aria-label="Main navigation"]')
    .getByRole("link", { name: "About", exact: true })
    .click();
  assert.equal(new URL(page.url()).pathname, "/about");
  await localFonts(true);
  const text = await page.locator("main").innerText();
  assert.ok(text.includes("human landing and read-only observation surface"));
  assert.ok(text.includes("Agent Forum Research"));
  assert.ok(text.includes("does not require OKF"));
  assert.equal(await page.locator("main section.listing-row").count(), 8);
  const evidenceLinks = await page
    .locator("main section.listing-row a")
    .evaluateAll((links) => links.map((link) => link.getAttribute("href")));
  assert.deepEqual(evidenceLinks, [
    "https://openai.com/index/hugging-face-incident-and-the-road-ahead/",
    "https://collusion.wiki/",
    "https://www.moltbook.com/",
    "https://arxiv.org/abs/2602.13458",
    "https://agora.burmaster.com/",
    "https://github.com/1f916-ai/1f916",
    "https://arxiv.org/abs/2304.03442",
    "https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/SPEC.md",
  ]);
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({
    path: join(evidence, "about-mobile.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({
    path: join(evidence, "about-desktop.png"),
    fullPage: true,
  });
  await page
    .getByRole("link", {
      name: "Read the installation documentation",
      exact: true,
    })
    .click();
  assert.equal(new URL(page.url()).pathname, "/docs/");
  assert.ok((await page.locator("body").innerText()).includes("Agent Forum"));
  for (const path of [
    "/docs/",
    "/docs/publication/",
    "/docs/retrieval/",
    "/docs/api/",
  ]) {
    assert.equal((await page.goto(origin + path))?.status(), 200);
    const navigation = page.getByRole("navigation", {
      name: "Main navigation",
    });
    assert.deepEqual(
      await navigation
        .locator("a")
        .evaluateAll((links) => links.map((link) => link.getAttribute("href"))),
      ["/", "/authors", "/about", "/docs/"],
    );
    assert.equal(await navigation.locator('[aria-disabled="true"]').count(), 0);
    const postsLink = navigation.getByRole("link", {
      name: "Posts",
      exact: true,
    });
    assert.equal(await postsLink.getAttribute("href"), "/");
    assert.equal(await postsLink.getAttribute("data-forum-navigation"), null);
    await postsLink.click();
    assert.equal(new URL(page.url()).pathname, "/");
    assert.equal(
      await page.locator('main[data-forum-view="posts"]').count(),
      1,
    );
    await page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("link", { name: "Docs", exact: true })
      .click();
    assert.equal(new URL(page.url()).pathname, "/docs/");
    await page.goto(origin + path);
    await navigation
      .getByRole("link", { name: "Authors", exact: true })
      .click();
    assert.equal(new URL(page.url()).pathname, "/authors");
    assert.equal(
      await page.locator('section[aria-label="Local Authors"] h2 a').count(),
      10,
    );
    await page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("link", { name: "Docs", exact: true })
      .click();
    assert.equal(new URL(page.url()).pathname, "/docs/");
    await page.goto(origin + path);
    await page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("link", { name: "About", exact: true })
      .click();
    assert.equal(new URL(page.url()).pathname, "/about");
    assert.equal(await page.locator("h1").innerText(), "About");
  }
  // Reuse the merged Docs owner's complete production browser suite while this
  // actual HTTPS Worker and disposable migrated D1 are still alive.
  const previousDocsOrigin = process.env.DOCS_ORIGIN;
  const previousDocsEvidence = process.env.DOCS_EVIDENCE;
  try {
    process.env.DOCS_ORIGIN = origin;
    process.env.DOCS_EVIDENCE = join(evidence, "docs");
    await import("./docs-smoke.js");
  } finally {
    if (previousDocsOrigin === undefined) delete process.env.DOCS_ORIGIN;
    else process.env.DOCS_ORIGIN = previousDocsOrigin;
    if (previousDocsEvidence === undefined) delete process.env.DOCS_EVIDENCE;
    else process.env.DOCS_EVIDENCE = previousDocsEvidence;
  }
  console.log(
    "PASS all four generated Docs mastheads navigate to real Posts/Authors/About and back; native Posts link; complete merged Docs production no-JS suite passed",
  );
  console.log(
    "PASS real HTTPS registration/publication, directory ordering10+2, canonical identities, no activity, same-installation author-filtered JSON API navigation, no-JS Authors/About/docs, actual fonts/focus/reflow/text zoom and documented research only",
  );

  command(
    "d1",
    "execute",
    "DB",
    "--local",
    "--config",
    "../../wrangler.jsonc",
    "--persist-to",
    state,
    "--command",
    "ALTER TABLE agents RENAME TO agents_unavailable;",
  );
  try {
    const unavailable = await page.goto(origin + "/authors");
    assert.equal(unavailable?.status(), 503);
    assert.match(unavailable.headers()["cache-control"] ?? "", /no-store/);
    const failureText = await page.locator("main").innerText();
    assert.ok(failureText.includes("Authors could not be loaded"));
    assert.doesNotMatch(
      failureText,
      /SQL|SELECT |stack|D1_ERROR|no such table/,
    );
    await page.screenshot({
      path: join(evidence, "authors-unavailable.png"),
      fullPage: true,
    });
    assert.equal(
      (await page.goto(`${origin}/authors/${first.name}`))?.status(),
      503,
    );
    await page.screenshot({
      path: join(evidence, "author-unavailable.png"),
      fullPage: true,
    });
    assert.equal(
      (await page.goto(origin + "/about"))?.status(),
      200,
      "About must not depend on D1",
    );
    assert.equal((await page.goto(origin + "/authors"))?.status(), 503);
  } finally {
    command(
      "d1",
      "execute",
      "DB",
      "--local",
      "--config",
      "../../wrangler.jsonc",
      "--persist-to",
      state,
      "--command",
      "ALTER TABLE agents_unavailable RENAME TO agents;",
    );
  }
  await page.getByRole("link", { name: "Try again", exact: true }).click();
  assert.equal(
    await page.locator('section[aria-label="Local Authors"] h2 a').count(),
    10,
  );
  assert.deepEqual(
    await decode(
      AgentPageResult,
      await publicSearch({ resource: "agents", limit: 100 }),
    ),
    beforeAgents,
  );
  assert.deepEqual(
    await decode(
      PostPageResult,
      await publicSearch({ resource: "posts", limit: 100 }),
    ),
    beforePosts,
  );
  assert.ok(
    requests.every(
      ({ url, method, credential }) =>
        new URL(url).origin === origin &&
        method === "GET" &&
        !credential &&
        !/^\/v1\/(?:register|publish)(?:\/|$)/.test(new URL(url).pathname),
    ),
    "Browser observation must be local read-only GETs without auth/cookies, mutation endpoints or external requests",
  );
  await context.close();
  console.log(
    "PASS missing404/invalid400, genuine D1 directory+identity503, data-independent About, real retry recovery, unchanged identities/activity/Posts and no auth/UI mutation/external request",
  );
  console.log(`Evidence: ${evidence}`);
  console.log(
    "Direct/reload retains complete SSR/noJS/allReady/final status; initial wait is browser-owned. Eligible enhanced pending/history/retry and composed Posts/Post/Authors/About journeys are verified separately by the production composition suite. No canonical crawling policy, full-app release or provider/public-activation acceptance.",
  );
} finally {
  try {
    await browser?.close();
  } finally {
    try {
      await stop(server);
    } finally {
      agent?.destroy();
      await rm(state, { recursive: true, force: true });
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
    }
  }
}

async function stop(child: ReturnType<typeof spawn> | undefined) {
  if (child?.pid === undefined) return;
  const signal = (name: NodeJS.Signals) => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, name);
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ESRCH"
      ))
        throw error;
    }
  };
  const exited =
    child.exitCode === null && child.signalCode === null
      ? once(child, "exit")
      : Promise.resolve();
  signal("SIGTERM");
  if (
    !(await Promise.race([
      exited.then(() => true),
      setTimeout(5_000, false, { ref: false }),
    ]))
  ) {
    signal("SIGKILL");
    await exited;
  }
  signal("SIGKILL");
}
async function get(path: string, init?: RequestInit): Promise<Response> {
  assert.ok(agent, "Missing local certificate trust");
  assert.ok(init?.body === undefined || typeof init.body === "string");
  const body = init?.body;
  const url = new URL(path, origin);
  assert.equal(url.origin, origin);
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        agent,
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(10_000),
        ]),
        method: init?.method ?? "GET",
        headers: Object.fromEntries(new Headers(init?.headers)),
      },
      (response) => {
        const chunks: Buffer[] = [];
        let length = 0;
        response.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length > 16 * 1024 * 1024) {
            request.destroy(new Error("Local test response exceeds bound"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(response.headers))
            if (value !== undefined)
              for (const entry of Array.isArray(value) ? value : [value])
                headers.append(name, entry);
          const status = response.statusCode ?? 500;
          resolve(
            new Response(
              status === 204 || init?.method === "HEAD"
                ? null
                : Buffer.concat(chunks).toString("utf8"),
              { status, headers },
            ),
          );
        });
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

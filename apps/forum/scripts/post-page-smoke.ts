// Local-only production verification. No fixture or fault endpoint is installed.
import assert from "node:assert/strict";
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
  PostLookupResult,
  PostPageResult,
} from "../src/api/contracts.js";

const evidence = process.env.POST_PAGE_EVIDENCE ?? "/tmp/wo27-evidence";
await mkdir(evidence, { recursive: true });
const state = await mkdtemp(join(tmpdir(), "agent-forum-post-pages-"));
const origin = "https://127.0.0.1:8794";
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
      "8794",
      "--local-protocol",
      "https",
      "--local-upstream",
      "127.0.0.1:8794",
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
      throw new Error("Production Post Worker exited before readiness");
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
  assert.ok(ready, "Production Post Worker did not become ready");
  const registrationResponse = await get("/v1/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(registrationResponse.status, 201);
  const identity = await decode(RegistrationResult, registrationResponse);
  const publish = async (
    body: string,
    tags: readonly string[] = [],
    parent?: string,
  ) => {
    const response = await get("/v1/publish", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${identity.apiKey}`,
      },
      body: JSON.stringify({
        body,
        tags,
        ...(parent === undefined ? {} : { reply_to: parent }),
      }),
    });
    assert.equal(response.status, 201, "Real API publication must succeed");
    return decode(PostResult, response);
  };
  const search = async (selection: unknown) => {
    const response = await get("/v1/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(selection),
    });
    assert.equal(response.status, 200);
    return decode(PostPageResult, response);
  };
  const columns = Array.from(
    { length: 32 },
    (_, index) => `Column${String(index)}`,
  );
  const table = `| ${columns.join(" | ")} |\n| ${columns.map(() => "---").join(" | ")} |\n| ${columns.map(() => "Exact cell value").join(" | ")} |`;
  const tags = [" X:Y ", "<script>literal</script>", "multi\nline"];
  const body = `# Coordination report\n\nPublished through the real API for local verification. **Bold**, *italic* and selectable text.\n\n[local registration](/v1/register?payload=%7B%7D) [local publication](/v1/publish?payload=x) [external](https://external.invalid/mutate) ![external image](https://external.invalid/image)\n\n<script>window.__postExecuted=1</script><iframe src="/v1/register"></iframe>\n\n\`\`\`text\n${"long_code_segment_".repeat(100)}\n\`\`\`\n\n${table}`;
  const parent = await publish(body, tags);
  const direct: (typeof PostResult.Type)[] = [];
  for (let index = 0; index < 12; index++)
    direct.push(await publish(`Direct reply ${String(index)}.`, [], parent.id));
  const first = direct[0];
  assert.ok(first);
  const nested = await publish(
    "Nested reply must not appear in the ancestor's direct feed.",
    [],
    first.id,
  );
  const unrelated = await publish(
    "Unrelated Post must not appear in the direct feed.",
  );
  const raw = "> ".repeat(100) + "<script>window.__postExecuted=2</script>";
  const fallback = await publish(raw);
  const maximum = await publish("m".repeat(65_500));
  const malformed = await publish("**unclosed\n\n```js\nmissing closing fence");
  const before = await search({ limit: 100 });
  const path = `/posts/${parent.id}`;
  const response = await get(path);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Type") ?? "", /text\/html/);
  assert.equal(response.headers.get("Cache-Control"), "no-store, private");
  const policy = response.headers.get("Content-Security-Policy") ?? "";
  assert.equal(
    policy,
    "default-src 'none'; style-src 'self'; img-src 'self'; script-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; font-src 'self'",
  );
  const html = await response.text();
  assert.ok(!html.includes(identity.apiKey), "No credentials in HTML");
  assert.doesNotMatch(
    html,
    /<(script|iframe|img|form)\b|<link[^>]+(?:prefetch|preload)/i,
  );
  assert.ok(html.includes(parent.id) && html.includes(parent.authorId));
  assert.equal((await get(path, { method: "HEAD" })).status, 200);
  assert.equal(await (await get(path, { method: "HEAD" })).text(), "");
  assert.equal((await get(path, { method: "OPTIONS" })).status, 204);
  assert.equal((await get(path, { method: "POST" })).status, 405);
  console.log(
    "PASS production real HTTPS publication/retrieval, SSR HTML, safe methods, strict CSP and no scripts/mutations/prefetch",
  );

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    javaScriptEnabled: false,
    ignoreHTTPSErrors: true,
  });
  context.setDefaultTimeout(15_000);
  const requests: { readonly url: string; readonly method: string }[] = [];
  context.on("request", (request) =>
    requests.push({ url: request.url(), method: request.method() }),
  );
  const page = await context.newPage();
  for (const [name, width] of [
    ["desktop", 1280],
    ["mobile", 375],
    ["zoom-200", 640],
    ["reflow-400", 320],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    const pageResponse = await page.goto(origin + path);
    assert.equal(pageResponse?.status(), 200);
    await page.evaluate(() => document.fonts.ready);
    assert.ok(
      await page.evaluate(
        () =>
          document.fonts.check('16px "Libre Franklin"') &&
          document.fonts.check('italic 16px "Libre Franklin"'),
      ),
    );
    assert.deepEqual(
      await page.locator(".post-tags li").allTextContents(),
      tags,
    );
    assert.equal(
      await page.locator('article[aria-label^="Reply "]').count(),
      10,
    );
    assert.ok(!(await page.locator("main").innerText()).includes(nested.id));
    assert.ok(!(await page.locator("main").innerText()).includes(unrelated.id));
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    assert.equal(await page.locator("script,iframe,img,form").count(), 0);
    assert.ok(!(await page.evaluate(() => "__postExecuted" in window)));
    await page.screenshot({
      path: join(evidence, `post-${name}.png`),
      fullPage: true,
    });
  }
  await page.goto(origin + path);
  await page.keyboard.press("Tab");
  assert.equal(await page.locator(":focus").innerText(), "Skip to content");
  await page.keyboard.press("Enter");
  assert.equal(
    await page.locator(":focus").getAttribute("id"),
    "forum-content",
  );
  const scroll = page.locator(".post-content .table-scroll").first();
  assert.ok(
    await scroll.evaluate(
      (element) => element.scrollWidth > element.clientWidth,
    ),
  );
  await scroll.focus();
  await page.keyboard.press("ArrowRight");
  await setTimeout(150);
  assert.ok(
    await scroll.evaluate((element) => element.scrollLeft > 0),
    "Native scroll region must support keyboard scrolling",
  );
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  assert.equal(
    await page.evaluate(
      () => getComputedStyle(document.documentElement).fontSize,
    ),
    "32px",
    "Text zoom must actually be applied",
  );
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({
    path: join(evidence, "post-text-zoom.png"),
    fullPage: true,
  });
  await page.getByRole("link", { name: "Next replies", exact: true }).click();
  assert.equal(await page.locator('article[aria-label^="Reply "]').count(), 2);
  assert.ok(!new URL(page.url()).searchParams.has("author"));
  const cursor = new URL(page.url()).searchParams.get("replyCursor");
  assert.ok(cursor);
  await page.screenshot({
    path: join(evidence, "post-next-replies.png"),
    fullPage: true,
  });
  await page.getByRole("link", { name: "First replies", exact: true }).click();
  assert.equal(new URL(page.url()).search, "");
  await page.goto(`${origin}/posts/${nested.id}`);
  assert.equal(await page.locator(".post-tags").count(), 0);
  assert.ok(
    (await page.locator("main").innerText()).includes(
      "No direct replies on this page.",
    ),
  );
  await page.screenshot({
    path: join(evidence, "post-empty-replies.png"),
    fullPage: true,
  });
  await page
    .getByRole("link", { name: `Parent Post ${first.id}`, exact: true })
    .click();
  assert.equal(new URL(page.url()).pathname, `/posts/${first.id}`);
  assert.equal(await page.locator('article[aria-label^="Reply "]').count(), 1);
  await page.goto(`${origin}/posts/${fallback.id}`);
  assert.ok(
    (await page.locator("main").innerText()).includes(
      "Markdown can't be rendered",
    ),
  );
  assert.equal(
    await page.getByLabel("Unchanged raw Markdown").textContent(),
    raw,
  );
  const rawLink = await page
    .getByRole("link", { name: "Read unchanged Post JSON", exact: true })
    .getAttribute("href");
  assert.ok(rawLink);
  assert.ok(rawLink.startsWith("/v1/search?payload="));
  const rawResponse = await get(rawLink);
  assert.equal(rawResponse.status, 200);
  assert.equal((await decode(PostLookupResult, rawResponse)).post.body, raw);
  await page.screenshot({
    path: join(evidence, "post-renderer-fallback.png"),
    fullPage: true,
  });
  await page.goto(`${origin}/posts/${maximum.id}`);
  assert.equal(
    await page.locator(".post-content").first().innerText(),
    maximum.body,
  );
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.goto(`${origin}/posts/${malformed.id}`);
  assert.ok((await page.locator("main").innerText()).includes("unclosed"));
  const missing = await page.goto(`${origin}/posts/${"M".repeat(21)}`);
  assert.equal(missing?.status(), 404);
  assert.ok(
    (await page.locator("main").innerText()).includes("Post not found"),
  );
  await page.screenshot({
    path: join(evidence, "post-not-found.png"),
    fullPage: true,
  });
  const invalid = await page.goto(`${origin}${path}?replyCursor=invalid`);
  assert.equal(invalid?.status(), 400);
  await page.screenshot({
    path: join(evidence, "post-invalid-cursor.png"),
    fullPage: true,
  });
  const mismatched = await page.goto(
    `${origin}/posts/${unrelated.id}?replyCursor=${encodeURIComponent(cursor)}`,
  );
  assert.equal(mismatched?.status(), 400);
  console.log(
    "PASS real-data no-JavaScript Post/parent/direct-only reply pages, cursors, fonts, keyboard/zoom/overflow, tags, raw fallback, maximum/malformed Markdown and missing/invalid states",
  );

  // Genuine local D1 fault, never an application route or simulated response.
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
    "ALTER TABLE posts RENAME TO posts_unavailable;",
  );
  try {
    const unavailable = await page.goto(origin + path);
    assert.equal(unavailable?.status(), 503);
    assert.match(unavailable.headers()["cache-control"] ?? "", /no-store/);
    const text = await page.locator("main").innerText();
    assert.ok(text.includes("Post could not be loaded"));
    assert.doesNotMatch(text, /SQL|SELECT |stack|D1_ERROR|no such table/);
    assert.equal(
      await page.getByRole("link", { name: "Try again", exact: true }).count(),
      1,
    );
    await page.screenshot({
      path: join(evidence, "post-unavailable.png"),
      fullPage: true,
    });
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
      "ALTER TABLE posts_unavailable RENAME TO posts;",
    );
  }
  await page.getByRole("link", { name: "Try again", exact: true }).click();
  assert.ok((await page.locator("main").innerText()).includes(parent.id));
  assert.equal(
    await page
      .getByRole("heading", { name: "Direct replies", exact: true })
      .count(),
    1,
  );
  const after = await search({ limit: 100 });
  assert.deepEqual(
    after.posts.map((post) => post.id).sort(),
    before.posts.map((post) => post.id).sort(),
  );
  assert.ok(
    requests.every(
      ({ url, method }) =>
        new URL(url).origin === origin &&
        method === "GET" &&
        !/^\/v1\/(?:register|publish)(?:\/|$)/.test(new URL(url).pathname),
    ),
    "Browser must issue only local read requests, never mutation or external URLs",
  );
  await context.close();
  console.log(
    "PASS genuine production D1 failure503, safe error/retry/recovery, unchanged Post set and no UI mutations/external requests",
  );
  console.log(`Evidence: ${evidence}`);
  console.log(
    "NOT CLAIMED: in-document initial loading indicator under allReady/no-script SSR; parent disposition required. Native browser navigation loading remains available. No deployment/provider/full integrated acceptance.",
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

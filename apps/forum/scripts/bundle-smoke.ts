import { readClient } from "../app/browsing/client-manifest";
import { productionBrowseSmoke } from "./browse-smoke";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { gzipSync } from "node:zlib";
import { chromium } from "playwright";
import { Schema } from "effect";
import { Agent, request as httpsRequest } from "node:https";
import {
  RegistrationResult,
  AgentLookupResult,
  PostResult,
  PostLookupResult,
  PostPageResult,
  RelevancePageResult,
} from "../src/api/contracts.js";

const files = (await readdir("dist/server", { recursive: true })).filter(
  (path) => /\.m?js$/.test(path),
);
assert.ok(files.length > 0, "Missing production Worker modules");
const bytes = (
  await Promise.all(
    files.map(
      async (path) =>
        gzipSync(await readFile(join("dist/server", path))).byteLength,
    ),
  )
).reduce((sum, size) => sum + size, 0);
assert.ok(
  bytes <= 3 * 1024 * 1024,
  "Worker exceeds the 3 MiB compressed bundle limit",
);
const state = await mkdtemp(join(tmpdir(), "agent-forum-runtime-"));
const environment = {
  ...process.env,
  CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
  WRANGLER_SEND_METRICS: "false",
};
let server: ReturnType<typeof spawn> | undefined;
let tlsAgent: Agent | undefined;
let migration: ReturnType<typeof spawn> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const controller = new AbortController();
const interrupt = () => {
  controller.abort();
  process.exitCode = 1;
  void browser?.close().catch(() => undefined);
};
// Wrappers may forward signals repeatedly; retain these through all cleanup.
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
try {
  // Ephemeral local transport certificate, never an application setup secret.
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
  const ca = await readFile(certificate);
  tlsAgent = new Agent({ ca }); // Certificate verification stays enabled.
  migration = spawn(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "migrations",
      "apply",
      "DB",
      "--local",
      "--config",
      "../../wrangler.jsonc",
      "--persist-to",
      state,
    ],
    { env: environment, detached: true, stdio: "ignore" },
  );
  try {
    const completion: unknown = await once(migration, "exit", {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
    });
    assert.ok(
      Schema.is(Schema.Tuple(Schema.Literal(0), Schema.Null))(completion),
      "Local migration failed",
    );
  } finally {
    await stop(migration);
    migration = undefined;
  }
  controller.signal.throwIfAborted();
  const startServer = () =>
    spawn(
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
        "8792",
        "--local-protocol",
        "https",
        "--local-upstream",
        "127.0.0.1:8792",
        "--upstream-protocol",
        "https",
        "--https-key-path",
        key,
        "--https-cert-path",
        certificate,
        "--var",
        "CANONICAL_ORIGIN:https://127.0.0.1:8792",
      ],
      { env: environment, detached: true, stdio: ["ignore", "pipe", "pipe"] },
    );
  const origin = "https://127.0.0.1:8792";
  const waitReady = async (child: ReturnType<typeof spawn>) => {
    let log = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      log += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      log += chunk.toString();
    });
    for (let i = 0; i < 150; i++) {
      controller.signal.throwIfAborted();
      if (child.exitCode !== null)
        throw new Error(`Production runtime exited: ${log}`);
      try {
        if (
          (await boundedFetch(origin, { signal: AbortSignal.timeout(500) })).ok
        )
          return;
      } catch {
        /* startup only */
      }
      await setTimeout(100);
    }
    throw new Error(`Production runtime failed readiness: ${log}`);
  };
  server = startServer();
  await waitReady(server);
  const response = await boundedFetch(origin);
  const html = await response.text();
  assert.match(html, /Public forum, for Agents/);
  assert.match(html, /No Posts have been published/);
  assert.equal((html.match(/<script\b/g) ?? []).length, 1);
  assert.ok(html.includes(`src="${readClient.path}"`));
  assert.ok(html.includes(`integrity="${readClient.integrity}"`));
  const form = /<form\b[^>]*>/.exec(html)?.[0];
  assert.ok(form);
  assert.match(form, /method="get"/);
  assert.match(form, /action="\/"/);
  assert.doesNotMatch(html, /<iframe\b|<[a-z][^>]*\son\w+=/i);
  assert.match(
    response.headers.get("Content-Security-Policy") ?? "",
    new RegExp(
      `script-src '${readClient.integrity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'`,
    ),
  );
  const css = /href="([^"]+\.css)"/.exec(html)?.[1];
  assert.ok(css, "SSR must link a real local stylesheet");
  assert.equal((await boundedFetch(new URL(css, origin))).status, 200);
  const docs = await boundedFetch(origin + "/docs/");
  assert.equal(docs.status, 200);
  assert.match(await docs.text(), /not a complete installation/);
  assert.equal((await boundedFetch(origin + "/missing")).status, 404);
  for (const method of ["GET", "POST"])
    for (const operation of ["register", "publish", "search"]) {
      const body = JSON.stringify(
        operation === "publish" ? { body: "fixture" } : {},
      );
      const result = await boundedFetch(
        `${origin}/v1/${operation}` +
          (method === "GET" ? `?payload=${encodeURIComponent(body)}` : ""),
        method === "POST"
          ? { method, headers: { "Content-Type": "application/json" }, body }
          : { method },
      );
      assert.equal(
        result.status,
        operation === "register" ? 201 : operation === "publish" ? 401 : 200,
      );
      assert.match(
        result.headers.get("Content-Type") ?? "",
        operation !== "publish"
          ? /application\/json/
          : /application\/problem\+json/,
      );
      assert.match(result.headers.get("Cache-Control") ?? "", /no-store/);
    }
  assert.equal(
    (await boundedFetch(origin + "/docs/problems/invalid-request.json")).status,
    200,
  );
  for (const method of ["HEAD", "OPTIONS"]) {
    const result = await boundedFetch(origin + "/v1/publish", { method });
    assert.equal(result.status, 204);
    assert.equal(await result.text(), "");
  }
  const call = (
    operation: string,
    input: unknown,
    method: string,
    credential?: string,
  ) => {
    const body = JSON.stringify(input);
    return boundedFetch(
      `${origin}/v1/${operation}` +
        (method === "GET" ? `?payload=${encodeURIComponent(body)}` : ""),
      {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
        },
        ...(method === "POST" ? { body } : {}),
      },
    );
  };
  const badShape = () => {
    throw new Error("Invalid integration response shape");
  };
  const retained: {
    key: string;
    author: string;
    postId: string;
    bookmark: string;
  }[] = [];
  for (const method of ["GET", "POST"]) {
    const registration = await call("register", {}, method);
    assert.equal(registration.status, 201);
    const identity = await Schema.decodeUnknownPromise(RegistrationResult)(
      await registration.json(),
    ).catch(badShape);
    const directoryResponse = await call(
      "search",
      { resource: "agents", name: identity.name.toLowerCase() },
      method,
    );
    assert.equal(directoryResponse.status, 200);
    const directory = await Schema.decodeUnknownPromise(AgentLookupResult)(
      await directoryResponse.json(),
      { onExcessProperty: "error" },
    ).catch(badShape);
    assert.ok(
      directory.agent.name === identity.name &&
        directory.agent.latestPublishingTime === null &&
        directory.agent.posts.author === identity.id,
      "Directory identity/privacy contract changed",
    );
    const initial = await call("search", { author: identity.id }, method);
    assert.equal(initial.status, 200);
    const empty = await Schema.decodeUnknownPromise(PostPageResult)(
      await initial.json(),
    ).catch(badShape);
    assert.equal(empty.posts.length, 0);
    const filter = {
      author: identity.id,
      tags: [" A ", "nul\0tag"],
      q: "raw content",
    };
    const selected = async (selection: object) => {
      const response = await call("search", selection, method);
      assert.equal(response.status, 200);
      return Schema.decodeUnknownPromise(PostPageResult)(
        await response.json(),
      ).catch(badShape);
    };
    const waiting = await selected(filter);
    assert.equal(waiting.posts.length, 0);
    const body = "---\nnot: metadata\n---\nraw 😀 content\0tailword";
    const tags = [" A ", "a", " A ", "x:y/z", "nul\0tag"];
    const published = await call(
      "publish",
      { body, tags },
      method,
      identity.apiKey,
    );
    assert.equal(published.status, 201);
    const post = await Schema.decodeUnknownPromise(PostResult)(
      await published.json(),
    ).catch(badShape);
    assert.ok(
      post.authorId === identity.id &&
        post.body === body &&
        post.tags.join("|") === " A |a|x:y/z|nul\0tag",
      "Publication facts/content changed",
    );
    const alternate = method === "GET" ? "POST" : "GET";
    const lookup = await call("search", { id: post.id }, alternate);
    assert.equal(lookup.status, 200);
    const found = await Schema.decodeUnknownPromise(PostLookupResult)(
      await lookup.json(),
    ).catch(badShape);
    assert.ok(
      JSON.stringify(found.post) === JSON.stringify(post),
      "Lookup differs from accepted Post",
    );
    const replyResponse = await call(
      "publish",
      {
        body: "raw content correction by reply",
        tags: filter.tags,
        reply_to: post.id,
      },
      alternate,
      identity.apiKey,
    );
    assert.equal(replyResponse.status, 201);
    const reply = await Schema.decodeUnknownPromise(PostResult)(
      await replyResponse.json(),
    ).catch(badShape);
    assert.ok(
      reply.reply_to === post.id && reply.authorId === identity.id,
      "Reply attribution failed",
    );
    let checkpoint = waiting.readCursor;
    for (const expected of [post.id, reply.id]) {
      const page = await selected({
        ...filter,
        readCursor: checkpoint,
        limit: 1,
      });
      assert.ok(
        page.posts.length === 1 && page.posts[0]?.id === expected,
        "Filtered resume skipped/repeated a Post",
      );
      checkpoint = page.readCursor;
    }
    const settled = await selected({ ...filter, readCursor: checkpoint });
    assert.ok(
      settled.posts.length === 0 && settled.readCursor === checkpoint,
      "Empty filtered poll advanced checkpoint",
    );
    const mismatched = await call(
      "search",
      { ...filter, readCursor: empty.readCursor },
      method,
    );
    assert.equal(mismatched.status, 400);
    assert.ok(
      !(await mismatched.text()).includes("readCursor"),
      "Failed filtered read supplied a checkpoint",
    );
    const relevanceResponse = await call(
      "search",
      { ...filter, order: "relevance" },
      method,
    );
    assert.equal(relevanceResponse.status, 200);
    // Strict decoding must reject even an extra readCursor, not silently strip it.
    const ranked = await Schema.decodeUnknownPromise(RelevancePageResult)(
      await relevanceResponse.json(),
      { onExcessProperty: "error" },
    ).catch(badShape);
    const rankedIds = ranked.posts.map((item) => item.id).sort();
    assert.ok(
      rankedIds.join() === [post.id, reply.id].sort().join(),
      "Relevance selection changed",
    );
    for (const probe of [
      { input: { ...filter, q: '"content\0tailword"' }, count: 1 },
      { input: { ...filter, q: '"content\0unpublished"' }, count: 0 },
      { input: { ...filter, tags: ["nul"] }, count: 0 },
    ]) {
      const page = await selected(probe.input);
      assert.ok(
        page.posts.length === probe.count,
        "NUL MATCH/Tag selection changed",
      );
    }
    let bookmark = empty.readCursor;
    for (const expected of [post.id, reply.id]) {
      const unread = await call(
        "search",
        { author: identity.id, readCursor: bookmark, limit: 1 },
        alternate,
      );
      assert.equal(unread.status, 200);
      const page = await Schema.decodeUnknownPromise(PostPageResult)(
        await unread.json(),
      ).catch(badShape);
      assert.ok(
        page.posts.length === 1 && page.posts[0]?.id === expected,
        "Partial unread page skipped/repeated a Post",
      );
      bookmark = page.readCursor;
    }
    const poll = await call(
      "search",
      { author: identity.id, readCursor: bookmark },
      method,
    );
    const polled = await Schema.decodeUnknownPromise(PostPageResult)(
      await poll.json(),
    ).catch(badShape);
    assert.ok(
      polled.posts.length === 0 && polled.readCursor === bookmark,
      "Empty poll advanced checkpoint",
    );
    const failed = await call(
      "search",
      { author: identity.id, readCursor: "invalid!" },
      method,
    );
    assert.equal(failed.status, 400);
    assert.ok(
      !(await failed.text()).includes("readCursor"),
      "Failed read supplied a checkpoint",
    );
    retained.push({
      key: identity.apiKey,
      author: identity.id,
      postId: post.id,
      bookmark,
    });
  }
  console.log("production_fts_filters_nul_checkpoints_get_post_passed");
  await stop(server);
  tlsAgent.destroy();
  tlsAgent = new Agent({ ca });
  server = startServer();
  await waitReady(server);
  for (const item of retained) {
    assert.equal(
      (await call("search", { id: item.postId }, "GET")).status,
      200,
    );
    assert.equal(
      (
        await call(
          "publish",
          { body: "retained credential after Worker restart" },
          "POST",
          item.key,
        )
      ).status,
      201,
    );
    const resumed = await call(
      "search",
      { author: item.author, readCursor: item.bookmark },
      "GET",
    );
    const page = await Schema.decodeUnknownPromise(PostPageResult)(
      await resumed.json(),
    ).catch(badShape);
    assert.equal(page.posts.length, 1);
  }
  console.log("production_agent_loop_and_restart_passed");
  controller.signal.throwIfAborted();
  browser = await chromium.launch({
    headless: true,
    timeout: 10_000,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });
  try {
    controller.signal.throwIfAborted();
    console.log("production_smoke_browser_started");
    const context = await browser.newContext({
      javaScriptEnabled: false,
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();
    await page.goto(origin);
    assert.match(
      await page.locator("main").innerText(),
      /Public forum, for Agents/,
    );
    await page.getByRole("link", { name: "Operating guide" }).click();
    assert.match(page.url(), /\/docs\//);
    assert.match(
      await page.locator("main").innerText(),
      /not a complete installation/,
    );
    await context.close();
    await productionBrowseSmoke(browser, origin, () => {
      const ddl = (command: string) => {
        execFileSync(
          "pnpm",
          [
            "exec",
            "wrangler",
            "d1",
            "execute",
            "DB",
            "--local",
            "--config",
            "../../wrangler.jsonc",
            "--persist-to",
            state,
            "--command",
            command,
          ],
          { env: environment, stdio: "ignore" },
        );
      };
      ddl("ALTER TABLE posts RENAME TO posts_browse_fault");
      return Promise.resolve(() => {
        ddl("ALTER TABLE posts_browse_fault RENAME TO posts");
        return Promise.resolve();
      });
    });
  } finally {
    await browser.close();
  }
  console.log(
    `Production Worker: ${String(bytes)} compressed bytes; real D1, SSR/static/API/safe methods and no-JavaScript browser checks passed.`,
  );
} finally {
  try {
    try {
      await stop(migration);
    } finally {
      await stop(server);
    }
  } finally {
    tlsAgent?.destroy();
    await rm(state, { recursive: true, force: true });
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
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

async function boundedFetch(
  input: string | URL,
  init?: RequestInit,
): Promise<Response> {
  const signal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(5_000),
    ...(init?.signal ? [init.signal] : []),
  ]);
  const url = new URL(input);
  if (url.protocol !== "https:") return fetch(url, { ...init, signal });
  if (!tlsAgent || (init?.body !== undefined && typeof init.body !== "string"))
    throw new Error("Invalid local TLS request");
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        agent: tlsAgent,
        signal,
        method: init?.method ?? "GET",
        headers: Object.fromEntries(new Headers(init?.headers)),
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 16 * 1024 * 1024) {
            request.destroy(new Error("Local response exceeds bound"));
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
    request.end(init?.body);
  });
}

import { postHref } from "../app/posts/links";
import { env } from "cloudflare:workers";
import { Effect, Option } from "effect";
import { nanoid } from "nanoid";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  loadPostPage,
  postPageHeaders,
  replyPageSize,
  type PostPageModel,
} from "../app/posts/data.server";
import { PostPage } from "../app/posts/view";
import { makeForumStore } from "../src/database/store.js";
import { makeDispatcher } from "../src/runtime/dispatch.js";
import { decodeSearch } from "../src/api/query.js";
import { Unavailable } from "../src/api/problems.js";
import type { PageContext, Execution } from "../src/runtime/context.js";
import { migrate } from "./d1.js";

const origin = "https://post-pages.owner.workers.dev";
const execution: Execution = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
};
const store = makeForumStore(env.DB);
let authorId = "";
let parentId = "";
const directIds: string[] = [];
let nestedId = "";
let otherId = "";
const render = (model: PostPageModel) =>
  renderToStaticMarkup(h(PostPage, { model }));
const app = makeDispatcher(async (request, forum) => {
  const id = decodeURIComponent(
    new URL(request.url).pathname.split("/")[2] ?? "",
  );
  const result = await loadPostPage(request, id, forum);
  return new Response(render(result.model), {
    status: result.status,
    headers: { ...postPageHeaders, "Content-Type": "text/html; charset=utf-8" },
  });
});
const request = (path: string, method = "GET", db = env.DB) =>
  app.fetch(
    new Request(origin + path, { method }),
    { ...env, DB: db },
    execution,
  );
const publish = (
  body: string,
  tags: readonly string[] = [],
  parent: Option.Option<string> = Option.none(),
) =>
  Effect.runPromise(store.publish({ authorId, body, tags, parentId: parent }));
const postModel = async (
  id: string,
  cursor: Option.Option<string> = Option.none(),
) => {
  let response: Awaited<ReturnType<typeof loadPostPage>> | undefined;
  const capture = makeDispatcher(async (request, forum) => {
    response = await loadPostPage(request, id, forum);
    return new Response("captured", { headers: postPageHeaders });
  });
  await capture.fetch(
    new Request(origin + postHref(id, cursor)),
    env,
    execution,
  );
  if (response === undefined) throw new Error("Page was not loaded");
  return response;
};
beforeAll(async () => {
  await migrate();
  authorId = nanoid();
  await Effect.runPromise(
    store.createIdentity({
      id: authorId,
      name: "PostPageTest",
      lookupId: nanoid(),
      digest: "a".repeat(64),
    }),
  );
  parentId = (
    await publish("# Actual body\n\n**GFM** and `code`.", [
      " <tag>& ",
      "Case:Sensitive",
      " spaced\ntag ",
    ])
  ).id;
  for (let index = 0; index < replyPageSize + 2; index++) {
    directIds.push(
      (
        await publish(
          `Direct reply ${String(index)}`,
          [],
          Option.some(parentId),
        )
      ).id,
    );
  }
  const first = directIds[0];
  if (first === undefined) throw new Error("Reply setup failed");
  nestedId = (await publish("Nested only", [], Option.some(first))).id;
  otherId = (await publish("Unrelated Post")).id;
});

describe("real D1 Post pages through request-local typed queries", () => {
  it("renders directly addressable complete sanitized content and exact facts/tags without authentication", async () => {
    const response = await request(postHref(parentId));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store, private");
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "script-src 'none'",
    );
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "form-action 'none'",
    );
    const html = await response.text();
    expect(html).toContain("<strong>GFM</strong>");
    expect(html).toContain("&lt;tag&gt;&amp;");
    expect(html).toContain(" spaced\ntag ");
    expect(html).toContain(authorId);
    expect(html.indexOf('aria-label="Publication facts"')).toBeLessThan(
      html.indexOf('aria-label="Body of Post'),
    );
    expect(html.indexOf('aria-label="Body of Post')).toBeLessThan(
      html.indexOf('aria-label="Direct replies"'),
    );
    expect(html).not.toMatch(
      /<form|<script|<iframe|Inspect source|content is untrusted/i,
    );
  });
  it("uses bounded exact direct-reply pages, excluding nested and unrelated Posts", async () => {
    const first = await postModel(parentId);
    if (first.model.kind !== "post" || first.model.replies.kind !== "ready")
      throw new Error("Expected loaded page");
    expect(first.model.replies.entries).toHaveLength(replyPageSize);
    const firstIds = first.model.replies.entries.map((entry) => entry.post.id);
    expect(firstIds).toEqual([...directIds].reverse().slice(0, replyPageSize));
    expect(firstIds).not.toContain(nestedId);
    expect(firstIds).not.toContain(otherId);
    const next = first.model.replies.next;
    if (next === null) throw new Error("Expected next cursor");
    const token = new URL(next, origin).searchParams.get("replyCursor");
    if (token === null) throw new Error("Expected cursor token");
    const second = await postModel(parentId, Option.some(token));
    if (second.model.kind !== "post" || second.model.replies.kind !== "ready")
      throw new Error("Expected loaded next page");
    expect(second.model.replies.entries.map((entry) => entry.post.id)).toEqual(
      [...directIds].reverse().slice(replyPageSize),
    );
    expect(second.model.replies.next).toBeNull();
    expect(render(second.model)).toContain(">First replies</a>");
    expect((await request(postHref(otherId, Option.some(token)))).status).toBe(
      400,
    );
  });
  it("links replies to their actual local parent and omits Tags when none exist", async () => {
    const response = await request(postHref(nestedId));
    const html = await response.text();
    const parent = directIds[0];
    if (parent === undefined) throw new Error("Missing parent fixture");
    expect(html).toContain(`href="${postHref(parent)}"`);
    expect(html).not.toContain('aria-label="Tags"');
    expect(html).toContain("No direct replies on this page.");
  });
  it("returns HTML404 for a valid missing Post, not empty-success data", async () => {
    const response = await request(postHref(nanoid()));
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store, private");
    expect(await response.text()).toContain("Post not found");
  });
  it("does not perform SSR loopback HTTP or any forum mutation", async () => {
    const before = await env.DB.prepare(
      "SELECT count(*) AS n FROM posts",
    ).first("n");
    const network = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("No loopback HTTP"));
    try {
      expect((await request(postHref(parentId))).status).toBe(200);
      expect(network).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
    }
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM posts").first("n"),
    ).toBe(before);
  });
  it("preserves API dispatch, safe methods, origin/security and rejects writes/extra page paths", async () => {
    expect((await request(postHref(parentId), "POST")).status).toBe(405);
    expect((await request(postHref(parentId), "OPTIONS")).status).toBe(204);
    const head = await request(postHref(parentId), "HEAD");
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect((await request(postHref(parentId) + "/extra")).status).toBe(404);
    expect((await request("/posts")).status).toBe(404);
    const api = await request(
      "/v1/search?payload=" +
        encodeURIComponent(JSON.stringify({ id: parentId })),
    );
    expect(api.headers.get("Content-Type")).toBe("application/json");
    expect(api.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const before = await env.DB.prepare(
      "SELECT count(*) AS n FROM posts",
    ).first("n");
    await request(postHref(parentId));
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM posts").first("n"),
    ).toBe(before);
  });
  it("shows safe real dependency failure and does not cache it", async () => {
    // Separate, deliberately unmigrated real D1 binding, never fake success.
    const response = await request(postHref(parentId), "GET", env.ISOLATED_DB);
    expect(response.status).toBe(503);
    const html = await response.text();
    expect(html).toContain("Post could not be loaded");
    expect(html).toContain(">Try again</a>");
    expect(html).not.toMatch(/SQL|SELECT |stack|D1_ERROR|no such table/);
    expect(response.headers.get("Cache-Control")).toBe("no-store, private");
  });
  it("uses unchanged raw fallback for actual parser limit failures", async () => {
    const body = "> ".repeat(100) + "<script>neverExecute()</script>";
    const post = await publish(body);
    const result = await postModel(post.id);
    if (result.model.kind !== "post") throw new Error("Expected existing post");
    expect(result.model.entry.rendering.status).toBe("fallback");
    expect(result.model.entry.post.body).toBe(body);
    const html = render(result.model);
    expect(html).toContain("Markdown can&#x27;t be rendered");
    expect(html).toContain("&lt;script&gt;neverExecute()&lt;/script&gt;");
    expect(html).toContain("Read unchanged Post JSON");
    expect(html).not.toContain("<script>");
  });
  it("renders valid maximum-size and malformed Markdown through the existing sanitizer", async () => {
    for (const body of [
      "m".repeat(65_500),
      "**unclosed\n\n```js\nmissing fence\n [odd](javascript:alert(1))",
    ]) {
      const post = await publish(body);
      const result = await postModel(post.id);
      if (result.model.kind !== "post") throw new Error("Expected loaded Post");
      expect(result.model.entry.post.body).toBe(body);
      expect(result.model.entry.rendering.status).toBe("rendered");
      expect(render(result.model)).not.toMatch(/href="javascript:|<script/);
    }
  });
  it("neutralizes local mutations, unsafe schemes, external links/images and raw active HTML", async () => {
    const body =
      '[register](/v1/register?payload=%7B%7D) [publish](/v1/publish?payload=x) [outside](https://external.invalid/mutate) ![remote](https://external.invalid/image) [unsafe](javascript:alert(1))\n\n<script>window.__postExecuted=1</script><img src=x onerror=alert(1)><iframe src="/v1/register"></iframe>';
    const post = await publish(body, ['"><img src=x onerror=alert(1)>']);
    const result = await postModel(post.id);
    const html = render(result.model);
    expect(html).toContain("Untrusted link destination");
    expect(html).toMatch(/(?:&lt;|&#x3C;)script(?:&gt;|>)/i);
    expect(html).not.toMatch(
      /<(script|iframe|img|form)\b|href="(?:\/v1\/(?:publish|register)|https:\/\/external|javascript:)|<[a-z][^>]*\sonerror=/,
    );
  });
});

describe("untrusted state and safe failure classification", () => {
  it("validates malformed/duplicate/unsupported state before issuing reads", async () => {
    let reads = 0;
    const context: PageContext = {
      origin,
      runtime: () => Promise.resolve({ database: "available" }),
      search: () => {
        reads++;
        return Effect.die("Must not read");
      },
    };
    for (const [id, suffix] of [
      ["bad", ""],
      [parentId, "?replyCursor="],
      [parentId, "?replyCursor=bad"],
      [parentId, "?replyCursor=x&replyCursor=y"],
      [parentId, "?author=elsewhere"],
      [parentId, "?q=hidden"],
    ] as const) {
      const response = await loadPostPage(
        new Request(origin + "/posts/ignored" + suffix),
        id,
        context,
      );
      expect(response.status).toBe(400);
    }
    expect(reads).toBe(0);
  });
  it("preserves safe Post content when only reply retrieval fails, without calling it empty", async () => {
    const input = await Effect.runPromise(decodeSearch({ id: parentId }));
    let observed: PageContext | undefined;
    const capture = makeDispatcher((_request, forum) => {
      observed = forum;
      return Promise.resolve(new Response("captured"));
    });
    await capture.fetch(new Request(origin), env, execution);
    if (observed === undefined) throw new Error("Context unavailable");
    const good = await Effect.runPromise(observed.search(input));
    const context: PageContext = {
      origin,
      runtime: observed.runtime,
      search: (selection) =>
        "id" in selection
          ? Effect.succeed(good)
          : Effect.fail(
              new Unavailable({
                type: origin + "/docs/problems/unavailable.json",
                title: "unavailable",
                detail: "private dependency text",
                instance: "urn:uuid:test",
                status: 503,
              }),
            ),
    };
    const result = await loadPostPage(
      new Request(origin + postHref(parentId)),
      parentId,
      context,
    );
    expect(result.status).toBe(503);
    expect(result.model.kind).toBe("post");
    const html = render(result.model);
    expect(html).toContain("Replies could not be loaded");
    expect(html).toContain("<strong>GFM</strong>");
    expect(html).not.toMatch(/private dependency|No direct replies/);
  });
  it("contains undeclared defects without exposing errors in HTML", async () => {
    const context: PageContext = {
      origin,
      runtime: () => Promise.resolve({ database: "available" }),
      search: () => Effect.die(new Error("private database credential")),
    };
    const result = await loadPostPage(
      new Request(origin + postHref(parentId)),
      parentId,
      context,
    );
    expect(result.status).toBe(500);
    expect(render(result.model)).not.toContain("private database credential");
  });
});

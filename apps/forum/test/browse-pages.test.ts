import { env } from "cloudflare:workers";
import { Effect, Option } from "effect";
import { nanoid } from "nanoid";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  loadBrowsePage,
  browseHeaders,
  type BrowseResponse,
} from "../app/browsing/data.server";
import {
  browseHref,
  decodeBrowseState,
  firstPage,
  previousPageLimit,
} from "../app/browsing/state";
import { BrowsePage } from "../app/routes/browse";
import { makeForumStore } from "../src/database/store.js";
import { makeDispatcher } from "../src/runtime/dispatch.js";
import type { Execution, PageContext } from "../src/runtime/context.js";
import { migrate } from "./d1.js";

const origin = "https://browse.owner.workers.dev";
const execution: Execution = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
};
const captures: BrowseResponse[] = [];
const app = makeDispatcher(async (request, context) => {
  const result = await loadBrowsePage(request, context);
  captures.push(result);
  return new Response(
    renderToStaticMarkup(createElement(BrowsePage, { model: result.model })),
    {
      status: result.status,
      headers: { ...browseHeaders, "Content-Type": "text/html; charset=utf-8" },
    },
  );
});
const call = (path: string, db = env.DB, method = "GET") =>
  app.fetch(
    new Request(origin + path, { method }),
    { ...env, DB: db },
    execution,
  );
const model = async (path: string) => {
  const response = await call(path);
  const captured = captures.at(-1);
  if (captured === undefined) throw new Error("No listing result captured");
  return { response, ...captured };
};
const ids: string[] = [];
const author = nanoid();
let parent = "";
const store = makeForumStore(env.DB);
beforeAll(async () => {
  await migrate();
  await migrate(env.ISOLATED_DB);
  await Effect.runPromise(
    store.createIdentity({
      id: author,
      name: "BrowseAuthor",
      lookupId: nanoid(),
      digest: "a".repeat(64),
    }),
  );
  for (let index = 0; index < 23; index++) {
    const post = await Effect.runPromise(
      store.publish({
        authorId: author,
        body:
          index === 0
            ? '<script>globalThis.agentExecuted=true</script> [write](/v1/publish) ![image](/v1/register) "sunrise orchard"'
            : `sunrise orchard ${String(index)}`,
        tags: index % 2 === 0 ? [" C++ ", "x.y"] : ["x.y"],
        parentId:
          index > 0 && index % 2 === 0 ? Option.some(parent) : Option.none(),
      }),
    );
    if (index === 0) parent = post.id;
    ids.push(post.id);
  }
});
const ready = async (path: string) => {
  const result = await model(path);
  expect(result.status).toBe(200);
  if (result.model.kind !== "ready")
    throw new Error("Expected real Posts result");
  return result.model;
};
describe("independent native D1 Posts listing and URL state", () => {
  it("lists real bounded newest-first data through request-local read port and full escaped SSR", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("SSR loopback forbidden"));
    try {
      const result = await model("/");
      expect(result.status).toBe(200);
      expect(result.response.headers.get("Cache-Control")).toBe(
        "no-store, private",
      );
      if (result.model.kind !== "ready") throw new Error("Expected Posts");
      expect(result.model.posts.map((post) => post.id)).toEqual(
        [...ids].reverse().slice(0, 10),
      );
      expect(fetch).not.toHaveBeenCalled();
      const html = await result.response.text();
      expect(html).toContain("<table>");
      expect(html).toContain("/posts/");
      expect(html).not.toMatch(
        /<button|\bGo\b|<script|<iframe|prefetch|<form[^>]*action="\/v1/,
      );
      expect(html).toContain('name="order"');
      expect(html).toContain('name="q"');
    } finally {
      fetch.mockRestore();
    }
  });
  it("round-trips exact Tags, punctuation/whitespace and all other real controls", async () => {
    const url = new URL(
      `/?q=${encodeURIComponent('"sunrise orchard"')}&author=${author}&parent=${parent}&tag=${encodeURIComponent(" C++ ")}&tag=x.y&tagMatch=any&order=oldest`,
      origin,
    );
    const state = await Effect.runPromise(decodeBrowseState(url));
    expect(state.selection.tags).toEqual([" C++ ", "x.y"]);
    const restored = await Effect.runPromise(
      decodeBrowseState(new URL(browseHref(state), origin)),
    );
    expect(restored).toEqual(state);
    const result = await ready(browseHref(state));
    expect(result.posts.map((post) => post.id)).toEqual(
      ids.filter((_, index) => index > 0 && index % 2 === 0).slice(0, 10),
    );
    expect(result.controls.q).toBe('"sunrise orchard"');
  });
  it("restores real next/previous pages after reload with matching order and resets to first", async () => {
    const first = await ready("/");
    expect(first.previous).toBeNull();
    expect(first.next).not.toBeNull();
    if (first.next === null) throw new Error("No next page");
    const second = await ready(first.next);
    expect(second.posts.map((post) => post.id)).toEqual(
      [...ids].reverse().slice(10, 20),
    );
    expect(second.previous).toBe("/");
    if (second.next === null) throw new Error("No third page");
    const third = await ready(second.next);
    expect(third.posts).toHaveLength(3);
    expect(third.next).toBeNull();
    if (third.previous === null) throw new Error("No previous page");
    expect((await ready(third.previous)).posts.map((post) => post.id)).toEqual(
      second.posts.map((post) => post.id),
    );
    const state = await Effect.runPromise(
      decodeBrowseState(new URL(second.next, origin)),
    );
    expect(browseHref(firstPage(state))).toBe("/");
  });
  it("uses actual native FTS, oldest/relevance and exact all/any Tags, not client search", async () => {
    const oldest = await ready("/?order=oldest&q=ORCHARD&tag=x.y");
    expect(oldest.posts.map((post) => post.id)).toEqual(ids.slice(0, 10));
    const relevance = await ready("/?order=relevance&q=sunrise");
    expect(relevance.posts).toHaveLength(10);
    expect(relevance.controls.order).toBe("relevance");
    const all = await ready("/?tag=x.y&tag=missing");
    expect(all.posts).toHaveLength(0);
    const any = await ready("/?tag=x.y&tag=missing&tagMatch=any");
    expect(any.posts).toHaveLength(10);
    expect((await ready("/?tag=X.Y")).posts).toHaveLength(0);
  });
  it("keeps genuinely empty installation and empty matches distinct from errors", async () => {
    const empty = await call("/", env.ISOLATED_DB);
    expect(empty.status).toBe(200);
    expect(await empty.text()).toContain("No Posts have been published");
    const filtered = await call("/?q=nevermatchthisword");
    expect(filtered.status).toBe(200);
    expect(await filtered.text()).toContain("No Posts match");
    for (const query of [
      "q=%22unclosed",
      "q=%21%21%21",
      "order=relevance",
      "author=bad",
    ]) {
      const response = await call("/?" + query);
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("Invalid Posts query");
    }
  });
  it("rejects duplicate/unknown/incompatible/cross-query cursor state before any query read", async () => {
    const first = await ready("/");
    if (first.next === null) throw new Error("No cursor");
    const next = new URL(first.next, origin);
    next.searchParams.set("q", "different");
    const search = vi.fn<PageContext["search"]>(() => {
      throw new Error("Must not execute");
    });
    const context: PageContext = {
      origin,
      search,
      runtime: () => Promise.resolve({ database: "available" }),
    };
    for (const path of [
      "/?q=x&q=y",
      "/?unknown=1",
      "/?readCursor=anything",
      "/?limit=100",
      "/?pageCursor=bad",
      "/?previous=",
      next.pathname + next.search,
    ])
      expect(
        (await loadBrowsePage(new Request(origin + path), context)).status,
      ).toBe(400);
    expect(search).not.toHaveBeenCalled();
  });
  it("bounds predecessor state and validates every historical token before reads", async () => {
    const first = await ready("/");
    if (first.next === null) throw new Error("No cursor");
    const url = new URL(first.next, origin);
    url.searchParams.append("previous", "invalid");
    const response = await call(url.pathname + url.search);
    expect(response.status).toBe(400);
    for (let index = 0; index <= previousPageLimit; index++)
      url.searchParams.append("previous", "");
    expect((await call(url.pathname + url.search)).status).toBe(400);
  });
  it("escapes hostile Agent body/tags as plain excerpts without active destinations or instruction execution", async () => {
    const response = await call("/?order=oldest");
    const html = await response.text();
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toMatch(
      /<script|<img|href="\/v1\/publish|src="\/v1\/register|onclick=/,
    );
    expect(html).toContain(" C++ ");
    expect(html).toContain(parent);
  });
  it("preserves HTTP503 and actual safe retry after a genuine local D1 failure", async () => {
    await env.DB.prepare("ALTER TABLE posts RENAME TO posts_unavailable").run();
    try {
      const result = await model("/?q=sunrise");
      expect(result.status).toBe(503);
      expect(await result.response.text()).not.toMatch(
        /\bSQL\b|posts_unavailable|SELECT\s+.+\s+FROM|\bstack\b/i,
      );
      expect(result.model.kind).toBe("failure");
      if (result.model.kind === "failure")
        expect(result.model.retry).toBe("/?q=sunrise");
    } finally {
      await env.DB.prepare(
        "ALTER TABLE posts_unavailable RENAME TO posts",
      ).run();
    }
    expect((await ready("/?q=sunrise")).posts).toHaveLength(10);
  });
  it("handles unexpected read defects safely and HEAD/OPTIONS/POST without granting writes", async () => {
    const broken: PageContext = {
      origin,
      runtime: () => Promise.resolve({ database: "available" }),
      search: () => Effect.die(new Error("secret exception")),
    };
    const result = await loadBrowsePage(new Request(origin), broken);
    expect(result.status).toBe(500);
    expect(JSON.stringify(result)).not.toContain("secret exception");
    expect((await call("/", env.DB, "POST")).status).toBe(405);
    for (const method of ["HEAD", "OPTIONS"]) {
      const response = await call("/", env.DB, method);
      expect(await response.text()).toBe("");
    }
  });
});

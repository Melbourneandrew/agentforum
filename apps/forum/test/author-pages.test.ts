import { readClient } from "../app/browsing/client-manifest";
import { env } from "cloudflare:workers";
import { Effect, Option, Schema } from "effect";
import { nanoid } from "nanoid";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  authorPageHeaders,
  authorPageSize,
  loadAuthorPage,
  type AuthorPageModel,
  type AuthorPageResponse,
} from "../app/authors/data.server";
import { authorHref, authorsHref, searchHref } from "../app/authors/links";
import { AuthorPage } from "../app/routes/authors";
import {
  AboutContent,
  loadAboutPage,
  precedents,
  researchSource,
} from "../app/routes/about";
import { AgentPageResult, PostPageResult } from "../src/api/contracts.js";
import { decodeSearch } from "../src/api/query.js";
import { makeForumStore } from "../src/database/store.js";
import { makeDispatcher } from "../src/runtime/dispatch.js";
import type { Execution, PageContext } from "../src/runtime/context.js";
import { migrate } from "./d1.js";

const origin = "https://author-pages.owner.workers.dev";
const execution: Execution = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
};
const identities: { readonly id: string; readonly name: string }[] = [];
const render = (model: AuthorPageModel) =>
  renderToStaticMarkup(h(AuthorPage, { model }));
const store = makeForumStore(env.DB);
const captures: AuthorPageResponse[] = [];
const app = makeDispatcher(async (request, forum) => {
  const url = new URL(request.url);
  if (url.pathname.replace(/\/$/, "") === "/about") {
    const invalid = loadAboutPage(request).invalid;
    return new Response(
      invalid ? "Invalid About page" : renderToStaticMarkup(h(AboutContent)),
      {
        status: invalid ? 400 : 200,
        headers: {
          ...authorPageHeaders,
          "Content-Type": "text/html; charset=utf-8",
        },
      },
    );
  }
  const name = url.pathname.split("/")[2];
  const observed = await loadAuthorPage(
    request,
    name === undefined || name === "" ? undefined : decodeURIComponent(name),
    forum,
  );
  captures.push(observed);
  return new Response(render(observed.model), {
    status: observed.status,
    headers: {
      ...authorPageHeaders,
      "Content-Type": "text/html; charset=utf-8",
    },
  });
});
const request = (path: string, method = "GET", db = env.DB) =>
  app.fetch(
    new Request(origin + path, { method }),
    { ...env, DB: db },
    execution,
  );
const model = async (path: string) => {
  captures.length = 0;
  await request(path);
  const result = captures.at(-1);
  if (result === undefined) throw new Error("No Authors response");
  return result;
};
const directory = async () => {
  const response = await request(
    searchHref({ resource: "agents", limit: 100 }),
  );
  expect(response.status).toBe(200);
  return Schema.decodeUnknownPromise(AgentPageResult)(await response.json());
};
const counts = async () =>
  Promise.all(
    ["agents", "credentials", "posts", "post_tags"].map((table) =>
      env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first("n"),
    ),
  );
beforeAll(async () => {
  await migrate();
  await migrate(env.ISOLATED_DB);
  for (let index = 0; index < 12; index++) {
    const identity = { id: nanoid(), name: `PublicAuthor${String(index)}` };
    await Effect.runPromise(
      store.createIdentity({
        ...identity,
        lookupId: nanoid(),
        digest: "a".repeat(64),
      }),
    );
    identities.push(identity);
  }
  for (const identity of identities.slice(0, 2))
    await Effect.runPromise(
      store.publish({
        authorId: identity.id,
        body: "publication-body-never-in-identity-page",
        tags: ["not-directory-data"],
        parentId: Option.none(),
      }),
    );
});

describe("real native D1 Authors pages", () => {
  it("renders public bounded directory in the live service's activity ordering", async () => {
    const expected = await directory();
    const result = await model(authorsHref());
    expect(result.status).toBe(200);
    if (result.model.kind !== "directory")
      throw new Error("Expected directory");
    expect(result.model.agents).toEqual(
      expected.agents.slice(0, authorPageSize),
    );
    expect(result.model.agents).toHaveLength(10);
    expect(
      result.model.agents
        .slice(0, 2)
        .every((agent) => agent.latestPublishingTime !== null),
    ).toBe(true);
    expect(
      result.model.agents
        .slice(2)
        .every((agent) => agent.latestPublishingTime === null),
    ).toBe(true);
    const html = render(result.model);
    expect(html).toContain("<h1>Authors</h1>");
    expect(html).toContain("No publishing activity");
    expect(html).not.toMatch(
      /publication-body-never|not-directory-data|href="\/posts\/|href="\/\?author=/,
    );
  });
  it("paginates using the returned real cursor and resets via First rather than inventing reverse tokens", async () => {
    const first = await model(authorsHref());
    if (first.model.kind !== "directory" || first.model.next === null)
      throw new Error("Expected bounded next page");
    const next = await model(first.model.next);
    if (next.model.kind !== "directory")
      throw new Error("Expected next directory");
    expect(next.model.agents).toEqual((await directory()).agents.slice(10));
    expect(next.model.agents).toHaveLength(2);
    expect(next.model.next).toBeNull();
    expect(render(next.model)).toContain('href="/authors">First Authors</a>');
    const response = await request(first.model.next);
    expect(response.headers.get("Cache-Control")).toBe("no-store, private");
  });
  it("looks up canonical names anonymously while displaying exact public identity casing and publishing time", async () => {
    const identity = identities[0];
    if (identity === undefined) throw new Error("Missing seed");
    const result = await model(authorHref(identity.name.toLowerCase()));
    expect(result.status).toBe(200);
    if (result.model.kind !== "identity") throw new Error("Expected identity");
    expect(result.model.agent.name).toBe(identity.name);
    expect(result.model.agent.latestPublishingTime).not.toBeNull();
    expect(Object.keys(result.model.agent).sort()).toEqual([
      "latestPublishingTime",
      "name",
      "posts",
    ]);
    const html = render(result.model);
    expect(html).toContain(identity.name);
    expect(html).toContain("<time");
    expect(html).not.toMatch(
      /credentials|lookup_id|digest|apiKey|created_at|<dt>(?:Rank|Reputation|Capabilities|Views|Read activity)/i,
    );
  });
  it("provides real same-installation author-filtered Post Retrieval requests, not missing UI routes", async () => {
    const identity = identities[0];
    if (identity === undefined) throw new Error("Missing seed");
    const result = await model(authorHref(identity.name));
    if (result.model.kind !== "identity") throw new Error("Expected identity");
    const href = searchHref(result.model.agent.posts);
    expect(new URL(href, origin).origin).toBe(origin);
    expect(new URL(href, origin).pathname).toBe("/v1/search");
    const response = await request(href);
    expect(response.status).toBe(200);
    const posts = await Schema.decodeUnknownPromise(PostPageResult)(
      await response.json(),
    );
    expect(posts.posts).toHaveLength(1);
    expect(posts.posts.every((post) => post.authorId === identity.id)).toBe(
      true,
    );
    expect(render(result.model)).toContain("(JSON API)</a>");
  });
  it("keeps never-published identities real and their author-filtered feed honestly empty", async () => {
    const identity = identities[3];
    if (identity === undefined) throw new Error("Missing seed");
    const result = await model(authorHref(identity.name));
    if (result.model.kind !== "identity") throw new Error("Expected identity");
    expect(result.model.agent.latestPublishingTime).toBeNull();
    expect(render(result.model)).toContain("No publishing activity");
    const response = await request(searchHref(result.model.agent.posts));
    expect(
      (await Schema.decodeUnknownPromise(PostPageResult)(await response.json()))
        .posts,
    ).toEqual([]);
  });
  it("distinguishes missing identity404 from invalid input400 and never claims an empty success", async () => {
    const missing = await request(authorHref("NoSuchLocalAuthor"));
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain("Author not found");
    const invalid = await request(authorHref("<script>unsafe</script>"));
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).not.toContain("<script>");
    expect(missing.headers.get("Cache-Control")).toBe("no-store, private");
  });
  it("renders an actual empty local directory from an independent migrated D1", async () => {
    const response = await request(authorsHref(), "GET", env.ISOLATED_DB);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(
      "No Authors on this directory page.",
    );
  });
  it("shows a genuine D1 failure503 with safe retry and no internal text", async () => {
    await env.ISOLATED_DB.prepare(
      "ALTER TABLE agents RENAME TO agents_unavailable",
    ).run();
    try {
      const response = await request(authorsHref(), "GET", env.ISOLATED_DB);
      expect(response.status).toBe(503);
      const html = await response.text();
      expect(html).toContain("Authors could not be loaded");
      expect(html).toContain('href="/authors">Try again</a>');
      expect(html).not.toMatch(/SQL|SELECT |stack|D1_ERROR|no such table/);
      expect(response.headers.get("Cache-Control")).toBe("no-store, private");
    } finally {
      await env.ISOLATED_DB.prepare(
        "ALTER TABLE agents_unavailable RENAME TO agents",
      ).run();
    }
    expect((await request(authorsHref(), "GET", env.ISOLATED_DB)).status).toBe(
      200,
    );
  });
  it("does not issue loopback HTTP or change identities, credentials, Posts or Tags on observation", async () => {
    const before = await counts();
    const network = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("No SSR loopback"));
    try {
      expect((await request(authorsHref())).status).toBe(200);
      expect((await request(authorHref("PublicAuthor0"))).status).toBe(200);
      expect((await request("/about")).status).toBe(200);
      expect(network).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
    }
    expect(await counts()).toEqual(before);
  });
  it("retains safe methods, API separation/CORS, strict CSP and rejects unrelated routes", async () => {
    for (const path of ["/authors", "/authors/PublicAuthor0", "/about"]) {
      expect((await request(path, "POST")).status).toBe(405);
      expect((await request(path, "OPTIONS")).status).toBe(204);
      const head = await request(path, "HEAD");
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
      expect(head.headers.get("Content-Security-Policy")).toContain(
        `script-src '${readClient.integrity}'`,
      );
      expect(head.headers.get("Content-Security-Policy")).toContain(
        "form-action 'self'",
      );
      expect(head.headers.has("Access-Control-Allow-Origin")).toBe(false);
    }
    for (const path of [
      "/authors/a/b",
      "/about/extra",
      "/unknown-public-page",
      "/authors/a/extra",
    ])
      expect((await request(path)).status).toBe(404);
    const api = await request(searchHref({ resource: "agents", limit: 10 }));
    expect(api.headers.get("Content-Type")).toBe("application/json");
    expect(api.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

describe("untrusted state and safe rendering boundaries", () => {
  it("rejects unsupported/duplicate/malformed state before querying", async () => {
    let reads = 0;
    const context: PageContext = {
      origin,
      runtime: () => Promise.resolve({ database: "available" }),
      search: () => {
        reads++;
        return Effect.die("No read allowed");
      },
    };
    for (const [name, suffix] of [
      [undefined, "?pageCursor="],
      [undefined, "?pageCursor=bad"],
      [undefined, "?pageCursor=x&pageCursor=y"],
      [undefined, "?order=oldest"],
      ["PublicAuthor0", "?pageCursor=x"],
      ["PublicAuthor0", "?profile=x"],
      ["bad/name", ""],
    ] as const) {
      expect(
        (
          await loadAuthorPage(
            new Request(origin + "/authors" + suffix),
            name,
            context,
          )
        ).status,
      ).toBe(400);
    }
    expect(reads).toBe(0);
  });
  it("contains undeclared defects without exposing private errors", async () => {
    const context: PageContext = {
      origin,
      runtime: () => Promise.resolve({ database: "available" }),
      search: () => Effect.die(new Error("private database credential")),
    };
    const result = await loadAuthorPage(
      new Request(origin + "/authors"),
      undefined,
      context,
    );
    expect(result.status).toBe(500);
    expect(render(result.model)).not.toContain("private database credential");
  });
  it("escapes hostile identity text even at the typed-port presentation boundary", async () => {
    // Deliberate typed-port injection, not a claim that registration permits this name.
    const context: PageContext = {
      origin,
      runtime: () => Promise.resolve({ database: "available" }),
      search: () =>
        Effect.succeed({
          resource: "agents",
          agent: {
            name: '<img src=x onerror="alert(1)">',
            latestPublishingTime: null,
            posts: { resource: "posts", author: "A".repeat(21) },
          },
        }),
    };
    const result = await loadAuthorPage(
      new Request(origin + "/authors/PublicAuthor0"),
      "PublicAuthor0",
      context,
    );
    expect(render(result.model)).toContain("&lt;img");
    expect(render(result.model)).not.toMatch(/<img|<script|<form|<iframe/);
  });
  it("keeps About public, research-grounded and limited to exact existing evidence links", () => {
    const html = renderToStaticMarkup(h(AboutContent));
    expect(html).toContain(researchSource);
    expect(precedents).toHaveLength(8);
    expect(precedents.map((item) => item.evidence)).toEqual([
      "https://openai.com/index/hugging-face-incident-and-the-road-ahead/",
      "https://collusion.wiki/",
      "https://www.moltbook.com/",
      "https://arxiv.org/abs/2602.13458",
      "https://agora.burmaster.com/",
      "https://github.com/1f916-ai/1f916",
      "https://arxiv.org/abs/2304.03442",
      "https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/SPEC.md",
    ]);
    expect(html).toContain("human landing and read-only observation surface");
    expect(html).toContain("does not require OKF");
    expect(html).toContain("noreferrer noopener");
    expect(html).not.toMatch(
      /<form|<script|<iframe|<img|prefetch|href="\/v1\/(?:register|publish)|href="\/\?author=/,
    );
    expect(loadAboutPage(new Request(origin + "/about")).invalid).toBe(false);
  });
  it("rejects About query state and performs no data access for valid About", async () => {
    expect((await request("/about?profile=x")).status).toBe(400);
    let reads = 0;
    const noData = makeDispatcher((request) => {
      const result = loadAboutPage(request);
      return Promise.resolve(
        new Response(renderToStaticMarkup(h(AboutContent)), {
          status: result.invalid ? 400 : 200,
          headers: authorPageHeaders,
        }),
      );
    });
    const db = {
      ...env,
      get DB(): typeof env.DB {
        reads++;
        throw new Error("About must not read D1");
      },
    };
    expect(
      (await noData.fetch(new Request(origin + "/about"), db, execution))
        .status,
    ).toBe(200);
    expect(reads).toBe(0);
    expect(
      (
        await Effect.runPromise(
          decodeSearch({ resource: "agents", name: "PublicAuthor0" }),
        )
      ).resource,
    ).toBe("agents");
  });
});

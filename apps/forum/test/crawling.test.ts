import { describe, expect, it } from "vitest";
import { headDescriptors, publicHead } from "../src/crawling/head";
import { fixedPublicPaths, preferredPath } from "../src/crawling/resources";

const origin = "https://forum.owner.workers.dev";
describe("owned public metadata", () => {
  it("uses registered paths and exact public casing without URL state", () => {
    expect(publicHead(origin, { kind: "posts" }).canonical).toBe(origin + "/");
    expect(
      publicHead(origin, { kind: "post", id: "A".repeat(21) }).canonical,
    ).toBe(origin + "/posts/" + "A".repeat(21));
    expect(
      publicHead(origin, { kind: "identity", name: "RegisteredName" })
        .canonical,
    ).toBe(origin + "/authors/RegisteredName");
    expect(publicHead(origin, { kind: "authors" }).canonical).toBe(
      origin + "/authors",
    );
    expect(publicHead(origin, { kind: "about" }).canonical).toBe(
      origin + "/about",
    );
  });
  it("links supported raw Docs to the existing HTML resource only", () => {
    const head = publicHead(origin, {
      kind: "document",
      path: "/docs/publication.md",
    });
    expect(head.canonical).toBe(origin + "/docs/publication/");
    expect(head.representations).toEqual([
      { href: origin + "/docs/publication.md", type: "text/markdown" },
    ]);
    expect(
      publicHead(origin, { kind: "post", id: "A".repeat(21) }).representations,
    ).toEqual([]);
  });
  it("rejects malformed resource identifiers and unsupported representations", () => {
    for (const id of [
      "short",
      "A".repeat(21) + "?payload=x",
      "A".repeat(21) + "#x",
    ])
      expect(() => preferredPath({ kind: "post", id })).toThrow();
    for (const name of [
      "name/query",
      "name?credential=x",
      "--name",
      "<script>",
    ])
      expect(() => preferredPath({ kind: "identity", name })).toThrow();
    expect(() =>
      preferredPath({ kind: "document", path: "/v1/search?payload=x" }),
    ).toThrow();
  });
  it("has no mutation, cursor, payload or static build-resource inventory", () => {
    expect(fixedPublicPaths).not.toContain("/v1/register");
    expect(fixedPublicPaths).not.toContain("/v1/publish");
    expect(fixedPublicPaths.every((path) => !/[?#]/.test(path))).toBe(true);
    expect(
      fixedPublicPaths.every((path) => !/\.(?:css|js|ttf)$/.test(path)),
    ).toBe(true);
  });
  it("supports absence/removal and custom installation origins without another host policy", () => {
    const custom = publicHead("https://custom.example", { kind: "posts" });
    expect(custom.canonical).toBe("https://custom.example/");
    expect(
      headDescriptors({
        ...custom,
        description: null,
        canonical: null,
        representations: [],
      }),
    ).toEqual([{ title: "Posts · Agent Forum" }]);
  });
});

import { env } from "cloudflare:workers";
import { Effect, Option } from "effect";
import { beforeAll, inject } from "vitest";
import { makeCrawlerStore } from "../src/crawling/store";
import {
  crawlerResponse,
  fixedSitemap,
  robotsText,
  sitemapByteLimit,
  sitemapIndex,
  sitemapPage,
} from "../src/crawling/responses";
import { problemCatalog } from "../src/api/problems";
import { problemDocuments } from "../src/crawling/resources";
import { migrate } from "./d1";

const db = env.ISOLATED_DB;
const sequences = [
  "1",
  "1001",
  "9007199254740993",
  "9007199254740995",
  "9223372036854775807",
];
const postIds = sequences.map((_, index) => String(index).repeat(21));
beforeAll(async () => {
  await migrate();
  // Genuine native D1 fixture before immutable server-fact guards, then all migrations.
  await db
    .prepare("CREATE TABLE IF NOT EXISTS d1_migrations(name TEXT PRIMARY KEY)")
    .run();
  for (const migration of inject("migrations").slice(0, 2))
    await db.batch([
      ...migration.queries.map((sql) => db.prepare(sql)),
      db
        .prepare("INSERT INTO d1_migrations(name) VALUES (?)")
        .bind(migration.name),
    ]);
  for (const [index, name] of [
    "ZuluAuthor",
    "alphaAuthor",
    "NeverPosted",
  ].entries())
    await db
      .prepare("INSERT INTO agents(id,name) VALUES (?,?)")
      .bind(String(index + 7).repeat(21), name)
      .run();
  for (const [index, sequence] of sequences.entries())
    await db
      .prepare(
        "INSERT INTO posts(publication_order,id,author_id,body,published_at) VALUES(CAST(? AS INTEGER),?,?,?,'2026-11-26T00:00:00.000Z')",
      )
      .bind(sequence, postIds[index], "7".repeat(21), "not selected by crawler")
      .run();
  await migrate(db);
});
describe("real D1 minimal crawler enumeration", () => {
  it("enumerates every Post exactly once across native keyset pages, gaps and signed64 maximum", async () => {
    const store = makeCrawlerStore(db);
    const found: string[] = [];
    let after = "0";
    for (;;) {
      const page = await Effect.runPromise(
        store.postRange(after, "9223372036854775807", 2),
      );
      expect(page.posts.length).toBeLessThanOrEqual(2);
      for (const post of page.posts) {
        expect(Object.keys(post).sort()).toEqual([
          "id",
          "publicationOrder",
          "publishedAt",
        ]);
        found.push(post.id);
      }
      if (!page.hasMore) break;
      const last = page.posts.at(-1);
      if (!last) throw new Error("Missing boundary");
      after = last.publicationOrder;
    }
    expect(found).toEqual(postIds);
    expect(new Set(found).size).toBe(postIds.length);
  });
  it("seeks across enormous empty ranges without sequence loops or rounding", async () => {
    const store = makeCrawlerStore(db);
    const result = await Effect.runPromise(store.nextPost("1001"));
    expect(Option.isSome(result) && result.value.publicationOrder).toBe(
      "9007199254740993",
    );
    const empty = await Effect.runPromise(
      store.postRange("1001", "9007199254740992"),
    );
    expect(empty).toEqual({ posts: [], hasMore: false });
    expect(
      Option.isNone(
        await Effect.runPromise(store.nextPost("9223372036854775807")),
      ),
    ).toBe(true);
  });
  it("includes never-posted identities with exact names and indexed keyset continuation", async () => {
    const store = makeCrawlerStore(db);
    let after = Option.none<string>();
    const names: string[] = [];
    for (;;) {
      const page = await Effect.runPromise(store.identities(after, 1));
      names.push(...page.agents.map((agent) => agent.name));
      if (!page.hasMore) break;
      after = page.after;
    }
    expect(names).toEqual(["alphaAuthor", "NeverPosted", "ZuluAuthor"]);
  });
  it("rejects invalid bounds/limits before reading and preserves installation isolation", async () => {
    const store = makeCrawlerStore(db);
    for (const after of ["-1", "01", "9223372036854775808", "1 OR 1=1"]) {
      const result = await Effect.runPromise(
        store.nextPost(after).pipe(Effect.either),
      );
      expect(result._tag).toBe("Left");
    }
    expect(
      (
        await Effect.runPromise(
          store.postRange("0", "1", 1001).pipe(Effect.either),
        )
      )._tag,
    ).toBe("Left");
    expect(
      (
        await Effect.runPromise(
          store.identities(Option.some("invalid/name")).pipe(Effect.either),
        )
      )._tag,
    ).toBe("Left");
    expect(
      await Effect.runPromise(
        makeCrawlerStore(env.DB).postRange("0", "9223372036854775807"),
      ),
    ).toEqual({ posts: [], hasMore: false });
  });
});
describe("complete-page crawler format boundaries", () => {
  it("enumerates fixed deployed docs/discovery and authoritative problem documents", () => {
    const expected = Object.keys(problemCatalog)
      .map((key) => `/docs/problems/${key}.json`)
      .sort();
    expect(
      problemDocuments.filter((path) => path.endsWith(".json")).sort(),
    ).toEqual(expected);
    const xml = fixedSitemap(origin);
    for (const path of fixedPublicPaths)
      expect(xml).toContain(`<loc>${origin}${path}</loc>`);
    expect(xml).not.toMatch(
      /register|publish|payload=|Cursor=|first-party|\.css|\.ttf/,
    );
  });
  it("fails closed at exact XML byte and URL-count limits without truncating", () => {
    const entries = [{ path: "/" }];
    const xml = sitemapPage(origin, entries);
    const bytes = new TextEncoder().encode(xml).byteLength;
    expect(sitemapPage(origin, entries, bytes)).toBe(xml);
    expect(() => sitemapPage(origin, entries, bytes - 1)).toThrow();
    expect(() =>
      sitemapPage(
        origin,
        Array.from({ length: 50_001 }, () => entries[0] ?? { path: "/" }),
      ),
    ).toThrow();
    expect(() =>
      sitemapIndex(origin, ["/sitemaps/fixed.xml"], sitemapByteLimit + 1),
    ).toThrow();
    const fullIndexPaths = Array.from(
      { length: 50_000 },
      (_, index) => `/sitemaps/posts-0-${String(index + 1)}.xml`,
    );
    expect(
      (sitemapIndex(origin, fullIndexPaths).match(/<sitemap>/g) ?? []).length,
    ).toBe(50_000);
    expect(() =>
      sitemapIndex(origin, [...fullIndexPaths, "/sitemaps/fixed.xml"]),
    ).toThrow();
    expect(() => sitemapIndex(origin, ["/sitemaps/index.xml"])).toThrow();
    const index = sitemapIndex(origin, ["/sitemaps/fixed.xml"]);
    expect(() =>
      sitemapIndex(
        origin,
        ["/sitemaps/fixed.xml"],
        new TextEncoder().encode(index).byteLength - 1,
      ),
    ).toThrow();
  });
  it("excludes unsupported, sensitive, cursor, payload and mutation locations", () => {
    for (const path of [
      "/v1/register",
      "/v1/publish",
      "/v1/search?payload=x",
      "/?q=secret",
      "/authors?pageCursor=x",
      "//external.example/",
      "/docs/index.md",
      "/unlisted",
    ])
      expect(() => sitemapPage(origin, [{ path }])).toThrow();
    expect(() =>
      sitemapPage(origin, [{ path: "/", lastmod: "generation-time" }]),
    ).toThrow();
  });
  it("provides standard multiple-index robots discovery, origin isolation and safe HEAD", async () => {
    const body = robotsText(origin, ["/sitemap.xml", "/sitemap-posts.xml"]);
    expect(body).toContain("Disallow: /v1/register\nDisallow: /v1/publish\n");
    expect(body).toContain(`Sitemap: ${origin}/sitemap-posts.xml`);
    expect(
      robotsText("https://custom.example", ["/sitemap.xml"]),
    ).not.toContain(origin);
    const response = crawlerResponse(body, "robots", true);
    expect(await response.text()).toBe("");
    expect(response.headers.get("Content-Type")).toBe(
      "text/plain; charset=utf-8",
    );
    expect(() => sitemapIndex(origin, ["/sitemap.xml"])).toThrow();
    expect(() =>
      sitemapIndex(origin, ["/sitemaps/fixed.xml", "/sitemaps/fixed.xml"]),
    ).toThrow();
  });
});

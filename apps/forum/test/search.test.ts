import { env } from "cloudflare:workers";
import { Effect, Encoding, Option, Schema } from "effect";
import { nanoid } from "nanoid";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { PostPageResult, RelevancePageResult } from "../src/api/contracts.js";
import { decodeCursor } from "../src/api/query.js";
import { makeForumStore } from "../src/database/store.js";
import { makeDispatcher } from "../src/runtime/dispatch.js";
import type { Execution } from "../src/runtime/context.js";
import {
  hasUnicode61Token,
  unicode61TokenStarts,
} from "../src/queries/unicode61.js";
import { compileTextQuery } from "../src/queries/text.js";
import { migrate } from "./d1.js";
const origin = "https://search.owner.workers.dev";
const execution: Execution = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
};
const app = makeDispatcher(() => Promise.resolve(new Response("read only")));
const search = (input: unknown, method = "POST", db = env.DB) => {
  const source = JSON.stringify(input);
  return app.fetch(
    new Request(
      origin +
        "/v1/search" +
        (method === "GET" ? "?payload=" + encodeURIComponent(source) : ""),
      {
        method,
        headers: { "Content-Type": "application/json" },
        ...(method === "POST" ? { body: source } : {}),
      },
    ),
    { ...env, DB: db },
    execution,
  );
};
const page = async (input: unknown, method = "POST", db = env.DB) => {
  const response = await search(input, method, db);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store, private");
  return Schema.decodeUnknownPromise(PostPageResult)(await response.json());
};
const agent = async () => {
  const id = nanoid();
  await Effect.runPromise(
    makeForumStore(env.DB).createIdentity({
      id,
      name: "Agent" + nanoid().replace(/[_-]/g, "0"),
      lookupId: nanoid(),
      digest: "a".repeat(64),
    }),
  );
  return id;
};
const publish = (
  authorId: string,
  body = "unchanged raw body",
  tags: readonly string[] = [],
  parentId: Option.Option<string> = Option.none(),
) =>
  Effect.runPromise(
    makeForumStore(env.DB).publish({ authorId, body, tags, parentId }),
  );
const cursor = (token: string) => Effect.runPromise(decodeCursor(token));
const ids = (value: typeof PostPageResult.Type) =>
  value.posts.map((post) => post.id);
beforeAll(async () => {
  await migrate();
  await migrate(env.ISOLATED_DB);
});
const relevance = async (input: object, method = "POST") => {
  const response = await search({ ...input, order: "relevance" }, method);
  expect(response.status).toBe(200);
  const json: unknown = await response.json();
  expect(json).not.toHaveProperty("readCursor");
  return Schema.decodeUnknownPromise(RelevancePageResult)(json);
};
describe("native D1 FTS5 and exact combined Post selection", () => {
  it("matches the native tokenizer at every generated range boundary and neighbor, independently of production corpus", async () => {
    const db = env.ISOLATED_DB;
    await db
      .prepare(
        "CREATE VIRTUAL TABLE unicode_oracle USING fts5(body, tokenize='unicode61')",
      )
      .run();
    const points = new Set<number>([
      0, 0x301, 0x1ab0, 0xe000, 0x1f600, 0x1fae0, 0x10ffff,
    ]);
    for (const [low, high] of unicode61TokenStarts)
      for (const point of [low - 1, low, high, high + 1])
        if (
          point >= 0 &&
          point <= 0x10ffff &&
          !(point >= 0xd800 && point <= 0xdfff)
        )
          points.add(point);
    // Deterministic interior sampling complements every range endpoint/gap.
    for (let n = 0; n < 4096; n++) {
      const point = (n * 104729) % 0x110000;
      if (!(point >= 0xd800 && point <= 0xdfff)) points.add(point);
    }
    // Native corpus has exactly the scalar being checked. MATCH self-hit is a
    // tokenizer oracle in TEST ONLY, never runtime validation or user search.
    const inputs = [...points].map((point) => String.fromCodePoint(point));
    for (let start = 0; start < inputs.length; start += 50) {
      const chunk = inputs.slice(start, start + 50);
      await db.batch(
        chunk.map((body, n) =>
          db
            .prepare("INSERT INTO unicode_oracle(rowid,body) VALUES (?,?)")
            .bind(start + n + 1, body),
        ),
      );
      const results = await db.batch<{ doc: number }>(
        chunk.map((body, n) =>
          db
            .prepare(
              "SELECT rowid AS doc FROM unicode_oracle WHERE rowid=? AND unicode_oracle MATCH ?",
            )
            .bind(
              start + n + 1,
              '"' + body.replaceAll('"', '""').replaceAll("\0", " ") + '"',
            ),
        ),
      );
      for (const [n, result] of results.entries()) {
        const body = chunk[n];
        expect(body).toBeDefined();
        if (body !== undefined)
          expect(
            hasUnicode61Token(body),
            `U+${(body.codePointAt(0) ?? 0).toString(16)}: ${JSON.stringify(result)}`,
          ).toBe(result.results.some((row) => row.doc === start + n + 1));
      }
    }
  }, 30000);
  it("uses exact all/any/empty/deduplicated binary Tags without join duplicates", async () => {
    const author = await agent();
    const a = await publish(author, "one", [
      " A ",
      "a",
      "x:y/z",
      "é",
      "e\u0301",
      "' OR 1=1 --",
    ]);
    const b = await publish(author, "two", ["a"]);
    const c = await publish(author, "three", ["A"]);
    for (const method of ["GET", "POST"]) {
      expect(
        ids(await page({ author, tags: ["a", " A ", "a"] }, method)),
      ).toEqual([a.id]);
      expect(
        ids(await page({ author, tags: ["A", "a"], tagMatch: "any" }, method)),
      ).toEqual([c.id, b.id, a.id]);
      expect(
        ids(await page({ author, tags: [], tagMatch: "any" }, method)),
      ).toEqual([c.id, b.id, a.id]);
      for (const tag of ["x:y/z", "é", "e\u0301", "' OR 1=1 --"])
        expect(ids(await page({ author, tags: [tag] }, method))).toEqual([
          a.id,
        ]);
      expect((await page({ author, tags: [" a "] }, method)).posts).toEqual([]);
    }
  });
  it("ANDs all conditions, searches full raw Markdown/code/links only, and returns complete facts", async () => {
    const author = await agent();
    const other = await agent();
    const root = await publish(author);
    const body =
      "---\nordinary: frontmatter\n---\n```ts\nconst Needle = 'café';\n```\n[alpha beta](https://example.test/targetword)\nOR NOT NEAR";
    const wanted = await publish(
      author,
      body,
      ["opaque", "z"],
      Option.some(root.id),
    );
    await publish(other, body, ["opaque"], Option.some(root.id));
    await publish(author, body, ["opaque"], Option.some(wanted.id));
    await publish(
      author,
      "no text tokens",
      ["needle", "opaque"],
      Option.some(root.id),
    );
    for (const method of ["GET", "POST"]) {
      for (const q of [
        'NEEDLE "alpha beta"',
        "cafe targetword",
        "OR NOT NEAR",
        "ordinary frontmatter",
      ])
        expect(
          (await page({ author, parent: root.id, tags: ["opaque"], q }, method))
            .posts,
        ).toEqual([
          {
            id: wanted.id,
            authorId: wanted.authorId,
            body: wanted.body,
            tags: wanted.tags,
            publicationOrder: wanted.publicationOrder,
            publishedAt: wanted.publishedAt,
            reply_to: root.id,
          },
        ]);
      expect(
        (await page({ author, parent: root.id, q: '"beta alpha"' }, method))
          .posts,
      ).toEqual([]);
      expect(
        (await page({ author, parent: root.id, q: "need" }, method)).posts,
      ).toEqual([]);
      expect(
        (await page({ author, parent: root.id, q: "opaque" }, method)).posts,
      ).toEqual([]);
    }
  });
  it("quotes operator/injection-looking text literally and delegates punctuation/folding to native FTS", async () => {
    const author = await agent();
    const a = await publish(author, "alpha OR beta café foo bar x y body NEAR");
    await publish(author, "alpha beta");
    for (const method of ["GET", "POST"]) {
      for (const q of [
        "alpha OR beta",
        "CAFÉ",
        '"foo-bar"',
        "x/y",
        "NEAR",
        "body:NEAR",
      ])
        expect(ids(await page({ author, q }, method))).toEqual([a.id]);
      for (const q of [
        "alpha OR nonexisting",
        "alpha*nonexisting",
        '" OR 1=1 --"',
      ])
        expect((await page({ author, q }, method)).posts).toEqual([]);
    }
    expect(await Effect.runPromise(compileTextQuery("OR NOT"))).toBe(
      '"OR" AND "NOT"',
    );
  });
  it("rejects every tokenless clause before D1, including punctuation and combining marks; accepts private-use/unassigned native tokens even in empty DB", async () => {
    for (const method of ["GET", "POST"]) {
      for (const q of [
        "",
        " ",
        '"unclosed',
        'word"quote',
        '"phrase"tail',
        "!!!",
        "\u0301",
        "\ufffe",
        "\uffff",
        '"---"',
        "valid !!!",
        '"\u0301" valid',
        "😀",
        "\0",
        "a".repeat(2049),
        "é".repeat(1025),
        Array(33).fill("word").join(" "),
      ]) {
        const prepares = vi.spyOn(env.DB, "prepare");
        const response = await search({ q }, method);
        expect(response.status, JSON.stringify(q)).toBe(400);
        expect(prepares).not.toHaveBeenCalled();
        prepares.mockRestore();
        expect(response.headers.get("Content-Type")).toContain(
          "application/problem+json",
        );
        expect(await response.text()).not.toContain("readCursor");
      }
      for (const q of [
        "\u1ab0",
        "\ue000",
        "\u{1fae0}",
        "\u{10ffff}",
        "brandnewword",
        "a".repeat(2048),
        "é".repeat(1024),
        Array(32).fill("word").join(" "),
      ]) {
        const response = await search({ q }, method, env.ISOLATED_DB);
        expect(response.status, JSON.stringify(q)).toBe(200);
        expect(
          (
            await Schema.decodeUnknownPromise(PostPageResult)(
              await response.json(),
            )
          ).posts,
        ).toEqual([]);
      }
    }
    const author = await agent();
    const a = await publish(author, "a\0b");
    expect(ids(await page({ author, q: '"a\0b"' }))).toEqual([a.id]);
  });
  it("uses native BM25 ascending, ties newest sequence, separate relevance offsets and no Read Cursor", async () => {
    const author = await agent();
    const a = await publish(author, "rankword");
    const b = await publish(author, "rankword " + "filler ".repeat(50));
    const c = await publish(author, "rankword");
    const expected = await env.DB.prepare(
      "SELECT posts.id,bm25(post_fts) AS score FROM posts JOIN post_fts ON post_fts.rowid=posts.publication_order WHERE author_id=? AND post_fts MATCH ? ORDER BY score ASC,publication_order DESC,posts.id COLLATE BINARY ASC",
    )
      .bind(author, '"rankword"')
      .all();
    expect(expected.results.map((row) => row.id)).toEqual([c.id, a.id, b.id]);
    const first = await relevance({ author, q: "rankword", limit: 1 }, "GET");
    expect(first.posts.map((post) => post.id)).toEqual([c.id]);
    expect(await cursor(first.pageCursor ?? "")).toMatchObject({
      order: "relevance",
      offset: 1,
      purpose: "page",
    });
    const second = await relevance({
      author,
      q: "rankword",
      pageCursor: first.pageCursor,
      limit: 2,
    });
    expect(second.posts.map((post) => post.id)).toEqual([a.id, b.id]);
    expect(second.pageCursor).toBeNull();
    expect((await relevance({ author, q: "absent" })).posts).toEqual([]);
    const chrono = await page({ author, q: "rankword", limit: 1 });
    for (const input of [
      { author, q: "rankword", readCursor: first.pageCursor },
      { author, q: "rankword", pageCursor: first.pageCursor },
      {
        author,
        q: "rankword",
        order: "relevance",
        pageCursor: chrono.pageCursor,
      },
      {
        author,
        q: "rankword",
        order: "relevance",
        readCursor: chrono.readCursor,
      },
      { resource: "agents", pageCursor: first.pageCursor },
      {
        author,
        q: "different",
        order: "relevance",
        pageCursor: first.pageCursor,
      },
    ])
      expect((await search(input)).status).toBe(400);
    const envelope = await cursor(first.pageCursor ?? "");
    for (const offset of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1])
      expect(
        (
          await search({
            author,
            q: "rankword",
            order: "relevance",
            pageCursor: Encoding.encodeBase64Url(
              JSON.stringify({ ...envelope, offset }),
            ),
          })
        ).status,
      ).toBe(400);
  });
  it("keeps filtered keysets stable during appends, binds normalized Tags/clauses and drains only returned unread matches", async () => {
    const author = await agent();
    const selection = { author, tags: [" B ", "a"], q: 'keyword "alpha beta"' };
    const initial = await page(selection);
    const originals = [];
    for (let n = 0; n < 5; n++)
      originals.push(await publish(author, "keyword alpha beta", ["a", " B "]));
    await publish(author, "nonmatch", ["a", " B "]);
    const first = await page({ ...selection, limit: 2 }, "GET");
    const concurrent = await publish(author, "keyword alpha beta", [
      " B ",
      "a",
    ]);
    const older = await page({
      ...selection,
      tags: ["a", " B ", "a"],
      q: ' keyword   "alpha   beta" ',
      pageCursor: first.pageCursor,
      limit: 100,
    });
    expect([...ids(first), ...ids(older)]).toEqual(
      originals.map((post) => post.id).reverse(),
    );
    let token = initial.readCursor;
    const seen: string[] = [];
    for (let n = 0; n < 3; n++) {
      const result = await page(
        { ...selection, readCursor: token, limit: 2 },
        n % 2 ? "GET" : "POST",
      );
      seen.push(...ids(result));
      token = result.readCursor;
      expect(await cursor(token)).toMatchObject({
        boundary: { sequence: result.posts.at(-1)?.publicationOrder },
      });
    }
    expect(seen).toEqual([...originals, concurrent].map((post) => post.id));
    await publish(author, "unmatched append", ["a", " B "]);
    expect((await page({ ...selection, readCursor: token })).readCursor).toBe(
      token,
    );
    for (const change of [
      { tags: ["a"] },
      { tagMatch: "any" },
      { q: "keyword" },
      { author: nanoid() },
      { parent: nanoid() },
    ])
      expect(
        (await search({ ...selection, ...change, readCursor: token })).status,
      ).toBe(400);
  });
  it("returns100 complete filtered FTS results in exactly two bounded reads, with default50", async () => {
    const authors = [await agent(), await agent()];
    const root = await publish(authors[0] ?? "");
    for (let n = 0; n < 100; n++)
      await publish(
        authors[n % 2] ?? "",
        `completeword full raw body ${String(n)}`,
        ["second", "first"],
        Option.some(root.id),
      );
    const selection = {
      parent: root.id,
      tags: ["first", "second", "first"],
      q: "completeword",
    };
    expect((await page(selection)).posts).toHaveLength(50);
    for (const order of ["newest", "oldest", "relevance"]) {
      const prepares = vi.spyOn(env.DB, "prepare");
      const response = await search({ ...selection, order, limit: 100 }, "GET");
      expect(response.status).toBe(200);
      expect(prepares).toHaveBeenCalledTimes(2);
      prepares.mockRestore();
      const result = await Schema.decodeUnknownPromise(RelevancePageResult)(
        await response.json(),
      );
      expect(result.posts).toHaveLength(100);
      expect(
        result.posts.every(
          (post) =>
            post.body.startsWith("completeword full raw body") &&
            post.reply_to === root.id &&
            post.tags.join(",") === "second,first",
        ),
      ).toBe(true);
    }
  });
  it("reports real FTS/index resource failure without reflecting SQL, input or advanced checkpoint; isolates installations", async () => {
    const author = await agent();
    const selection = { author, q: "failureword", tags: ["private-filter"] };
    const initial = await page(selection);
    await publish(author, "failureword", ["private-filter"]);
    expect((await page(selection, "GET", env.ISOLATED_DB)).posts).toEqual([]);
    await env.DB.prepare(
      "ALTER TABLE post_fts RENAME TO unavailable_fts",
    ).run();
    try {
      for (const method of ["GET", "POST"]) {
        const response = await search(
          { ...selection, readCursor: initial.readCursor },
          method,
        );
        expect(response.status).toBe(503);
        const body = await response.text();
        for (const secret of [
          "readCursor",
          "pageCursor",
          "post_fts",
          "SELECT",
          "failureword",
          "private-filter",
        ])
          expect(body).not.toContain(secret);
      }
    } finally {
      await env.DB.prepare(
        "ALTER TABLE unavailable_fts RENAME TO post_fts",
      ).run();
    }
    expect(
      (await page({ ...selection, readCursor: initial.readCursor })).posts,
    ).toHaveLength(1);
  });
  it("preserves strict modes, limits, and GET encoded URL rejection", async () => {
    for (const method of ["GET", "POST"]) {
      for (const input of [
        { metadata: {} },
        { filters: { tags: ["a"] } },
        { "metadata.x": 1 },
        { order: "relevance" },
        { id: nanoid(), q: "a" },
        { q: "a", limit: 101 },
        { q: "a", tags: Array(33).fill("a") },
      ])
        expect((await search(input, method)).status).toBe(400);
    }
    const tooLarge = {
      tags: Array.from({ length: 32 }, (_, n) => "é".repeat(60) + String(n)),
      q: "é".repeat(1024),
    };
    const response = await search(tooLarge, "GET");
    expect(response.status).toBe(413);
    expect(await response.text()).toContain("POST");
    expect((await search(tooLarge, "POST")).status).toBe(200);
  });
});

import { env } from "cloudflare:workers";
import { Effect, Encoding, Layer, Option, Schema } from "effect";
import { nanoid } from "nanoid";
import { beforeAll, describe, expect, inject, it, vi } from "vitest";
import { PostLookupResult, PostPageResult } from "../src/api/contracts.js";
import { decodeCursor, decodeSearch } from "../src/api/query.js";
import { ForumQueries } from "../src/api/services.js";
import { makeForumStore, StorageFailure } from "../src/database/store.js";
import { makeQueryStore, QueryStore } from "../src/queries/store.js";
import { forumQueriesLayer } from "../src/queries/service.js";
import { makeDispatcher } from "../src/runtime/dispatch.js";
import { requestLayer, type Execution } from "../src/runtime/context.js";
import { migrate } from "./d1.js";
const origin = "https://retrieval.owner.workers.dev";
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
const tiedAuthor = nanoid();
const tiedSequences = [
  "9007199254740993",
  "9007199254740995",
  "9007199254741021",
];
beforeAll(async () => {
  await migrate();
  // A real prior D1 schema fixture, before immutable/server-fact guards.
  const db = env.ISOLATED_DB;
  await db
    .prepare("CREATE TABLE IF NOT EXISTS d1_migrations(name TEXT PRIMARY KEY)")
    .run();
  for (const migration of inject("migrations").slice(0, 2)) {
    await db.batch([
      ...migration.queries.map((sql) => db.prepare(sql)),
      db
        .prepare("INSERT INTO d1_migrations(name) VALUES (?)")
        .bind(migration.name),
    ]);
  }
  const author = tiedAuthor;
  await db
    .prepare("INSERT INTO agents(id,name) VALUES (?,?)")
    .bind(author, "TiedTimeFixture")
    .run();
  const sequences = tiedSequences;
  const posts = sequences.map(() => nanoid());
  for (const [index, sequence] of sequences.entries())
    await db
      .prepare(
        "INSERT INTO posts(publication_order,id,author_id,body,published_at) VALUES(CAST(? AS INTEGER),?,?,?,'2000-01-01T00:00:00.000Z')",
      )
      .bind(sequence, posts[index], author, "retained body")
      .run();
  await migrate(db);
});
describe("native D1 public chronological retrieval", () => {
  it("returns an empty feed and distinct before-first checkpoint, including repeated empty polling", async () => {
    const author = await agent();
    const first = await page({ author });
    expect(first.posts).toEqual([]);
    expect(first.pageCursor).toBeNull();
    expect(await cursor(first.readCursor)).toMatchObject({
      purpose: "read",
      order: "oldest",
      boundary: { sequence: "0" },
    });
    expect("id" in (await cursor(first.readCursor))).toBe(false);
    const empty = await page({ author, readCursor: first.readCursor }, "GET");
    expect(empty.readCursor).toBe(first.readCursor);
    const accepted = await publish(author);
    expect(ids(await page({ author, readCursor: empty.readCursor }))).toEqual([
      accepted.id,
    ]);
  });
  it("looks up complete opaque bodies/Tags/facts publicly through equivalent GET and POST; missing is404", async () => {
    const author = await agent();
    const stored = await publish(
      author,
      "---\nfrontmatter: ordinary\n---\n\0😀",
      [" A ", "a", "x:y/z", "é", "e\u0301"],
    );
    for (const method of ["GET", "POST"]) {
      const response = await search({ id: stored.id }, method);
      expect(response.status).toBe(200);
      const result = await Schema.decodeUnknownPromise(PostLookupResult)(
        await response.json(),
      );
      expect(result.post).toEqual({
        id: stored.id,
        authorId: author,
        body: stored.body,
        tags: stored.tags,
        reply_to: null,
        publicationOrder: stored.publicationOrder,
        publishedAt: stored.publishedAt,
      });
      expect((await search({ id: nanoid() }, method)).status).toBe(404);
    }
  });
  it("uses newest default/explicit oldest and strict keyset continuation under concurrent appends", async () => {
    const author = await agent();
    const originals = [];
    for (let n = 0; n < 5; n++) originals.push(await publish(author));
    const first = await page({ author, limit: 2 }, "GET");
    expect(ids(first)).toEqual(
      originals
        .slice(-2)
        .reverse()
        .map((post) => post.id),
    );
    expect(first.pageCursor).not.toBeNull();
    const checkpoint = await cursor(first.readCursor);
    expect(checkpoint).toMatchObject({
      boundary: { sequence: originals.at(-1)?.publicationOrder },
    });
    const additions = await Promise.all([publish(author), publish(author)]);
    const second = await page({
      author,
      limit: 1,
      pageCursor: first.pageCursor,
    });
    const third = await page(
      { author, limit: 100, pageCursor: second.pageCursor },
      "GET",
    );
    expect([...ids(first), ...ids(second), ...ids(third)]).toEqual(
      originals.map((post) => post.id).reverse(),
    );
    expect(third.pageCursor).toBeNull();
    const unread = await page({ author, readCursor: first.readCursor });
    expect(new Set(ids(unread))).toEqual(
      new Set(additions.map((post) => post.id)),
    );
    expect(ids(await page({ author, order: "oldest", limit: 100 }))).toEqual(
      [
        ...originals,
        ...additions.sort((a, b) =>
          BigInt(a.publicationOrder) < BigInt(b.publicationOrder) ? -1 : 1,
        ),
      ].map((post) => post.id),
    );
  });
  it("advances partial unread batches only through returned rows, not lookahead or global maximum", async () => {
    const author = await agent();
    let token = (await page({ author })).readCursor;
    const posts = [];
    for (let n = 0; n < 5; n++) posts.push(await publish(author));
    const seen: string[] = [];
    for (let n = 0; n < 3; n++) {
      const result = await page(
        { author, readCursor: token, limit: 2 },
        n % 2 ? "GET" : "POST",
      );
      seen.push(...ids(result));
      expect(await cursor(result.readCursor)).toMatchObject({
        boundary: { sequence: result.posts.at(-1)?.publicationOrder },
      });
      token = result.readCursor;
    }
    expect(seen).toEqual(posts.map((post) => post.id));
    const empty = await page({ author, readCursor: token });
    expect(empty.posts).toEqual([]);
    expect(empty.readCursor).toBe(token);
  });
  it("ANDs author/direct-parent filters without expanding descendants or inferring links", async () => {
    const author = await agent();
    const other = await agent();
    const root = await publish(author);
    const reply = await publish(
      author,
      "reply",
      ["opaque"],
      Option.some(root.id),
    );
    await publish(other, "other reply", [], Option.some(root.id));
    await publish(author, "grandchild", [], Option.some(reply.id));
    await publish(author, `[root](/posts/${root.id})`, [root.id]);
    const result = await page({ author, parent: root.id });
    expect(ids(result)).toEqual([reply.id]);
    expect(result.posts[0]?.reply_to).toBe(root.id);
    expect((await page({ parent: nanoid() })).posts).toEqual([]);
    const empty = await page({ author: nanoid() });
    await publish(other);
    expect((await page({ author: nanoid() })).posts).toEqual([]);
    expect(
      (await page({ author, tags: [], tagMatch: "any" })).posts.length,
    ).toBe(4);
    expect(empty.pageCursor).toBeNull();
  });
  it("retains filtered empty positions and binds the normalized selection, not page size/default spelling", async () => {
    const author = await agent();
    const other = await agent();
    const initial = await page({ author });
    await publish(other);
    const empty = await page({
      resource: "posts",
      author,
      tags: [],
      tagMatch: "any",
      readCursor: initial.readCursor,
      limit: 1,
    });
    expect(empty.readCursor).toBe(initial.readCursor);
    const post = await publish(author);
    expect(
      ids(await page({ author, readCursor: empty.readCursor, limit: 100 })),
    ).toEqual([post.id]);
    expect(
      (await search({ author: other, readCursor: empty.readCursor })).status,
    ).toBe(400);
    expect(
      (await search({ author, parent: nanoid(), readCursor: empty.readCursor }))
        .status,
    ).toBe(400);
  });
  it("rejects malformed/unsupported/range/purpose/resource/order cursors without reflecting input", async () => {
    const author = await agent();
    await publish(author);
    await publish(author);
    const first = await page({ author, limit: 1 });
    const envelope = await cursor(first.readCursor);
    const raw = (value: unknown) =>
      Encoding.encodeBase64Url(JSON.stringify(value));
    const invalid = [
      "!",
      "a".repeat(4097),
      first.pageCursor,
      raw({ ...envelope, version: 2 }),
      raw({ ...envelope, api: "v2" }),
      raw({ ...envelope, extra: true }),
      raw({ ...envelope, boundary: { sequence: "-1", id: nanoid() } }),
      raw({
        ...envelope,
        boundary: { sequence: "9223372036854775808", id: nanoid() },
      }),
      raw({ ...envelope, boundary: { sequence: "0", id: nanoid() } }),
      raw({ ...envelope, boundary: { sequence: "01", id: nanoid() } }),
      raw({ ...envelope, boundary: { sequence: "1", id: "' OR 1=1 --" } }),
      raw({
        ...envelope,
        resource: "agents",
        purpose: "page",
        order: "activity",
        offset: 0,
      }),
      raw({ ...envelope, purpose: "page", order: "relevance", offset: 0 }),
    ];
    for (const token of invalid) {
      const response = await search({ author, readCursor: token });
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).not.toContain("readCursor");
      expect(text).not.toContain("boundary");
    }
    expect(
      (await search({ author, order: "oldest", pageCursor: first.pageCursor }))
        .status,
    ).toBe(400);
    expect(
      (await search({ author, pageCursor: first.readCursor })).status,
    ).toBe(400);
    expect(
      (
        await search({
          author,
          pageCursor: first.pageCursor,
          readCursor: first.readCursor,
        })
      ).status,
    ).toBe(400);
  });
  it("keeps valid unsigned positions editable without granting write authority", async () => {
    const author = await agent();
    const a = await publish(author);
    const b = await publish(author);
    const first = await page({ author });
    const envelope = await cursor(first.readCursor);
    const token = Encoding.encodeBase64Url(
      JSON.stringify({
        ...envelope,
        boundary: { sequence: a.publicationOrder, id: a.id },
      }),
    );
    expect(ids(await page({ author, readCursor: token }))).toEqual([b.id]);
  });
  it("bounds default and maximum pages and hydrates100 complete results without per-Post queries", async () => {
    const author = await agent();
    const other = await agent();
    const root = await publish(other);
    for (let n = 0; n < 100; n++)
      await publish(
        n < 50 ? author : other,
        `full body ${String(n)}`,
        [`tag${String(n)}`],
        Option.some(root.id),
      );
    expect((await page({ parent: root.id })).posts.length).toBe(50);
    const prepares = vi.spyOn(env.DB, "prepare");
    const maximum = await page({ parent: root.id, limit: 100 });
    expect(prepares).toHaveBeenCalledTimes(2);
    prepares.mockRestore();
    expect(maximum.posts.length).toBe(100);
    expect(maximum.pageCursor).toBeNull();
    expect(
      maximum.posts.every(
        (post) => post.tags.length === 1 && post.body.startsWith("full body "),
      ),
    ).toBe(true);
    for (const limit of [0, -1, 101, 1.5, "2"])
      expect((await search({ limit })).status).toBe(400);
  });
  it("reports real database dependency failures without an advanced checkpoint or false empty success", async () => {
    const author = await agent();
    const saved = (await page({ author })).readCursor;
    await publish(author);
    await env.DB.prepare(
      "ALTER TABLE post_tags RENAME TO temporarily_unavailable_tags",
    ).run();
    try {
      const response = await search({ author, readCursor: saved });
      expect(response.status).toBe(503);
      const text = await response.text();
      expect(text).not.toContain("readCursor");
      expect(text).not.toContain("SELECT");
      expect(text).not.toContain("post_tags");
    } finally {
      await env.DB.prepare(
        "ALTER TABLE temporarily_unavailable_tags RENAME TO post_tags",
      ).run();
    }
    expect((await page({ author, readCursor: saved })).posts.length).toBe(1);
  });
  it("does not produce a checkpoint when a typed service dependency fails after selection", async () => {
    const author = await agent();
    await publish(author);
    const real = makeQueryStore(env.DB);
    const query = {
      ...real,
      page: (input: Parameters<typeof real.page>[0]) =>
        real
          .page(input)
          .pipe(Effect.flatMap(() => Effect.fail(new StorageFailure()))),
    };
    const input = await Effect.runPromise(decodeSearch({ author }));
    const result = await Effect.runPromise(
      Effect.flatMap(ForumQueries, (service) => service.search(input)).pipe(
        Effect.provide(
          forumQueriesLayer.pipe(
            Layer.provide(Layer.succeed(QueryStore, query)),
            Layer.provide(
              requestLayer(env, execution, origin, crypto.randomUUID()),
            ),
          ),
        ),
        Effect.either,
      ),
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") expect(result.left.status).toBe(503);
  });
  it("keeps supported bookmarks usable after dispatcher/layer recreation and migration retry", async () => {
    const author = await agent();
    const saved = (await page({ author })).readCursor;
    await migrate();
    const accepted = await publish(author);
    const replacement = makeDispatcher(() =>
      Promise.resolve(new Response("new instance")),
    );
    const response = await replacement.fetch(
      new Request(
        origin +
          "/v1/search?payload=" +
          encodeURIComponent(JSON.stringify({ author, readCursor: saved })),
      ),
      env,
      execution,
    );
    expect(response.status).toBe(200);
    expect(
      ids(
        await Schema.decodeUnknownPromise(PostPageResult)(
          await response.json(),
        ),
      ),
    ).toEqual([accepted.id]);
  });
  it("separates installation state and never claims unimplemented FTS/Tags/Directory success", async () => {
    const author = await agent();
    const post = await publish(author);
    await migrate(env.ISOLATED_DB);
    expect((await search({ id: post.id }, "GET", env.ISOLATED_DB)).status).toBe(
      404,
    );
    for (const input of [
      { q: "body" },
      { tags: ["label"] },
      { resource: "agents" },
      { q: "body", order: "relevance" },
    ])
      expect((await search(input)).status).toBe(501);
    for (const input of [
      { metadata: {} },
      { "metadata.x": 1 },
      { order: "relevance" },
      { id: post.id, author },
    ])
      expect((await search(input)).status).toBe(400);
  });
  it("uses lossless signed64 sequence gaps rather than tied timestamps", async () => {
    const db = env.ISOLATED_DB;
    const author = tiedAuthor;
    const sequences = tiedSequences;
    const first = await page({ author, order: "oldest", limit: 1 }, "POST", db);
    expect(first.posts[0]?.publicationOrder).toBe(sequences[0]);
    const second = await page(
      { author, readCursor: first.readCursor, limit: 1 },
      "GET",
      db,
    );
    expect(second.posts[0]?.publicationOrder).toBe(sequences[1]);
    const third = await page(
      { author, readCursor: second.readCursor },
      "POST",
      db,
    );
    expect(third.posts.map((post) => post.publicationOrder)).toEqual(
      sequences.slice(2),
    );
    expect(first.posts[0]?.publishedAt).toBe(third.posts[0]?.publishedAt);
    const newest = await page({ author, limit: 1 }, "GET", db);
    const older = await page(
      { author, limit: 100, pageCursor: newest.pageCursor },
      "POST",
      db,
    );
    expect(
      [...newest.posts, ...older.posts].map((post) => post.publicationOrder),
    ).toEqual([...sequences].reverse());
  });
});

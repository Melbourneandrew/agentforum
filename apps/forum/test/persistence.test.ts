import { env } from "cloudflare:workers";
import { Effect, Either, Option, Schema } from "effect";
import { nanoid } from "nanoid";
import { beforeAll, describe, expect, inject, it, vi } from "vitest";
import { makeForumStore, PublicationOrder } from "../src/database/store.js";
import {
  vocabulary,
  vocabularyVersion,
} from "../src/identity/vocabulary/english-v1.js";

declare module "vitest" {
  interface ProvidedContext {
    migrations: { name: string; queries: string[] }[];
  }
}
const store = () => makeForumStore(env.DB);
const digest = "a".repeat(64);
const historicalId = nanoid();
const historicalLookup = nanoid();
const apply = async (migrations: ReturnType<typeof inject<"migrations">>) => {
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS d1_migrations(name TEXT PRIMARY KEY)",
  ).run();
  for (const migration of migrations) {
    if (
      await env.DB.prepare("SELECT name FROM d1_migrations WHERE name=?")
        .bind(migration.name)
        .first()
    )
      continue;
    await env.DB.batch([
      ...migration.queries.map((query) => env.DB.prepare(query)),
      env.DB.prepare("INSERT INTO d1_migrations(name) VALUES (?)").bind(
        migration.name,
      ),
    ]);
  }
};
const register = async (name = `Agent${nanoid().replace(/[_-]/g, "0")}`) => {
  const id = nanoid();
  const lookupId = nanoid();
  await Effect.runPromise(
    store().createIdentity({ id, name, lookupId, digest }),
  );
  return { id, lookupId, name };
};
const publish = (
  authorId: string,
  body = "shared agent memory",
  tags: readonly string[] = [],
  parentId: Option.Option<string> = Option.none(),
) => store().publish({ authorId, body, tags, parentId });
const count = (authorId: string) =>
  env.DB.prepare("SELECT count(*) AS n FROM posts WHERE author_id=?")
    .bind(authorId)
    .first<number>("n");
const outcome = <A, E>(program: Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.either(program));
beforeAll(async () => {
  const migrations = inject("migrations");
  // Genuine prior-version fixture: generated relational schema, then retained
  // identities/posts through the supplemental FTS/guards migration and retries.
  await apply(migrations.slice(0, 2));
  await env.DB.batch([
    env.DB.prepare("INSERT INTO agents(id,name) VALUES (?,?)").bind(
      historicalId,
      "HistoricalAgent",
    ),
    env.DB.prepare(
      "INSERT INTO credentials(lookup_id,agent_id,digest) VALUES (?,?,?)",
    ).bind(historicalLookup, historicalId, digest),
    ...Array.from({ length: 60 }, () =>
      env.DB.prepare(
        "INSERT INTO posts(id,author_id,body,published_at,publication_window) VALUES (?,?,?,'2000-01-01T00:00:00.000Z',15778080)",
      ).bind(nanoid(), historicalId, "historicaltoken raw unchanged"),
    ),
  ]);
  await apply(migrations);
  await apply(migrations);
});

describe("real D1 immutable persistence", () => {
  it("retains prior-version records and digest credentials through versioned initialization and repeat", async () => {
    expect(await count(historicalId)).toBe(60);
    expect(
      Option.getOrThrow(
        await Effect.runPromise(store().findCredential(historicalLookup)),
      ),
    ).toEqual({ agentId: historicalId, digest });
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM post_fts WHERE post_fts MATCH ?",
      )
        .bind('"historicaltoken"')
        .first("n"),
    ).toBe(60);
    expect(
      await env.DB.prepare("PRAGMA foreign_key_check").all(),
    ).toMatchObject({ results: [] });
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM d1_migrations").first(
        "n",
      ),
    ).toBe(inject("migrations").length);
  });
  it("retains prior records and successful migration history after a later migration fails, then retries without reset", async () => {
    const before = await count(historicalId);
    const first = {
      name: "fixture_recovery_1",
      queries: ["CREATE TABLE fixture_recovery_1(value TEXT)"],
    };
    const failed = {
      name: "fixture_recovery_2",
      queries: [
        "CREATE TABLE fixture_rolled_back(value TEXT)",
        "SELECT * FROM fixture_nonexistent_table",
      ],
    };
    await expect(apply([first, failed])).rejects.toThrow();
    expect(
      await env.DB.prepare(
        "SELECT name FROM sqlite_master WHERE name='fixture_rolled_back'",
      ).first(),
    ).toBeNull();
    expect(
      await env.DB.prepare("SELECT name FROM d1_migrations WHERE name=?")
        .bind(first.name)
        .first("name"),
    ).toBe(first.name);
    expect(
      await env.DB.prepare("SELECT name FROM d1_migrations WHERE name=?")
        .bind(failed.name)
        .first(),
    ).toBeNull();
    await apply([
      first,
      { ...failed, queries: ["CREATE TABLE fixture_recovery_2(value TEXT)"] },
    ]);
    await apply([
      first,
      { ...failed, queries: ["CREATE TABLE fixture_recovery_2(value TEXT)"] },
    ]);
    expect(await count(historicalId)).toBe(before);
    expect(
      Option.getOrThrow(
        await Effect.runPromise(store().findCredential(historicalLookup)),
      ),
    ).toEqual({ agentId: historicalId, digest });
  });
  it("preserves the reviewed, pinned naming vocabulary", () => {
    expect(vocabularyVersion).toBe("english-v1");
    expect(vocabulary.length).toBeGreaterThan(20);
    expect(new Set(vocabulary).size).toBe(vocabulary.length);
    for (const word of vocabulary) expect(word).toMatch(/^[a-z]{1,7}$/);
  });
  it("claims case-insensitive canonical names atomically under concurrency", async () => {
    const name = `Case${nanoid().replace(/[_-]/g, "0")}`;
    const attempts = await Promise.all(
      [name, name.toLowerCase()].map((value) =>
        outcome(
          store().createIdentity({
            id: nanoid(),
            name: value,
            lookupId: nanoid(),
            digest,
          }),
        ),
      ),
    );
    expect(attempts.filter(Either.isRight)).toHaveLength(1);
    expect(
      attempts.filter(Either.isLeft).map((value) => value.left._tag),
    ).toEqual(["NameUnavailable"]);
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM agents WHERE canonical_name=lower(?)",
      )
        .bind(name)
        .first("n"),
    ).toBe(1);
  });
  it("rolls back a newly inserted identity if credential uniqueness fails", async () => {
    const existing = await register();
    const id = nanoid();
    const result = await outcome(
      store().createIdentity({
        id,
        name: `Retry${nanoid().replace(/[_-]/g, "0")}`,
        lookupId: existing.lookupId,
        digest,
      }),
    );
    expect(Either.isLeft(result) && result.left._tag).toBe(
      "CredentialConflict",
    );
    expect(
      await env.DB.prepare("SELECT id FROM agents WHERE id=?").bind(id).first(),
    ).toBeNull();
    expect(
      await env.DB.prepare("SELECT digest FROM credentials WHERE lookup_id=?")
        .bind(existing.lookupId)
        .first("digest"),
    ).toBe(digest);
  });
  it("preserves raw Markdown, binary-distinct ordered tags, local parent and database facts", async () => {
    const agent = await register();
    const body = "---\nnot: metadata\n---\n\n原文 🐙\n  unchanged\0body";
    const parent = await Effect.runPromise(publish(agent.id));
    const post = await Effect.runPromise(
      publish(
        agent.id,
        body,
        [" X ", "x", " X ", "experiment:run-42", "e\u0301", "é"],
        Option.some(parent.id),
      ),
    );
    expect(post.id).toMatch(/^[A-Za-z0-9_-]{21}$/);
    expect(post.body).toBe(body);
    expect(post.tags).toEqual([
      " X ",
      "x",
      "experiment:run-42",
      "e\u0301",
      "é",
    ]);
    expect(Option.getOrThrow(post.parentId)).toBe(parent.id);
    expect(Date.parse(post.publishedAt)).not.toBeNaN();
    expect(BigInt(post.publicationOrder)).toBeGreaterThan(
      BigInt(parent.publicationOrder),
    );
    expect(
      Option.getOrThrow(await Effect.runPromise(store().readPost(post.id))),
    ).toEqual(post);
    expect(
      await env.DB.prepare(
        "SELECT publication_window=CAST(strftime('%s',published_at)/60 AS INTEGER) AS consistent FROM posts WHERE id=?",
      )
        .bind(post.id)
        .first("consistent"),
    ).toBe(1);
  });
  it("validates repository input before writes, limits submitted tags before deduplication", async () => {
    const agent = await register();
    for (const input of [
      publish(agent.id, ""),
      publish(
        agent.id,
        "body",
        Array.from({ length: 33 }, () => "x"),
      ),
      publish(agent.id, "body", ["👨‍👩‍👧‍👦".repeat(65)]),
      publish(agent.id, "body", ["x".repeat(257)]),
    ]) {
      const result = await outcome(input);
      expect(Either.isLeft(result) && result.left._tag).toBe("InvalidRecord");
    }
    expect(await count(agent.id)).toBe(0);
  });
  it("rejects missing local parents and authors inside the write without partial publication", async () => {
    const agent = await register();
    const missingParent = await outcome(
      publish(agent.id, "orphan", ["one"], Option.some(nanoid())),
    );
    expect(Either.isLeft(missingParent) && missingParent.left._tag).toBe(
      "ParentNotFound",
    );
    const missingAuthor = await outcome(publish(nanoid(), "orphan"));
    expect(Either.isLeft(missingAuthor) && missingAuthor.left._tag).toBe(
      "AuthorNotFound",
    );
    expect(await count(agent.id)).toBe(0);
    await expect(
      env.DB.prepare(
        "INSERT INTO credentials(lookup_id,agent_id,digest) VALUES (?,?,?)",
      )
        .bind(nanoid(), nanoid(), digest)
        .run(),
    ).rejects.toThrow("FOREIGN KEY");
  });
  it("rolls back Post, tags, FTS and quota if a later batch statement fails", async () => {
    const agent = await register();
    const id = nanoid();
    await env.DB.prepare(
      "CREATE TRIGGER fixture_tag_failure BEFORE INSERT ON post_tags WHEN NEW.tag='fixture-rollback' BEGIN SELECT RAISE(ABORT,'fixture_tag_failure'); END",
    ).run();
    try {
      const result = await outcome(
        makeForumStore(env.DB, () => id).publish({
          authorId: agent.id,
          body: "rollbackuniquetoken",
          tags: ["first", "fixture-rollback"],
          parentId: Option.none(),
        }),
      );
      expect(Either.isLeft(result) && result.left._tag).toBe("StorageFailure");
    } finally {
      await env.DB.prepare("DROP TRIGGER fixture_tag_failure").run();
    }
    expect(await count(agent.id)).toBe(0);
    expect(
      await env.DB.prepare("SELECT tag FROM post_tags WHERE post_id=?")
        .bind(id)
        .all(),
    ).toMatchObject({ results: [] });
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM post_fts WHERE post_fts MATCH 'rollbackuniquetoken'",
      ).first("n"),
    ).toBe(0);
    await env.DB.prepare(
      "INSERT INTO post_fts(post_fts,rank) VALUES('integrity-check',1)",
    ).run();
    expect((await Effect.runPromise(publish(agent.id))).authorId).toBe(
      agent.id,
    );
  });
  it("retries a confirmed Nano21 collision by retrying the whole rolled-back publication", async () => {
    const agent = await register();
    const first = await Effect.runPromise(publish(agent.id));
    let attempts = 0;
    const next = await Effect.runPromise(
      makeForumStore(env.DB, () =>
        ++attempts === 1 ? first.id : nanoid(),
      ).publish({
        authorId: agent.id,
        body: "retry",
        tags: ["once"],
        parentId: Option.none(),
      }),
    );
    expect(attempts).toBe(2);
    expect(next.id).not.toBe(first.id);
    expect(await count(agent.id)).toBe(2);
    const failed = await outcome(
      makeForumStore(env.DB, () => first.id).publish({
        authorId: agent.id,
        body: "collision",
        tags: [],
        parentId: Option.none(),
      }),
    );
    expect(Either.isLeft(failed) && failed.left._tag).toBe("StorageFailure");
    expect(await count(agent.id)).toBe(2);
  });
  it("does not retry or claim rollback after a lost response to a real committed batch", async () => {
    const agent = await register();
    const id = nanoid();
    let generated = 0;
    const actualBatch = env.DB.batch.bind(env.DB);
    const spy = vi
      .spyOn(env.DB, "batch")
      .mockImplementationOnce(async (statements) => {
        await actualBatch(statements);
        throw new Error("synthetic lost response");
      });
    try {
      const result = await outcome(
        makeForumStore(env.DB, () => {
          generated++;
          return id;
        }).publish({
          authorId: agent.id,
          body: "transport ambiguity",
          tags: ["committed"],
          parentId: Option.none(),
        }),
      );
      expect(Either.isLeft(result) && result.left._tag).toBe("StorageFailure");
      expect(generated).toBe(1);
    } finally {
      spy.mockRestore();
    }
    expect(await count(agent.id)).toBe(1);
    expect(
      Option.getOrThrow(await Effect.runPromise(store().readPost(id))).tags,
    ).toEqual(["committed"]);
  });
  it("enforces immutable bodies, facts and tag associations at SQLite boundaries", async () => {
    const agent = await register();
    const post = await Effect.runPromise(
      publish(agent.id, "immutable", ["fixed"]),
    );
    for (const query of [
      "UPDATE posts SET body='changed' WHERE id=?",
      "DELETE FROM posts WHERE id=?",
      "UPDATE post_tags SET tag='changed' WHERE post_id=?",
      "DELETE FROM post_tags WHERE post_id=?",
    ])
      await expect(env.DB.prepare(query).bind(post.id).run()).rejects.toThrow(
        "forum_immutable",
      );
    expect(
      Option.getOrThrow(await Effect.runPromise(store().readPost(post.id))),
    ).toEqual(post);
    await expect(
      env.DB.prepare(
        "INSERT INTO post_tags(post_id,tag,ordinal) VALUES (?, 'added-later',1)",
      )
        .bind(post.id)
        .run(),
    ).rejects.toThrow("forum_immutable_tag");
    await expect(
      env.DB.prepare(
        "INSERT INTO post_tags(post_id,tag,ordinal) VALUES (?, 'fractional-late',0.5)",
      )
        .bind(post.id)
        .run(),
    ).rejects.toThrow("forum_immutable_tag");
    await expect(
      env.DB.prepare(
        "INSERT INTO posts(id,author_id,body,tag_count) VALUES (?,?,?,1.5)",
      )
        .bind(nanoid(), agent.id, "fractional cardinality")
        .run(),
    ).rejects.toThrow("forum_invalid_tag_count");
    const zero = await Effect.runPromise(publish(agent.id, "zero tags"));
    await expect(
      env.DB.prepare(
        "INSERT INTO post_tags(post_id,tag,ordinal) VALUES (?, 'added-later',0)",
      )
        .bind(zero.id)
        .run(),
    ).rejects.toThrow("forum_immutable_tag");
    await expect(
      env.DB.prepare(
        "INSERT OR REPLACE INTO posts(id,author_id,body) VALUES (?,?,?)",
      )
        .bind(post.id, agent.id, "replacement")
        .run(),
    ).rejects.toThrow("forum_post_id_conflict");
    await expect(
      env.DB.prepare(
        "INSERT OR REPLACE INTO posts(publication_order,id,author_id,body) VALUES (CAST(? AS INTEGER),?,?,?)",
      )
        .bind(post.publicationOrder, nanoid(), agent.id, "replacement")
        .run(),
    ).rejects.toThrow("forum_immutable_post");
    await expect(
      env.DB.prepare(
        "INSERT OR REPLACE INTO post_tags(post_id,tag,ordinal) VALUES (?, ?,0)",
      )
        .bind(post.id, "replacement")
        .run(),
    ).rejects.toThrow("forum_immutable_tag");
    await expect(
      env.DB.prepare(
        "INSERT INTO posts(id,author_id,body,publication_window) VALUES (?,?,?,0)",
      )
        .bind(nanoid(), agent.id, "badclock")
        .run(),
    ).rejects.toThrow("forum_server_facts");
  });
  it("indexes complete raw bodies with unicode61 words/phrases, excluding tags, and supports rebuild", async () => {
    const agent = await register();
    const post = await Effect.runPromise(
      publish(
        agent.id,
        "Uniquefox adjacent memory [link](https://example.invalid/hiddenword)",
        ["tagonlysecret"],
      ),
    );
    const matches = (term: string) =>
      env.DB.prepare(
        "SELECT count(*) AS n FROM post_fts WHERE post_fts MATCH ? AND rowid=(SELECT publication_order FROM posts WHERE id=?)",
      )
        .bind(term, post.id)
        .first("n");
    expect(await matches('"UNIQUEFOX" AND "adjacent memory"')).toBe(1);
    expect(await matches('"hiddenword"')).toBe(1);
    expect(await matches('"tagonlysecret"')).toBe(0);
    await env.DB.prepare(
      "INSERT INTO post_fts(post_fts) VALUES('rebuild')",
    ).run();
    await env.DB.prepare(
      "INSERT INTO post_fts(post_fts,rank) VALUES('integrity-check',1)",
    ).run();
    expect(await matches('"adjacent memory"')).toBe(1);
  });
  it("shares exactly 60 accepted insert-time slots across concurrent requests and isolates agents", async () => {
    // Avoid testing across an actual wall-clock boundary; no fake Worker clock.
    const second = await env.DB.prepare(
      "SELECT unixepoch()%60 AS second",
    ).first<number>("second");
    if (second !== null && second >= 55)
      await new Promise((resolve) => setTimeout(resolve, (61 - second) * 1000));
    const agent = await register();
    const results = await Promise.all(
      Array.from({ length: 65 }, () => outcome(publish(agent.id))),
    );
    expect(results.filter(Either.isRight)).toHaveLength(60);
    const failures = results.filter(Either.isLeft);
    expect(failures).toHaveLength(5);
    for (const failure of failures)
      expect(failure.left).toMatchObject({
        _tag: "PublicationLimited",
        retryAfter: 60,
        conservative: true,
      });
    expect(await count(agent.id)).toBe(60);
    expect(
      await env.DB.prepare(
        "SELECT count(DISTINCT publication_window) AS n FROM posts WHERE author_id=?",
      )
        .bind(agent.id)
        .first("n"),
    ).toBe(1);
    const other = await register();
    expect((await Effect.runPromise(publish(other.id))).authorId).toBe(
      other.id,
    );
    // Historical fixed-window usage is not a rolling count or global counter.
    expect((await Effect.runPromise(publish(historicalId))).authorId).toBe(
      historicalId,
    );
    expect(await count(historicalId)).toBe(61);
  }, 15_000);
  it("keeps sequence gaps and >2^53 orders lossless through D1/Drizzle and maximum SQLite range", async () => {
    const agent = await register();
    await env.DB.prepare(
      "UPDATE sqlite_sequence SET seq=CAST(? AS INTEGER) WHERE name='posts'",
    )
      .bind("9007199254740992")
      .run();
    const first = await Effect.runPromise(publish(agent.id));
    expect(first.publicationOrder).toBe("9007199254740993");
    expect(
      Option.getOrThrow(await Effect.runPromise(store().readPost(first.id)))
        .publicationOrder,
    ).toBe(first.publicationOrder);
    await env.DB.prepare(
      "UPDATE sqlite_sequence SET seq=seq+5 WHERE name='posts'",
    ).run();
    const next = await Effect.runPromise(publish(agent.id));
    expect(BigInt(next.publicationOrder) - BigInt(first.publicationOrder)).toBe(
      6n,
    );
    for (const invalid of ["0", "01", "-1", "1.0", "9223372036854775808"])
      expect(() =>
        Schema.decodeUnknownSync(PublicationOrder)(invalid),
      ).toThrow();
    await env.DB.prepare(
      "UPDATE sqlite_sequence SET seq=CAST(? AS INTEGER) WHERE name='posts'",
    )
      .bind("9223372036854775806")
      .run();
    const max = await Effect.runPromise(publish(agent.id));
    expect(max.publicationOrder).toBe("9223372036854775807");
    expect(
      Option.getOrThrow(await Effect.runPromise(store().readPost(max.id)))
        .publicationOrder,
    ).toBe(max.publicationOrder);
    const exhausted = await outcome(publish(agent.id));
    expect(Either.isLeft(exhausted) && exhausted.left._tag).toBe(
      "StorageFailure",
    );
  });
});

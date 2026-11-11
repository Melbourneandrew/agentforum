import { MetadataObject } from "../../src/input/transport.js";
import { env } from "node:process";
import { sql } from "drizzle-orm";
import { Effect, Layer, Option, Redacted, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  DirectDatabase,
  directDatabaseLayer,
  databaseBindingsLayer,
} from "../../src/database/database.js";
import {
  IdentityRepository,
  identityRepositoryLayer,
} from "../../src/identity/repository.js";
import {
  PostRepository,
  nativePostRepositoryLayer,
  postRepositoryLayer,
  PostIdentifiers,
  type Published,
} from "../../src/posts/repository.js";
import {
  Cursors,
  cursorConfigurationLayer,
  cursorsLayer,
} from "../../src/retrieval/cursors.js";
import { SearchInput, SearchResult } from "../../src/retrieval/contract.js";
import { Retrieval, retrievalLayer } from "../../src/retrieval/service.js";
import { retrievalRepositoryLayer } from "../../src/retrieval/repository.js";
const config = Schema.decodeUnknownSync(
  Schema.Struct({
    DATABASE_TEST_DIRECT_URL: Schema.Redacted(Schema.NonEmptyString),
    DATABASE_TEST_CACHED_URL: Schema.Redacted(Schema.NonEmptyString),
  }),
)(env);
const bindings = {
  HYPERDRIVE_DIRECT: {
    connectionString: Redacted.value(config.DATABASE_TEST_DIRECT_URL),
  },
  HYPERDRIVE_CACHED: {
    connectionString: Redacted.value(config.DATABASE_TEST_CACHED_URL),
  },
};
const direct = directDatabaseLayer.pipe(
  Layer.provide(databaseBindingsLayer(bindings)),
);
const cursor = cursorsLayer.pipe(
  Layer.provide(
    cursorConfigurationLayer({
      CURSOR_CURRENT_KEY: "r1",
      CURSOR_KEYS: JSON.stringify({ r1: "33".repeat(32) }),
    }),
  ),
);
const live = (databaseBindings: unknown = bindings) =>
  retrievalLayer.pipe(
    Layer.provide(
      Layer.merge(cursor, retrievalRepositoryLayer(databaseBindings)),
    ),
  );
const search = (input: unknown) =>
  Effect.runPromise(
    Effect.flatMap(Retrieval, (service) => service.search(input)).pipe(
      Effect.provide(live()),
    ),
  );
const identity = () =>
  Effect.runPromise(
    Effect.flatMap(IdentityRepository, (repo) =>
      repo.create({
        name: `Read${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`,
        keyVersion: "test",
        lookupId: crypto.randomUUID(),
        keyDigest: Redacted.make("a".repeat(64)),
        pepperVersion: "test",
      }),
    ).pipe(Effect.provide(identityRepositoryLayer.pipe(Layer.provide(direct)))),
  );
const publish = async (
  authorId: string,
  body: string,
  replyTo?: string,
  metadata: Record<string, unknown> = {},
  fixtureId?: string,
) => {
  const result = await Effect.runPromise(
    Effect.flatMap(PostRepository, (repo) =>
      repo.publish({
        authorId,
        body,
        metadata,
        ...(replyTo === undefined ? {} : { reply_to: replyTo }),
      }),
    ).pipe(
      Effect.provide(
        (fixtureId === undefined
          ? nativePostRepositoryLayer
          : postRepositoryLayer.pipe(
              Layer.provide(
                Layer.succeed(PostIdentifiers, {
                  next: Effect.succeed(fixtureId),
                }),
              ),
            )
        ).pipe(Layer.provide(direct)),
      ),
    ),
  );
  if (result._tag !== "Published")
    throw new Error("Retrieval fixture unexpectedly rate limited");
  return result.post;
};
const parent = async () => {
  const author = await identity();
  return { author, post: await publish(author.id, "retrieval fixture parent") };
};
const pageToken = (result: Schema.Schema.Type<typeof SearchResult>) =>
  Option.getOrThrow(result.page_cursor);
const failure = (input: unknown, b: unknown = bindings) =>
  Effect.runPromise(
    Effect.either(
      Effect.flatMap(Retrieval, (service) => service.search(input)).pipe(
        Effect.provide(live(b)),
      ),
    ),
  );
const decodeRead = (token: string, selection: unknown) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* Cursors;
      const query = yield* service.fingerprint(selection);
      return yield* service.verify(token, {
        purpose: "read",
        ordering: "chronological_asc",
        query,
      });
    }).pipe(Effect.provide(cursor)),
  );
describe("direct chronological retrieval in real PostgreSQL/workerd", () => {
  it("returns full unchanged structured Posts and an explicit missing-ID failure", async () => {
    const { author, post } = await parent();
    const metadata = Schema.decodeUnknownSync(MetadataObject)(
      JSON.parse(
        '{"type":null,"n":1,"bool":true,"nested":{"list":[{"x":2}]},"__proto__":{"own":true}}',
      ),
    );
    const reply = await publish(
      author.id,
      "---\ntype: ordinary Markdown\n---\n# exact body\n",
      post.id,
      metadata,
      "c" + crypto.randomUUID().replaceAll("-", "").slice(0, 20),
    );
    const result = await search({ id: reply.id });
    expect(result.posts).toEqual([reply]);
    expect(result.has_more).toBe(false);
    expect(Option.isNone(result.page_cursor)).toBe(true);
    expect(Object.hasOwn(result.posts[0]?.metadata ?? {}, "__proto__")).toBe(
      true,
    );
    const wire = await Effect.runPromise(Schema.encode(SearchResult)(result));
    expect(wire.posts[0]?.reply_to_id).toBe(post.id);
    expect(wire.posts[0]?.published_at).toMatch(
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/,
    );
    expect(await failure({ id: "_".repeat(21) })).toMatchObject({
      _tag: "Left",
      left: { _tag: "SearchPostNotFoundError" },
    });
    expect(await failure({ id: reply.id.toUpperCase() })).toMatchObject({
      _tag: "Left",
      left: { _tag: "SearchPostNotFoundError" },
    });
  });
  it("returns newest-first default feeds and paginates isolated direct replies without skipping on a new commit", async () => {
    const { author, post } = await parent();
    const replies: Published["post"][] = [];
    for (let n = 1; n <= 5; n++)
      replies.push(await publish(author.id, `reply ${String(n)}`, post.id));
    const first = await search({ reply_to: post.id, limit: 2 });
    expect(first.posts.map((p) => p.id)).toEqual([
      replies[4]?.id,
      replies[3]?.id,
    ]);
    expect(first.has_more).toBe(true);
    const newest = await publish(author.id, "concurrent newer reply", post.id);
    const second = await search({
      reply_to: post.id,
      cursor: pageToken(first),
      limit: 2,
    });
    const third = await search({
      reply_to: post.id,
      cursor: pageToken(second),
      limit: 2,
    });
    expect(
      [...first.posts, ...second.posts, ...third.posts].map((p) => p.id),
    ).toEqual(
      replies
        .slice()
        .reverse()
        .map((p) => p.id),
    );
    expect(Option.isNone(third.page_cursor)).toBe(true);
    expect(third.has_more).toBe(false);
    const unread = await search({
      reply_to: post.id,
      read_cursor: first.read_cursor,
    });
    expect(unread.posts.map((p) => p.id)).toEqual([newest.id]);
    const unfiltered = await search({ limit: 50 });
    for (let i = 1; i < unfiltered.posts.length; i++) {
      const previous = unfiltered.posts[i - 1],
        current = unfiltered.posts[i];
      expect(
        previous !== undefined &&
          current !== undefined &&
          BigInt(previous.publication_order) >
            BigInt(current.publication_order),
      ).toBe(true);
    }
  });
  it("uses before-first for empty matches, drains partial unread pages oldest-first and preserves empty polling boundaries", async () => {
    const { author, post } = await parent();
    const empty = await search({ reply_to: post.id });
    expect(empty.posts).toEqual([]);
    expect(
      (await decodeRead(empty.read_cursor, { reply_to: post.id })).boundary,
    ).toEqual({ kind: "before_first", publicationOrder: "0" });
    const replies: Published["post"][] = [];
    for (let n = 0; n < 5; n++)
      replies.push(await publish(author.id, `unread ${String(n)}`, post.id));
    const one = await search({
      reply_to: post.id,
      read_cursor: empty.read_cursor,
      limit: 2,
    });
    expect(one.has_more).toBe(true);
    expect(Option.isNone(one.page_cursor)).toBe(true);
    const two = await search({
      reply_to: post.id,
      read_cursor: one.read_cursor,
      limit: 1,
    });
    const three = await search({
      reply_to: post.id,
      read_cursor: two.read_cursor,
      limit: 2,
    });
    expect(
      [...one.posts, ...two.posts, ...three.posts].map((p) => p.id),
    ).toEqual(replies.map((p) => p.id));
    const before = await decodeRead(three.read_cursor, { reply_to: post.id });
    const unrelated = await publish(
      author.id,
      "unmatched post must not advance this cursor",
    );
    expect(unrelated.id).not.toBe(post.id);
    const again = await search({
      reply_to: post.id,
      read_cursor: three.read_cursor,
    });
    expect(again.posts).toEqual([]);
    expect(
      (await decodeRead(again.read_cursor, { reply_to: post.id })).boundary,
    ).toEqual(before.boundary);
    expect(again.read_cursor).toBe(three.read_cursor);
    const last = await publish(author.id, "later matching reply", post.id);
    expect(
      (
        await search({ reply_to: post.id, read_cursor: again.read_cursor })
      ).posts.map((p) => p.id),
    ).toEqual([last.id]);
  });
  it("rejects wrong purposes/selection and malformed input before acquiring any database connection", async () => {
    const { post } = await parent();
    const first = await search({ reply_to: post.id });
    for (const input of [
      { reply_to: post.id, cursor: first.read_cursor },
      { reply_to: "A".repeat(21), read_cursor: first.read_cursor },
      { read_cursor: "abc" },
      { limit: 0 },
      { limit: 51 },
      { id: "bad" },
      { cursor: first.read_cursor, read_cursor: first.read_cursor },
      { text: "deferred" },
    ])
      expect(await failure(input, {})).toMatchObject({ _tag: "Left" });
    // Explicit invalid binding object distinguishes cursor validation from a DB failure.
    expect(
      await failure(
        { reply_to: "A".repeat(21), read_cursor: first.read_cursor },
        {},
      ),
    ).toMatchObject({ _tag: "Left", left: { _tag: "CursorInvalidError" } });
    expect(await failure({ reply_to: post.id }, {})).toMatchObject({
      _tag: "Left",
      left: { _tag: "DatabaseConfigurationError" },
    });
  });
  it("binds filters but not page size and uses the direct rather than cached database", async () => {
    const { author, post } = await parent();
    for (let n = 0; n < 4; n++)
      await publish(author.id, `page-size ${String(n)}`, post.id);
    const first = await search({ reply_to: post.id, limit: 1 });
    const next = await search({
      limit: 3,
      reply_to: post.id,
      cursor: pageToken(first),
    });
    expect(next.posts.length).toBe(3);
    expect(Option.isNone(next.page_cursor)).toBe(true);
    expect(await failure({ cursor: pageToken(first), limit: 1 })).toMatchObject(
      { _tag: "Left", left: { _tag: "CursorInvalidError" } },
    );
    const prepared = await Effect.runPromise(
      Schema.decodeUnknown(SearchInput)({ reply_to: post.id }),
    );
    expect(prepared.limit).toBe(20);
  });
  it("does not change publication counters or accepted-event accounting when repeatedly reading", async () => {
    const { author, post } = await parent();
    const snapshot = () =>
      Effect.runPromise(
        Effect.flatMap(DirectDatabase, (db) =>
          db.execute(
            () =>
              sql`SELECT (SELECT count(*)::int FROM posts WHERE author_id=${author.id}) AS posts,(SELECT count(*)::int FROM post_rate_limit_events WHERE author_id=${author.id}) AS events`,
            Schema.Struct({ posts: Schema.Int, events: Schema.Int }),
          ),
        ).pipe(Effect.provide(direct)),
      );
    const before = await snapshot();
    for (let n = 0; n < 3; n++) {
      await search({ id: post.id });
      await search({ reply_to: post.id });
    }
    expect(await snapshot()).toEqual(before);
  });
});

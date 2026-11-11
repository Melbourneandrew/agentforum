import { env } from "node:process";
import { sql, type SQL } from "drizzle-orm";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Redacted,
  Schema,
} from "effect";
import { describe, expect, it } from "vitest";
import {
  DirectDatabase,
  databaseBindingsLayer,
  directDatabaseLayer,
  DatabaseQueryError,
} from "../../src/database/database.js";
import {
  IdentityRepository,
  identityRepositoryLayer,
} from "../../src/identity/repository.js";
import {
  PostRepository,
  PostIdentifiers,
  PostId,
  nativePostRepositoryLayer,
  postRepositoryLayer,
  PostInputInvalidError,
  PostIdentifierCollisionError,
  PostParentNotFoundError,
  PostAuthorNotFoundError,
  type Published,
} from "../../src/posts/repository.js";

const config = Schema.decodeUnknownSync(
  Schema.Struct({
    DATABASE_TEST_DIRECT_URL: Schema.Redacted(Schema.NonEmptyString),
    DATABASE_TEST_CACHED_URL: Schema.Redacted(Schema.NonEmptyString),
  }),
)(env);
const direct = directDatabaseLayer.pipe(
  Layer.provide(
    databaseBindingsLayer({
      HYPERDRIVE_DIRECT: {
        connectionString: Redacted.value(config.DATABASE_TEST_DIRECT_URL),
      },
      HYPERDRIVE_CACHED: {
        connectionString: Redacted.value(config.DATABASE_TEST_CACHED_URL),
      },
    }),
  ),
);
const repository = nativePostRepositoryLayer.pipe(Layer.provide(direct));
const run = <A, E>(effect: Effect.Effect<A, E, PostRepository>) =>
  Effect.runPromise(effect.pipe(Effect.provide(repository)));
const runDirect = <A, E>(effect: Effect.Effect<A, E, DirectDatabase>) =>
  Effect.runPromise(effect.pipe(Effect.provide(direct)));
const query = <A, I>(statement: SQL, schema: Schema.Schema<A, I>) =>
  runDirect(
    Effect.flatMap(DirectDatabase, (db) => db.execute(() => statement, schema)),
  );
const execute = (statement: SQL) => query(statement, Schema.Never);
const publish = (input: unknown) =>
  Effect.flatMap(PostRepository, (repo) => repo.publish(input));
const fixtureId = () => crypto.randomUUID().replaceAll("-", "").slice(0, 21);
const identity = () =>
  Effect.runPromise(
    Effect.flatMap(IdentityRepository, (repo) =>
      repo.create({
        name: `Post${fixtureId()}`,
        keyVersion: "test",
        lookupId: crypto.randomUUID(),
        keyDigest: Redacted.make("a".repeat(64)),
        pepperVersion: "test",
      }),
    ).pipe(Effect.provide(identityRepositoryLayer.pipe(Layer.provide(direct)))),
  );
const accepted = (value: Published | { readonly _tag: "RateLimited" }) => {
  if (value._tag !== "Published")
    throw new Error("Fixture publication unexpectedly rate limited");
  return value.post;
};
const snapshot = (author: string) =>
  query(
    sql`SELECT (SELECT value::text FROM publication_counter WHERE id = 1) AS counter, (SELECT count(*)::int FROM posts WHERE author_id = ${author}) AS posts, (SELECT count(*)::int FROM post_rate_limit_events WHERE author_id = ${author}) AS events`,
    Schema.Struct({
      counter: Schema.String,
      posts: Schema.Int,
      events: Schema.Int,
    }),
  );
const failure = <A, E>(exit: Exit.Exit<A, E>) => {
  expect(Exit.isFailure(exit)).toBe(true);
  return Exit.isFailure(exit)
    ? Option.getOrThrow(Cause.failureOption(exit.cause))
    : undefined;
};
const injected = (next: Effect.Effect<string>) =>
  postRepositoryLayer.pipe(
    Layer.provide(Layer.succeed(PostIdentifiers, { next })),
    Layer.provide(direct),
  );
const awaitBlocked = async () => {
  for (let i = 0; i < 100; i++) {
    const rows = await query(
      sql`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND objid = 711109::oid AND classid = 0 AND NOT granted`,
      Schema.Struct({ n: Schema.Int }),
    );
    if (rows.some((row) => row.n > 0)) return;
    await Effect.runPromise(Effect.sleep("20 millis"));
  }
  throw new Error("Real PostgreSQL advisory wait was not observed");
};
const advisory = 711109;
const holdAdvisory = async () => {
  const entered = await Effect.runPromise(Deferred.make<boolean>());
  const release = await Effect.runPromise(Deferred.make<boolean>());
  const fiber = Effect.runFork(
    Effect.flatMap(DirectDatabase, (db) =>
      db.transaction((session) =>
        session
          .execute(
            () => sql`SELECT pg_advisory_xact_lock(${advisory})`,
            Schema.Struct({ pg_advisory_xact_lock: Schema.Unknown }),
          )
          .pipe(
            Effect.zipRight(Deferred.succeed(entered, true)),
            Effect.zipRight(Deferred.await(release)),
          ),
      ),
    ).pipe(Effect.provide(direct)),
  );
  await Effect.runPromise(Deferred.await(entered));
  return async () => {
    await Effect.runPromise(Deferred.succeed(release, true));
    await Effect.runPromise(Fiber.join(fiber));
  };
};
const gateFunction = sql`CREATE FUNCTION test_post_event_gate() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN PERFORM pg_advisory_xact_lock(711109); RETURN NEW; END; $body$`;
const installGate = async () => {
  await execute(gateFunction);
  await execute(
    sql`CREATE TRIGGER test_post_event_gate BEFORE INSERT ON post_rate_limit_events FOR EACH ROW EXECUTE FUNCTION test_post_event_gate()`,
  );
};
const removeGate = async () => {
  await execute(
    sql`DROP TRIGGER IF EXISTS test_post_event_gate ON post_rate_limit_events`,
  );
  await execute(sql`DROP FUNCTION IF EXISTS test_post_event_gate()`);
};

describe("immutable publication in real PostgreSQL and workerd", () => {
  it("preserves Markdown, typed arbitrary JSON keys, reply identity and authoritative facts", async () => {
    const a = await identity();
    const b = await identity();
    const body =
      "# Raw **Markdown**\r\n<script>inert</script>\n雪🧪 SELECT 'quoted'";
    const metadata: unknown = JSON.parse(
      '{"__proto__":{"safe":true},"null":null,"number":1.25,"false":false,"array":[1,"雪",null,{"k":"v"}]}',
    );
    const parent = accepted(
      await run(publish({ authorId: a.id, body, metadata })),
    );
    const reply = accepted(
      await run(
        publish({ authorId: b.id, body: "reply", reply_to: parent.id }),
      ),
    );
    expect(parent.body).toBe(body);
    expect(parent.metadata).toEqual(metadata);
    expect(Object.hasOwn(parent.metadata, "__proto__")).toBe(true);
    expect(parent.author_id).toBe(a.id);
    expect(parent.author_name).toBe(a.name);
    expect(parent.reply_to_id).toEqual(Option.none());
    expect(reply.reply_to_id).toEqual(Option.some(parent.id));
    expect(reply.author_name).toBe(b.name);
    expect(BigInt(reply.publication_order)).toBeGreaterThan(
      BigInt(parent.publication_order),
    );
    expect(new Date(parent.published_at).toISOString()).toBe(
      parent.published_at,
    );
    expect(
      await run(Effect.flatMap(PostRepository, (repo) => repo.find(parent.id))),
    ).toEqual(Option.some(parent));
    expect(
      await run(
        Effect.flatMap(PostRepository, (repo) => repo.find(fixtureId())),
      ),
    ).toEqual(Option.none());
    expect(
      failure(
        await run(
          Effect.exit(
            publish({ authorId: a.id, body: "x", author_name: "forged" }),
          ),
        ),
      ),
    ).toBeInstanceOf(PostInputInvalidError);
  });
  it("rejects missing identities/parents and lossy prepared JSON without allocating or accounting", async () => {
    const a = await identity();
    const before = await snapshot(a.id);
    expect(
      failure(
        await run(
          Effect.exit(publish({ authorId: crypto.randomUUID(), body: "x" })),
        ),
      ),
    ).toBeInstanceOf(PostAuthorNotFoundError);
    expect(
      failure(
        await run(
          Effect.exit(
            publish({ authorId: a.id, body: "x", reply_to: fixtureId() }),
          ),
        ),
      ),
    ).toBeInstanceOf(PostParentNotFoundError);
    const sparse = new Array<unknown>(2);
    for (const metadata of [
      { x: undefined },
      { x: () => 1 },
      { x: Infinity },
      { x: NaN },
      { x: new Date() },
      { x: 1n },
      { x: "\ud800" },
      { x: sparse },
    ]) {
      expect(
        failure(
          await run(
            Effect.exit(publish({ authorId: a.id, body: "x", metadata })),
          ),
        ),
      ).toBeInstanceOf(PostInputInvalidError);
    }
    for (const reply_to of ["a".repeat(21) + "\n", "short"])
      expect(
        failure(
          await run(
            Effect.exit(publish({ authorId: a.id, body: "x", reply_to })),
          ),
        ),
      ).toBeInstanceOf(PostInputInvalidError);
    expect(await snapshot(a.id)).toEqual(before);
  });
  it("uses cryptographically generated opaque fixed-length IDs and rolls collisions back before retry", async () => {
    const a = await identity();
    const original = accepted(
      await run(publish({ authorId: a.id, body: "original" })),
    );
    expect(Schema.decodeUnknownEither(PostId)(original.id)._tag).toBe("Right");
    let attempts = 0;
    const next = fixtureId();
    const before = await snapshot(a.id);
    const result = await Effect.runPromise(
      publish({ authorId: a.id, body: "collision retry" }).pipe(
        Effect.provide(
          injected(Effect.sync(() => (++attempts < 3 ? original.id : next))),
        ),
      ),
    );
    expect(accepted(result).id).toBe(next);
    expect(attempts).toBe(3);
    const after = await snapshot(a.id);
    expect(after[0]?.events).toBe((before[0]?.events ?? 0) + 1);
    expect(BigInt(after[0]?.counter ?? "0")).toBe(
      BigInt(before[0]?.counter ?? "0") + 1n,
    );
    let exhausted = 0;
    const exhaustedBefore = await snapshot(a.id);
    const exit = await Effect.runPromise(
      Effect.exit(publish({ authorId: a.id, body: "exhausted" })).pipe(
        Effect.provide(
          injected(
            Effect.sync(() => {
              exhausted++;
              return original.id;
            }),
          ),
        ),
      ),
    );
    expect(failure(exit)).toBeInstanceOf(PostIdentifierCollisionError);
    expect(exhausted).toBe(4);
    expect(await snapshot(a.id)).toEqual(exhaustedBefore);
  });
  it("serializes concurrent final-slot publications and returns exact database-clock Retry-After", async () => {
    const a = await identity();
    await run(
      Effect.gen(function* () {
        const repo = yield* PostRepository;
        for (let i = 0; i < 59; i++)
          accepted(yield* repo.publish({ authorId: a.id, body: String(i) }));
      }),
    );
    const before = await snapshot(a.id);
    const start = performance.now();
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        run(publish({ authorId: a.id, body: "final slot" })),
      ),
    );
    console.info("publication_contention", {
      concurrentRequests: 8,
      elapsedMs: Math.round(performance.now() - start),
      environment: "disposable_local_PostgreSQL_workerd_not_capacity_target",
    });
    expect(
      results.filter((result) => result._tag === "Published"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result._tag === "RateLimited"),
    ).toHaveLength(7);
    for (const result of results)
      if (result._tag === "RateLimited") {
        const expected = await query(
          sql`SELECT ceil(extract(epoch FROM (min(published_at) + interval '60 seconds' - ${result.decidedAt}::timestamptz)))::integer AS retry FROM post_rate_limit_events WHERE author_id = ${a.id} AND published_at > ${result.decidedAt}::timestamptz - interval '60 seconds'`,
          Schema.Struct({ retry: Schema.Int }),
        );
        expect(result.retryAfter).toBe(expected[0]?.retry);
        expect(result.retryAfter).toBeGreaterThan(0);
      }
    const after = await snapshot(a.id);
    expect(after[0]?.posts).toBe(60);
    expect(after[0]?.events).toBe(60);
    expect(BigInt(after[0]?.counter ?? "0")).toBe(
      BigInt(before[0]?.counter ?? "0") + 1n,
    );
    await execute(
      sql`UPDATE post_rate_limit_events SET published_at = clock_timestamp() - interval '61 seconds' WHERE post_id = (SELECT post_id FROM post_rate_limit_events WHERE author_id = ${a.id} ORDER BY published_at, post_id LIMIT 1)`,
    );
    accepted(await run(publish({ authorId: a.id, body: "window reopened" })));
    expect((await snapshot(a.id))[0]?.events).toBe(60);
    expect((await snapshot(a.id))[0]?.posts).toBe(61);
    const other = await identity();
    accepted(
      await run(publish({ authorId: other.id, body: "independent principal" })),
    );
  });
  it.each(["counter", "post", "event"] as const)(
    "rolls back the entire publication on a real %s-stage SQL failure",
    async (stage) => {
      const a = await identity();
      const before = await snapshot(a.id);
      const table =
        stage === "counter"
          ? "publication_counter"
          : stage === "post"
            ? "posts"
            : "post_rate_limit_events";
      const operation =
        stage === "counter" ? sql.raw("UPDATE") : sql.raw("INSERT");
      await execute(
        sql`CREATE FUNCTION test_reject_publication() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Synthetic write failure'; END; $body$`,
      );
      await execute(
        sql`CREATE TRIGGER test_reject_publication BEFORE ${operation} ON ${sql.identifier(table)} FOR EACH ROW EXECUTE FUNCTION test_reject_publication()`,
      );
      try {
        const result = await run(
          Effect.exit(
            publish({
              authorId: a.id,
              body: "secret-body-must-not-appear-in-errors",
            }),
          ),
        );
        expect(failure(result)).toBeInstanceOf(DatabaseQueryError);
        expect(JSON.stringify(result)).not.toContain("secret-body");
        expect(await snapshot(a.id)).toEqual(before);
      } finally {
        await execute(
          sql`DROP TRIGGER test_reject_publication ON ${sql.identifier(table)}`,
        );
        await execute(sql`DROP FUNCTION test_reject_publication()`);
      }
      accepted(
        await run(publish({ authorId: a.id, body: "subsequent success" })),
      );
    },
  );
  it("cancels after complete Post insertion and rolls Post, counter and event back", async () => {
    const a = await identity();
    const before = await snapshot(a.id);
    await installGate();
    const release = await holdAdvisory();
    const fiber = Effect.runFork(
      publish({ authorId: a.id, body: "cancel after insert" }).pipe(
        Effect.provide(repository),
      ),
    );
    try {
      await awaitBlocked();
      await Effect.runPromise(Fiber.interrupt(fiber));
      expect(await snapshot(a.id)).toEqual(before);
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      await release();
      await removeGate();
    }
    accepted(await run(publish({ authorId: a.id, body: "lock released" })));
  });
  it("does not expose uncommitted Posts and allocates later order/time only after counter wait", async () => {
    const a = await identity();
    const b = await identity();
    const id = fixtureId();
    await installGate();
    const release = await holdAdvisory();
    const first = Effect.runFork(
      publish({ authorId: a.id, body: "held commit" }).pipe(
        Effect.provide(injected(Effect.succeed(id))),
      ),
    );
    try {
      await awaitBlocked();
      expect(
        await run(Effect.flatMap(PostRepository, (repo) => repo.find(id))),
      ).toEqual(Option.none());
      const second = Effect.runFork(
        publish({ authorId: b.id, body: "later commit" }).pipe(
          Effect.provide(repository),
        ),
      );
      try {
        await Effect.runPromise(Effect.sleep("100 millis"));
        expect(Option.isNone(await Effect.runPromise(Fiber.poll(second)))).toBe(
          true,
        );
        const bound = await query(
          sql`SELECT extract(epoch FROM clock_timestamp())::double precision AS seconds`,
          Schema.Struct({ seconds: Schema.Number }),
        );
        await release();
        const p = accepted(await Effect.runPromise(Fiber.join(first)));
        const q = accepted(await Effect.runPromise(Fiber.join(second)));
        expect(BigInt(q.publication_order)).toBeGreaterThan(
          BigInt(p.publication_order),
        );
        expect(Date.parse(q.published_at)).toBeGreaterThanOrEqual(
          Math.floor((bound[0]?.seconds ?? Infinity) * 1000),
        );
        expect(
          Option.isSome(
            await run(Effect.flatMap(PostRepository, (repo) => repo.find(id))),
          ),
        ).toBe(true);
      } finally {
        await Effect.runPromise(Fiber.interrupt(second));
      }
    } finally {
      await Effect.runPromise(Fiber.interrupt(first));
      await release();
      await removeGate();
    }
  });
  it("enforces SQL immutability even with explicit application-role write grants and verifies real indexes", async () => {
    const a = await identity();
    const post = accepted(
      await run(publish({ authorId: a.id, body: "immutable" })),
    );
    const role = sql.identifier(
      `writer_${crypto.randomUUID().replaceAll("-", "")}`,
    );
    await execute(sql`CREATE ROLE ${role} NOLOGIN`);
    await execute(sql`GRANT USAGE ON SCHEMA public TO ${role}`);
    await execute(
      sql`GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON posts, post_rate_limit_events TO ${role}`,
    );
    try {
      for (const statement of [
        sql`UPDATE posts SET body = 'tampered' WHERE id = ${post.id}`,
        sql`UPDATE posts SET metadata = '{"changed":true}'::jsonb WHERE id = ${post.id}`,
        sql`UPDATE posts SET author_id = ${crypto.randomUUID()}, publication_order = 99999999 WHERE id = ${post.id}`,
        sql`DELETE FROM posts WHERE id = ${post.id}`,
        sql`TRUNCATE posts CASCADE`,
      ]) {
        const exit = await runDirect(
          Effect.flatMap(DirectDatabase, (db) =>
            Effect.exit(
              db.transaction((session) =>
                session
                  .execute(() => sql`SET LOCAL ROLE ${role}`, Schema.Never)
                  .pipe(
                    Effect.zipRight(
                      session.execute(() => statement, Schema.Never),
                    ),
                  ),
              ),
            ),
          ),
        );
        const error = failure(exit);
        expect(error).toBeInstanceOf(DatabaseQueryError);
        if (error instanceof DatabaseQueryError)
          expect(error.state).toEqual(Option.some("55000"));
      }
    } finally {
      await execute(sql`DROP OWNED BY ${role}`);
      await execute(sql`DROP ROLE ${role}`);
    }
    expect(
      await run(Effect.flatMap(PostRepository, (repo) => repo.find(post.id))),
    ).toEqual(Option.some(post));
    const indexes = await query(
      sql`SELECT indexname, indexdef FROM pg_indexes WHERE tablename IN ('posts','post_rate_limit_events')`,
      Schema.Struct({ indexname: Schema.String, indexdef: Schema.String }),
    );
    for (const name of [
      "posts_publication_order_unique",
      "posts_feed_order_idx",
      "posts_reply_order_idx",
      "posts_author_order_idx",
      "posts_body_trgm_idx",
      "posts_metadata_idx",
      "post_rate_events_author_time_idx",
      "post_rate_events_expiry_idx",
    ])
      expect(indexes.some((row) => row.indexname === name)).toBe(true);
    expect(
      indexes.find((row) => row.indexname === "posts_body_trgm_idx")?.indexdef,
    ).toContain("gin_trgm_ops");
    expect(
      indexes.find((row) => row.indexname === "posts_metadata_idx")?.indexdef,
    ).toContain("jsonb_path_ops");
  });
  it("bounds maintenance batches, preserves active events and never removes Posts", async () => {
    const active = await identity();
    accepted(await run(publish({ authorId: active.id, body: "active" })));
    for (let i = 0; i < 9; i++) {
      const a = await identity();
      const prefix = fixtureId().slice(0, 17);
      await runDirect(
        Effect.flatMap(DirectDatabase, (db) =>
          db.transaction((session) =>
            Effect.gen(function* () {
              yield* session.execute(
                () =>
                  sql`WITH allocation AS (UPDATE publication_counter SET value = value + 60 WHERE id = 1 RETURNING value) INSERT INTO posts (id, author_id, author_name, body, publication_order, published_at) SELECT ${prefix} || lpad(n::text,4,'0'), ${a.id}::uuid, ${a.name}, 'expired-maintenance-fixture', allocation.value - 60 + n, clock_timestamp() - interval '120 seconds' FROM allocation, generate_series(1,60) n`,
                Schema.Never,
              );
              yield* session.execute(
                () =>
                  sql`INSERT INTO post_rate_limit_events (post_id,author_id,published_at) SELECT id,author_id,published_at FROM posts WHERE author_id = ${a.id}`,
                Schema.Never,
              );
            }),
          ),
        ),
      );
    }
    const postsBefore = await query(
      sql`SELECT count(*)::int AS n FROM posts`,
      Schema.Struct({ n: Schema.Int }),
    );
    expect(
      await run(Effect.flatMap(PostRepository, (repo) => repo.cleanupExpired)),
    ).toBe(512);
    const second = await run(
      Effect.flatMap(PostRepository, (repo) => repo.cleanupExpired),
    );
    expect(second).toBeGreaterThanOrEqual(28);
    expect(second).toBeLessThanOrEqual(512);
    expect(
      await run(Effect.flatMap(PostRepository, (repo) => repo.cleanupExpired)),
    ).toBe(0);
    expect(
      await query(
        sql`SELECT count(*)::int AS n FROM posts`,
        Schema.Struct({ n: Schema.Int }),
      ),
    ).toEqual(postsBefore);
    expect((await snapshot(active.id))[0]?.events).toBe(1);
  });
});

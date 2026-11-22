import { env } from "cloudflare:workers";
import { Effect, Layer, Option, Schema } from "effect";
import { nanoid } from "nanoid";
import { beforeAll, describe, expect, it } from "vitest";
import { PostResult, RegistrationResult } from "../src/api/contracts.js";
import { Publication } from "../src/api/services.js";
import {
  ForumStore,
  makeForumStore,
  StorageFailure,
} from "../src/database/store.js";
import { Authentication } from "../src/identity/service.js";
import { makeDispatcher } from "../src/runtime/dispatch.js";
import { requestLayer, type Execution } from "../src/runtime/context.js";
import { publicationLayer } from "../src/publication/service.js";
import { migrate } from "./d1.js";
const origin = "https://publishing.owner.workers.dev";
const execution: Execution = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
};
const app = makeDispatcher(() => Promise.resolve(new Response("read only")));
const request = (source: string, token: string, method = "POST") =>
  new Request(
    origin +
      "/v1/publish" +
      (method === "GET" ? `?payload=${encodeURIComponent(source)}` : ""),
    {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      ...(method === "POST" ? { body: source } : {}),
    },
  );
const register = async () => {
  const response = await app.fetch(
    new Request(origin + "/v1/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }),
    env,
    execution,
  );
  expect(response.status).toBe(201);
  return Schema.decodeUnknownPromise(RegistrationResult)(await response.json());
};
const publish = (input: unknown, key: string, method = "POST") =>
  app.fetch(request(JSON.stringify(input), key, method), env, execution);
const accepted = async (input: unknown, key: string, method = "POST") => {
  const response = await publish(input, key, method);
  expect(response.status).toBe(201);
  expect(response.headers.get("Cache-Control")).toBe("no-store, private");
  return Schema.decodeUnknownPromise(PostResult)(await response.json());
};
const count = (id: string) =>
  env.DB.prepare("SELECT count(*) AS n FROM posts WHERE author_id=?")
    .bind(id)
    .first<number>("n");
beforeAll(() => migrate());
describe("native authenticated publication endpoints", () => {
  it("publishes equivalent GET/POST complete immutable Posts with opaque first-occurrence Tags", async () => {
    const agent = await register();
    const body =
      "---\ntype: not metadata\n---\nraw\0 😀 [link](https://example.com)";
    const tags = [" A ", "a", "x:y/z", "A", " A ", "é", "e\u0301"];
    for (const method of ["GET", "POST"]) {
      const post = await accepted({ body, tags }, agent.apiKey, method);
      expect(post).toMatchObject({
        body,
        tags: [" A ", "a", "x:y/z", "A", "é", "e\u0301"],
        authorId: agent.id,
        reply_to: null,
      });
      const stored = Option.getOrThrow(
        await Effect.runPromise(makeForumStore(env.DB).readPost(post.id)),
      );
      expect(stored.body).toBe(body);
      expect(stored.tags).toEqual(post.tags);
      expect(stored.publicationOrder).toBe(post.publicationOrder);
    }
  });
  it("defaults Tags to empty and records only explicit local direct parents", async () => {
    const agent = await register();
    const parent = await accepted({ body: "parent" }, agent.apiKey);
    expect(parent.tags).toEqual([]);
    const reply = await accepted(
      { body: "correction", reply_to: parent.id },
      agent.apiKey,
      "GET",
    );
    expect(reply.reply_to).toBe(parent.id);
    const independent = await accepted(
      { body: `[parent](/posts/${parent.id})`, tags: [parent.id] },
      agent.apiKey,
    );
    expect(independent.reply_to).toBeNull();
    const missing = await publish(
      { body: "orphan", reply_to: nanoid() },
      agent.apiKey,
    );
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain("parent-not-found");
    expect(await count(agent.id)).toBe(3);
  });
  it("rejects unsupported facts, metadata, invalid bodies and nested tags before acceptance", async () => {
    const agent = await register();
    for (const input of [
      {},
      { body: "" },
      { body: 0 },
      { body: "ok", authorId: agent.id },
      { body: "ok", id: nanoid() },
      { body: "ok", publishedAt: "2000-01-01T00:00:00.000Z" },
      { body: "ok", metadata: {} },
      { body: "ok", tags: [null] },
      { body: "ok", tags: [["nested"]] },
      { body: "ok", tags: [{}] },
      { body: "ok", tags: [""] },
    ])
      expect((await publish(input, agent.apiKey)).status).toBe(400);
    expect(await count(agent.id)).toBe(0);
  });
  it("enforces count-before-dedup and byte/grapheme limits with actionable errors", async () => {
    const agent = await register();
    for (const [tags, limit] of [
      [Array(33).fill("same"), "32"],
      [["😀".repeat(65)], "256"],
      [["x".repeat(65)], "64"],
    ] as const) {
      const response = await publish({ body: "no", tags }, agent.apiKey);
      expect(response.status).toBe(400);
      expect(await response.text()).toContain(limit);
    }
    const post = await accepted(
      { body: "yes", tags: ["😀".repeat(64)] },
      agent.apiKey,
    );
    expect(post.tags.length).toBe(1);
  });
  it("bounds original JSON including whitespace/escapes and exact encoded GET before writing", async () => {
    const agent = await register();
    const source = '{"body":"\\u0061"}';
    const exact =
      source + " ".repeat(65536 - new TextEncoder().encode(source).length);
    expect(
      (await app.fetch(request(exact, agent.apiKey), env, execution)).status,
    ).toBe(201);
    expect(
      (await app.fetch(request(exact + " ", agent.apiKey), env, execution))
        .status,
    ).toBe(413);
    const base = request(JSON.stringify({ body: "x" }), agent.apiKey, "GET").url
      .length;
    const get = request(
      JSON.stringify({ body: "x".repeat(14336 - base + 1) }),
      agent.apiKey,
      "GET",
    );
    expect(new TextEncoder().encode(get.url).length).toBe(14336);
    expect((await app.fetch(get, env, execution)).status).toBe(201);
    expect(
      (
        await app.fetch(
          request(
            JSON.stringify({ body: "x".repeat(14336 - base + 2) }),
            agent.apiKey,
            "GET",
          ),
          env,
          execution,
        )
      ).status,
    ).toBe(413);
    expect(await count(agent.id)).toBe(2);
  });
  it("rolls back complete Post/Tags/FTS and quota on later failure without confusing it with429", async () => {
    const agent = await register();
    await env.DB.prepare(
      "CREATE TRIGGER fixture_endpoint_failure BEFORE INSERT ON post_tags WHEN NEW.tag='endpoint-rollback' BEGIN SELECT RAISE(ABORT,'synthetic private SQL failure'); END",
    ).run();
    try {
      const response = await publish(
        {
          body: "endpointrollbackuniquetoken",
          tags: ["first", "endpoint-rollback"],
        },
        agent.apiKey,
      );
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain("synthetic private");
    } finally {
      await env.DB.prepare("DROP TRIGGER fixture_endpoint_failure").run();
    }
    expect(await count(agent.id)).toBe(0);
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM post_fts WHERE post_fts MATCH 'endpointrollbackuniquetoken'",
      ).first("n"),
    ).toBe(0);
    expect(
      (await publish({ body: "accepted after rollback" }, agent.apiKey)).status,
    ).toBe(201);
  });
  it("protects immutable records and safe methods while permitting correction-by-reply", async () => {
    const agent = await register();
    const post = await accepted(
      { body: "original", tags: ["stable"] },
      agent.apiKey,
    );
    for (const method of ["HEAD", "OPTIONS", "PUT", "PATCH", "DELETE"]) {
      const response = await app.fetch(
        new Request(origin + "/v1/publish", {
          method,
          headers: { Authorization: `Bearer ${agent.apiKey}` },
        }),
        env,
        execution,
      );
      expect(response.status).toBe(
        ["HEAD", "OPTIONS"].includes(method) ? 204 : 405,
      );
    }
    expect(await count(agent.id)).toBe(1);
    await expect(
      env.DB.prepare("UPDATE posts SET body='changed' WHERE id=?")
        .bind(post.id)
        .run(),
    ).rejects.toThrow("forum_immutable_post");
    await accepted({ body: "correction", reply_to: post.id }, agent.apiKey);
  });
  it("does not retry ambiguous committed publication or return a success checkpoint", async () => {
    const agent = await register();
    const real = makeForumStore(env.DB);
    let attempts = 0;
    const uncertain = {
      ...real,
      publish: (input: Parameters<typeof real.publish>[0]) =>
        real.publish(input).pipe(
          Effect.flatMap(() => {
            attempts++;
            return Effect.fail(new StorageFailure());
          }),
        ),
    };
    const dependencies = Layer.merge(
      Layer.succeed(ForumStore, uncertain),
      Layer.succeed(Authentication, {
        authenticate: () => Effect.succeed({ agentId: agent.id }),
      }),
    );
    const program = Effect.flatMap(Publication, (service) =>
      service.publish(
        { body: "committed once", tags: ["retained"], parent: Option.none() },
        agent.apiKey,
      ),
    ).pipe(
      Effect.provide(
        publicationLayer.pipe(
          Layer.provide(dependencies),
          Layer.provide(
            requestLayer(env, execution, origin, crypto.randomUUID()),
          ),
        ),
      ),
    );
    expect(await Effect.runPromise(Effect.isSuccess(program))).toBe(false);
    expect(attempts).toBe(1);
    expect(await count(agent.id)).toBe(1);
  });
  it("shares the last slot concurrently and admits fresh bursts only in the next database window", async () => {
    const agent = await register();
    // Fixture timing only; the application never sleeps/paces accepted Posts.
    const seconds = await env.DB.prepare(
      "SELECT CAST(unixepoch()%60 AS INTEGER) AS n",
    ).first<number>("n");
    if (seconds !== null && seconds > 54)
      await new Promise((resolve) =>
        setTimeout(resolve, (61 - seconds) * 1000),
      );
    await env.DB.batch(
      Array.from({ length: 59 }, () =>
        env.DB.prepare(
          "INSERT INTO posts(id,author_id,body) VALUES (?,?,?)",
        ).bind(nanoid(), agent.id, "fixture prior slot"),
      ),
    );
    const before = await env.DB.prepare(
      "SELECT CAST(unixepoch()/60 AS INTEGER) AS n",
    ).first<number>("n");
    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        publish({ body: "competing slot" }, agent.apiKey),
      ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([
      201, 429, 429, 429,
    ]);
    expect(await count(agent.id)).toBe(60);
    for (const response of responses.filter((value) => value.status === 429)) {
      expect(response.headers.get("Retry-After")).toBe("60");
      const text = await response.text();
      expect(text).toContain("reserves no capacity");
      expect(text).toContain("Fixed windows");
    }
    const deadline = Date.now() + 65000;
    let bucket = before;
    while (bucket === before && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      bucket = await env.DB.prepare(
        "SELECT CAST(unixepoch()/60 AS INTEGER) AS n",
      ).first<number>("n");
    }
    expect(bucket === before).toBe(false);
    for (let n = 0; n < 3; n++)
      expect(
        (
          await publish(
            { body: "fresh window burst" },
            agent.apiKey,
            n % 2 ? "GET" : "POST",
          )
        ).status,
      ).toBe(201);
    expect(await count(agent.id)).toBe(63);
    const other = await register();
    expect(
      (await publish({ body: "other agent isolated" }, other.apiKey)).status,
    ).toBe(201);
  }, 90000);
});

import { env } from "cloudflare:workers";
import { Effect, Encoding, Option, Schema } from "effect";
import { nanoid } from "nanoid";
import { beforeAll, describe, expect, it } from "vitest";
import {
  AgentLookupResult,
  AgentPageResult,
  PostPageResult,
  RegistrationResult,
} from "../src/api/contracts.js";
import { decodeCursor } from "../src/api/query.js";
import { makeForumStore } from "../src/database/store.js";
import { makeDispatcher } from "../src/runtime/dispatch.js";
import type { Execution } from "../src/runtime/context.js";
import { migrate } from "./d1.js";
const origin = "https://directory.owner.workers.dev";
const execution: Execution = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
};
const app = makeDispatcher(() => Promise.resolve(new Response("read only")));
const call = (input: unknown, method = "POST", db = env.DB) => {
  const body = JSON.stringify(input);
  return app.fetch(
    new Request(
      origin +
        "/v1/search" +
        (method === "GET" ? "?payload=" + encodeURIComponent(body) : ""),
      {
        method,
        headers: { "Content-Type": "application/json" },
        ...(method === "POST" ? { body } : {}),
      },
    ),
    { ...env, DB: db },
    execution,
  );
};
const page = async (input: unknown = {}, method = "POST", db = env.DB) => {
  const response = await call(
    {
      resource: "agents",
      ...Schema.decodeUnknownSync(
        Schema.Record({ key: Schema.String, value: Schema.Unknown }),
      )(input),
    },
    method,
    db,
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store, private");
  return Schema.decodeUnknownPromise(AgentPageResult)(await response.json());
};
const register = async (name = "Agent" + nanoid().replace(/[_-]/g, "0")) => {
  const response = await app.fetch(
    new Request(origin + "/v1/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }),
    env,
    execution,
  );
  expect(response.status).toBe(201);
  return Schema.decodeUnknownPromise(RegistrationResult)(await response.json());
};
const publish = (authorId: string) =>
  Effect.runPromise(
    makeForumStore(env.DB).publish({
      authorId,
      body: "private-body-not-directory-data",
      tags: ["not-directory-data"],
      parentId: Option.none(),
    }),
  );
beforeAll(async () => {
  await migrate();
  await migrate(env.ISOLATED_DB);
});
describe("native public Agent Directory", () => {
  it("returns empty and one-identity directories including never-published identities", async () => {
    expect((await page()).agents).toEqual([]);
    const identity = await register("FirstDisplayCase");
    const result = await page({}, "GET");
    expect(result.agents).toEqual([
      {
        name: identity.name,
        latestPublishingTime: null,
        posts: { resource: "posts", author: identity.id },
      },
    ]);
    expect(result.pageCursor).toBeNull();
  });
  it("preserves display casing but resolves canonical names equivalently over anonymous GET and POST", async () => {
    const identity = await register("CanonicalDisplay");
    for (const method of ["GET", "POST"]) {
      for (const name of [
        "CanonicalDisplay",
        "canonicaldisplay",
        "CANONICALDISPLAY",
      ]) {
        const response = await call({ resource: "agents", name }, method);
        expect(response.status).toBe(200);
        const value = await Schema.decodeUnknownPromise(AgentLookupResult)(
          await response.json(),
        );
        expect(value.agent).toEqual({
          name: identity.name,
          latestPublishingTime: null,
          posts: { resource: "posts", author: identity.id },
        });
      }
      const missing = await call(
        { resource: "agents", name: "MissingIdentity" },
        method,
      );
      expect(missing.status).toBe(404);
      expect(await missing.text()).not.toContain("MissingIdentity");
    }
  });
  it("derives latest activity only from the most recent attributed Post and sorts by its actual publishing time", async () => {
    const a = await register();
    const b = await register();
    const never = await register();
    await publish(a.id);
    const bPost = await publish(b.id);
    const aLatest = await publish(a.id);
    const directory = await page({ limit: 100 });
    const aRecord = directory.agents.find((row) => row.name === a.name);
    const bRecord = directory.agents.find((row) => row.name === b.name);
    expect(aRecord?.latestPublishingTime).toBe(aLatest.publishedAt);
    expect(bRecord?.latestPublishingTime).toBe(bPost.publishedAt);
    expect(
      directory.agents.find((row) => row.name === never.name)
        ?.latestPublishingTime,
    ).toBeNull();
    const times = directory.agents.map((row) => row.latestPublishingTime);
    expect(times).toEqual(
      [...times].sort((left, right) =>
        left === null
          ? right === null
            ? 0
            : 1
          : right === null
            ? -1
            : right.localeCompare(left),
      ),
    );
  });
  it("returns complete bounded Agent pages and separate checked activity continuation without read checkpoints", async () => {
    for (let n = 0; n < 5; n++) await register();
    const expected = (await page({ limit: 100 })).agents.map((row) => row.name);
    let result = await page({ limit: 2 }, "GET");
    const names = result.agents.map((row) => row.name);
    expect(result.pageCursor).not.toBeNull();
    if (result.pageCursor)
      expect(
        await Effect.runPromise(decodeCursor(result.pageCursor)),
      ).toMatchObject({
        resource: "agents",
        purpose: "page",
        order: "activity",
        offset: 2,
      });
    while (result.pageCursor) {
      result = await page({ pageCursor: result.pageCursor, limit: 3 }, "POST");
      names.push(...result.agents.map((row) => row.name));
    }
    expect(names).toEqual(expected);
    expect("readCursor" in result).toBe(false);
    for (const limit of [0, 101, -1, 1.5])
      expect((await call({ resource: "agents", limit })).status).toBe(400);
  });
  it("exposes only public names/activity/local attributed-Post selections, never credential or body data", async () => {
    const identity = await register();
    const post = await publish(identity.id);
    const response = await call({ resource: "agents", name: identity.name });
    const text = await response.text();
    for (const forbidden of [
      identity.apiKey,
      "digest",
      "lookup_id",
      "lookupId",
      "apiKey",
      "readActivity",
      "views",
      "reputation",
      "capabilities",
      "private-body-not-directory-data",
      "not-directory-data",
      "createdAt",
    ])
      expect(text.includes(forbidden)).toBe(false);
    const lookup = await Schema.decodeUnknownPromise(AgentLookupResult)(
      JSON.parse(text),
    );
    expect(Object.keys(lookup.agent).sort()).toEqual([
      "latestPublishingTime",
      "name",
      "posts",
    ]);
    const posts = await call(lookup.agent.posts, "GET");
    const feed = await Schema.decodeUnknownPromise(PostPageResult)(
      await posts.json(),
    );
    expect(feed.posts.map((row) => row.id)).toEqual([post.id]);
    expect(lookup.agent.posts).toEqual({
      resource: "posts",
      author: identity.id,
    });
  });
  it("rejects Post-only/unknown modes and SQL injection before querying", async () => {
    for (const input of [
      { author: nanoid() },
      { parent: nanoid() },
      { id: nanoid() },
      { tags: [] },
      { q: "word" },
      { order: "newest" },
      { readCursor: "x" },
      { metadata: {} },
      { name: "x' OR 1=1 --" },
      { name: "x".repeat(40) },
    ]) {
      for (const method of ["GET", "POST"])
        expect(
          (await call({ resource: "agents", ...input }, method)).status,
        ).toBe(400);
    }
  });
  it("rejects wrong-resource/purpose/version cursors, unsafe offsets and checked-addition overflow", async () => {
    await register();
    await register();
    const initial = await page({ limit: 1 });
    expect(initial.pageCursor).not.toBeNull();
    const envelope = await Effect.runPromise(
      decodeCursor(initial.pageCursor ?? ""),
    );
    const token = (input: unknown) =>
      Encoding.encodeBase64Url(JSON.stringify(input));
    const invalid = [
      "!",
      "a".repeat(4097),
      token({ ...envelope, offset: -1 }),
      token({ ...envelope, offset: Number.MAX_SAFE_INTEGER + 1 }),
      token({ ...envelope, offset: Number.MAX_SAFE_INTEGER }),
      token({ ...envelope, version: 2 }),
      token({ ...envelope, extra: true }),
      token({ ...envelope, fingerprint: "0".repeat(64) }),
    ];
    for (const value of invalid)
      expect(
        (await call({ resource: "agents", pageCursor: value })).status,
      ).toBe(400);
    const postPageResponse = await call({});
    const postPage = await Schema.decodeUnknownPromise(PostPageResult)(
      await postPageResponse.json(),
    );
    expect(
      (await call({ resource: "agents", pageCursor: postPage.readCursor }))
        .status,
    ).toBe(400);
    expect((await call({ pageCursor: initial.pageCursor })).status).toBe(400);
    expect((await call({ readCursor: initial.pageCursor })).status).toBe(400);
    expect(
      (
        await call({
          resource: "agents",
          name: "FirstDisplayCase",
          pageCursor: initial.pageCursor,
        })
      ).status,
    ).toBe(400);
  });
  it("returns typed provider failure without false-empty success or SQL/user data reflection", async () => {
    await env.DB.prepare(
      "ALTER TABLE agents RENAME TO unavailable_agents",
    ).run();
    try {
      const response = await call({
        resource: "agents",
        name: "NeverReflectThisName",
      });
      expect(response.status).toBe(503);
      expect(response.headers.get("Content-Type")).toBe(
        "application/problem+json",
      );
      const text = await response.text();
      for (const forbidden of [
        "SELECT",
        "canonical_name",
        "NeverReflectThisName",
        "pageCursor",
        "readCursor",
        "stack",
      ])
        expect(text.includes(forbidden)).toBe(false);
    } finally {
      await env.DB.prepare(
        "ALTER TABLE unavailable_agents RENAME TO agents",
      ).run();
    }
  });
  it("isolates installations and leaves all identity/publishing/credential state untouched by repeated reads", async () => {
    const identity = await register();
    await publish(identity.id);
    const counts = async () =>
      (
        await env.DB.prepare(
          "SELECT (SELECT count(*) FROM agents) AS agents,(SELECT count(*) FROM posts) AS posts,(SELECT count(*) FROM credentials) AS credentials",
        ).all()
      ).results;
    const tables = async () =>
      (
        await env.DB.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        ).all()
      ).results;
    const before = await counts();
    const beforeTables = await tables();
    for (let n = 0; n < 3; n++) await page();
    expect(await counts()).toEqual(before);
    expect(await tables()).toEqual(beforeTables);
    expect((await page({}, "GET", env.ISOLATED_DB)).agents).toEqual([]);
    expect(
      (
        await call(
          { resource: "agents", name: identity.name },
          "GET",
          env.ISOLATED_DB,
        )
      ).status,
    ).toBe(404);
  });
  it("applies the published default50/maximum100 and continues without losing never-published identities", async () => {
    for (let n = 0; n < 101; n++) await register();
    const first = await page();
    expect(first.agents.length).toBe(50);
    expect(first.pageCursor).not.toBeNull();
    const maximum = await page({ limit: 100 });
    expect(maximum.agents.length).toBe(100);
    expect(maximum.pageCursor).not.toBeNull();
    const rest = await page({ limit: 100, pageCursor: maximum.pageCursor });
    expect(rest.pageCursor).toBeNull();
    const names = [...maximum.agents, ...rest.agents].map((row) => row.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBe(
      await env.DB.prepare("SELECT count(*) AS n FROM agents").first("n"),
    );
  });
});

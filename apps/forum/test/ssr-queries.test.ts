import { env } from "cloudflare:workers";
import { Effect, Option, Schema } from "effect";
import { nanoid } from "nanoid";
import { beforeAll, expect, it, vi } from "vitest";
import { makeDispatcher } from "../src/runtime/dispatch.js";
import type { Execution } from "../src/runtime/context.js";
import { decodeSearch } from "../src/api/query.js";
import { PostLookupResult } from "../src/api/contracts.js";
import { makeForumStore } from "../src/database/store.js";
import { migrate } from "./d1.js";
const execution: Execution = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
};
beforeAll(async () => {
  await migrate();
  await migrate(env.ISOLATED_DB);
});
it("provides public read services directly to the renderer without loopback HTTP or writes", async () => {
  const authorId = nanoid();
  const store = makeForumStore(env.DB);
  await Effect.runPromise(
    store.createIdentity({
      id: authorId,
      name: "SSRReader",
      lookupId: nanoid(),
      digest: "a".repeat(64),
    }),
  );
  const post = await Effect.runPromise(
    store.publish({
      authorId,
      body: "unchanged\0😀",
      tags: [" A ", "a"],
      parentId: Option.none(),
    }),
  );
  const input = await Effect.runPromise(decodeSearch({ id: post.id }));
  const network = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("No loopback HTTP permitted"));
  try {
    const app = makeDispatcher(async (_request, context) => {
      const result = await Effect.runPromise(context.search(input));
      return new Response(JSON.stringify(result), {
        headers: { "Cache-Control": "no-store, private" },
      });
    });
    const response = await app.fetch(
      new Request("https://ssr.owner.workers.dev/"),
      env,
      execution,
    );
    expect(response.status).toBe(200);
    const result = await Schema.decodeUnknownPromise(PostLookupResult)(
      await response.json(),
    );
    expect(result.post).toMatchObject({
      id: post.id,
      authorId,
      body: post.body,
      tags: post.tags,
    });
    expect(network).not.toHaveBeenCalled();
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM posts WHERE author_id=?")
        .bind(authorId)
        .first("n"),
    ).toBe(1);
  } finally {
    network.mockRestore();
  }
});
it("keeps renderer query dependencies request-local across independent bindings and origins", async () => {
  const authorId = nanoid();
  const store = makeForumStore(env.DB);
  await Effect.runPromise(
    store.createIdentity({
      id: authorId,
      name: "SSRIsolation",
      lookupId: nanoid(),
      digest: "a".repeat(64),
    }),
  );
  const post = await Effect.runPromise(
    store.publish({
      authorId,
      body: "local",
      tags: [],
      parentId: Option.none(),
    }),
  );
  const input = await Effect.runPromise(decodeSearch({ id: post.id }));
  const app = makeDispatcher(async (_request, context) => {
    const result = await Effect.runPromise(
      context.search(input).pipe(Effect.either),
    );
    return new Response(result._tag === "Left" ? result.left.type : "found", {
      status: result._tag === "Left" ? result.left.status : 200,
      headers: { "Cache-Control": "no-store, private" },
    });
  });
  expect(
    (
      await app.fetch(
        new Request("https://first.owner.workers.dev/"),
        env,
        execution,
      )
    ).status,
  ).toBe(200);
  const missing = await app.fetch(
    new Request("https://second.owner.workers.dev/"),
    { ...env, DB: env.ISOLATED_DB },
    execution,
  );
  expect(missing.status).toBe(404);
  expect(await missing.text()).toBe(
    "https://second.owner.workers.dev/docs/problems/not-found.json",
  );
});

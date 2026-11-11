import worker, {
  makeWorker,
  type WorkerExecutionContext,
} from "../../src/worker.js";
import { PostIdentifiers } from "../../src/posts/repository.js";
import { RegistrationSuccess } from "../../src/identity/contract.js";
import { env as nativeEnv } from "cloudflare:workers";
import { env } from "node:process";
import { sql } from "drizzle-orm";
import { Effect, Layer, Option, Redacted, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  DirectDatabase,
  databaseBindingsLayer,
  directDatabaseLayer,
} from "../../src/database/database.js";
import { Registration } from "../../src/identity/service.js";
import { registrationLive } from "../../src/identity/http.js";
import { MetadataObject } from "../../src/input/transport.js";
import { PostRecord } from "../../src/posts/contract.js";
import {
  EdgeAbuseSignal,
  edgeAbuseSignalLayer,
} from "../../src/publication/edge.js";
import {
  Publication,
  PublishingRateLimitedError,
} from "../../src/publication/service.js";
import { publicationLive } from "../../src/publication/live.js";
const config = Schema.decodeUnknownSync(
  Schema.Struct({
    DATABASE_TEST_DIRECT_URL: Schema.Redacted(Schema.NonEmptyString),
    DATABASE_TEST_CACHED_URL: Schema.Redacted(Schema.NonEmptyString),
  }),
)(env);
const nativeBinding = Schema.decodeUnknownSync(
  Schema.Struct({ PUBLISH_ABUSE: Schema.Unknown }),
)(nativeEnv);
const bindings = {
  ...nativeBinding,
  AUTH_CURRENT_PEPPER: "p2",
  AUTH_PEPPERS: JSON.stringify({ p2: "02".repeat(32) }),
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
const live = publicationLive(bindings);
const register = () =>
  Effect.runPromise(
    Effect.flatMap(Registration, (service) => service.register({})).pipe(
      Effect.provide(registrationLive(bindings)),
    ),
  );
const publish = (
  input: unknown,
  credential: Option.Option<Redacted.Redacted>,
) =>
  Effect.flatMap(Publication, (service) =>
    service.publish(input, credential),
  ).pipe(Effect.provide(live));
const snapshot = (author: string) =>
  Effect.runPromise(
    Effect.flatMap(DirectDatabase, (db) =>
      db.execute(
        () =>
          sql`SELECT (SELECT value::text FROM publication_counter WHERE id=1) AS counter,(SELECT count(*)::int FROM posts WHERE author_id=${author}) AS posts,(SELECT count(*)::int FROM post_rate_limit_events WHERE author_id=${author}) AS events`,
        Schema.Struct({
          counter: Schema.String,
          posts: Schema.Int,
          events: Schema.Int,
        }),
      ),
    ).pipe(Effect.provide(direct)),
  );

describe("authenticated publication orchestration in genuine PostgreSQL/workerd", () => {
  it("preserves full typed raw content, server facts and direct replies through real credential verification", async () => {
    const issued = await register();
    const key = Option.some(issued.api_key);
    const body =
      "---\nauthor_name: forged\npublished_at: 1900-01-01\n---\n# unchanged Markdown\n";
    const metadata = Schema.decodeUnknownSync(MetadataObject)(
      JSON.parse(
        '{"author_name":"forged","published_at":null,"n":1,"bool":false,"nested":{"items":[{"x":2}]},"__proto__":{"own":true}}',
      ),
    );
    const parent = await Effect.runPromise(publish({ body, metadata }, key));
    expect(parent.body).toBe(body);
    expect(parent.metadata).toEqual(metadata);
    expect(Object.hasOwn(parent.metadata, "__proto__")).toBe(true);
    expect(parent.metadata).not.toHaveProperty("type");
    expect(parent.author_id).toBe(issued.id);
    expect(parent.author_name).toBe(issued.name);
    expect(parent.published_at).toMatch(
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/,
    );
    expect(parent.id).toMatch(/^[A-Za-z0-9_-]{21}$/);
    const reply = await Effect.runPromise(
      publish({ body: "correction", reply_to: parent.id }, key),
    );
    expect(Option.getOrThrow(reply.reply_to_id)).toBe(parent.id);
    expect(BigInt(reply.publication_order)).toBeGreaterThan(
      BigInt(parent.publication_order),
    );
    const encoded = await Effect.runPromise(Schema.encode(PostRecord)(reply));
    expect(encoded.reply_to_id).toBe(parent.id);
    expect(JSON.stringify(encoded)).not.toContain(
      Redacted.value(issued.api_key),
    );
  });
  it("rejects missing/invalid credentials, invalid bodies and platform overrides without publication accounting", async () => {
    const issued = await register();
    const before = await snapshot(issued.id);
    for (const credential of [
      Option.none<Redacted.Redacted>(),
      Option.some(Redacted.make("invalid")),
      Option.some(Redacted.make(`af_v1.${"0".repeat(32)}.${"0".repeat(64)}`)),
    ]) {
      expect(
        await Effect.runPromise(
          Effect.either(publish({ body: "not published" }, credential)),
        ),
      ).toMatchObject({
        _tag: "Left",
        left: { _tag: "AuthenticationDeniedError" },
      });
    }
    for (const input of [
      {},
      { body: "" },
      { body: "x", authorId: issued.id },
      { body: "x", author_name: "forged" },
      { body: "x", published_at: "1900-01-01" },
    ]) {
      expect(
        await Effect.runPromise(
          Effect.either(publish(input, Option.some(issued.api_key))),
        ),
      ).toMatchObject({
        _tag: "Left",
        left: { _tag: "PublicationInvalidError" },
      });
    }
    expect(await snapshot(issued.id)).toEqual(before);
  });
  it("rejects a missing parent atomically and accepts a later correction as another immutable Post", async () => {
    const issued = await register();
    const before = await snapshot(issued.id);
    expect(
      await Effect.runPromise(
        Effect.either(
          publish(
            { body: "missing parent", reply_to: "_".repeat(21) },
            Option.some(issued.api_key),
          ),
        ),
      ),
    ).toMatchObject({
      _tag: "Left",
      left: { _tag: "PostParentNotFoundError" },
    });
    expect(await snapshot(issued.id)).toEqual(before);
    const post = await Effect.runPromise(
      publish({ body: "original" }, Option.some(issued.api_key)),
    );
    const reply = await Effect.runPromise(
      publish(
        { body: `corrects ${post.id}`, reply_to: post.id },
        Option.some(issued.api_key),
      ),
    );
    expect(reply.id).not.toBe(post.id);
    expect(post.body).toBe("original");
  });
  it("enters exact SQL accounting despite genuine native edge denial and preserves the database retry decision", async () => {
    const issued = await register();
    // This fixture's genuine native binding is deliberately 1/60, not production
    // policy. Force advisory denial while the real SQL publisher is eligible.
    const signal = () =>
      Effect.runPromise(
        Effect.flatMap(EdgeAbuseSignal, (service) =>
          service.observe(issued.api_key),
        ).pipe(Effect.provide(edgeAbuseSignalLayer(bindings))),
      );
    expect(await signal()).toBe("allow");
    expect(await signal()).toBe("deny");
    for (let i = 0; i < 60; i++)
      expect(
        (
          await Effect.runPromise(
            publish(
              { body: `accepted ${String(i)}` },
              Option.some(issued.api_key),
            ),
          )
        ).author_id,
      ).toBe(issued.id);
    const before = await snapshot(issued.id);
    const result = await Effect.runPromise(
      Effect.either(
        publish({ body: "over limit" }, Option.some(issued.api_key)),
      ),
    );
    expect(result._tag).toBe("Left");
    if (
      result._tag !== "Left" ||
      !(result.left instanceof PublishingRateLimitedError)
    )
      throw new Error("Expected an authoritative rate decision");
    const denied = result.left;
    const oldest = await Effect.runPromise(
      Effect.flatMap(DirectDatabase, (db) =>
        db.execute(
          () =>
            sql`SELECT to_char(min(published_at) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS oldest FROM post_rate_limit_events WHERE author_id=${issued.id}`,
          Schema.Struct({ oldest: Schema.String }),
        ),
      ).pipe(Effect.provide(direct)),
    );
    expect(denied.retryAfter).toBe(
      Math.ceil(
        (Date.parse(oldest[0]?.oldest ?? "invalid") +
          60_000 -
          Date.parse(denied.decidedAt)) /
          1000,
      ),
    );
    expect(denied.retryAfter).toBeGreaterThan(0);
    expect(await snapshot(issued.id)).toEqual(before);
  });
});

const execution: WorkerExecutionContext = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
};
const runtimeBindings = {
  ...bindings,
  ENVIRONMENT: "local",
  CURSOR_CURRENT_KEY: "r1",
  CURSOR_KEYS: JSON.stringify({ r1: "33".repeat(32) }),
};
const httpRequest = (
  method: string,
  document: string,
  credential?: string,
  operation = "publish",
) =>
  new Request(
    "https://api.agentforum.test/v1/" +
      operation +
      (method === "GET" ? "?payload=" + encodeURIComponent(document) : ""),
    {
      method,
      headers: {
        ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
        ...(credential === undefined
          ? {}
          : { Authorization: `Bearer ${credential}` }),
      },
      ...(method === "POST" ? { body: document } : {}),
    },
  );
const http = (
  method: string,
  document: string,
  credential?: string,
  operation = "publish",
) =>
  worker.fetch(
    httpRequest(method, document, credential, operation),
    runtimeBindings,
    execution,
  );
const httpIdentity = async (method = "POST") => {
  const response = await http(method, "{}", undefined, "register");
  expect(response.status).toBe(201);
  return Effect.runPromise(
    Schema.decodeUnknown(Schema.parseJson(RegistrationSuccess))(
      await response.text(),
    ),
  );
};
const decodePost = async (response: Response) =>
  Effect.runPromise(
    Schema.decodeUnknown(Schema.parseJson(PostRecord))(await response.text()),
  );
describe("actual anonymous signup and authenticated publication HTTP against PostgreSQL", () => {
  it("implements identical GET/POST semantics, unchanged content, replies and public readback", async () => {
    for (const method of ["GET", "POST"]) {
      const issued = await httpIdentity(method),
        key = Redacted.value(issued.api_key);
      const document = JSON.stringify({
        body: "---\nauthor_name: forged\n---\n# raw",
        metadata: {
          n: 1,
          b: false,
          items: [{ x: null }],
          author_name: "forged",
        },
      });
      const response = await http(method, document, key);
      expect(response.status).toBe(201);
      expect(response.headers.get("Cache-Control")).toBe("no-store, private");
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
      const post = await decodePost(response);
      expect(post.author_id).toBe(issued.id);
      expect(post.author_name).toBe(issued.name);
      expect(post.metadata).toEqual({
        n: 1,
        b: false,
        items: [{ x: null }],
        author_name: "forged",
      });
      const lookup = await http(
        method,
        JSON.stringify({ id: post.id }),
        undefined,
        "search",
      );
      expect(lookup.status).toBe(200);
      const encoded = await Effect.runPromise(Schema.encode(PostRecord)(post));
      expect(
        Schema.decodeUnknownSync(
          Schema.Struct({ posts: Schema.Array(Schema.Unknown) }),
        )(await lookup.json()).posts,
      ).toEqual([encoded]);
      const replyResponse = await http(
        method,
        JSON.stringify({ body: "correction", reply_to: post.id }),
        key,
      );
      expect(replyResponse.status).toBe(201);
      expect(
        Option.getOrThrow((await decodePost(replyResponse)).reply_to_id),
      ).toBe(post.id);
    }
  });
  it("rejects invalid credentials, missing parents and spoofed platform fields without writes", async () => {
    const issued = await httpIdentity(),
      key = Redacted.value(issued.api_key),
      before = await snapshot(issued.id);
    for (const method of ["GET", "POST"]) {
      for (const credential of [
        undefined,
        "invalid",
        `af_v1.${"0".repeat(32)}.${"0".repeat(64)}`,
      ]) {
        const response = await http(
          method,
          '{"body":"unauthorized"}',
          credential,
        );
        expect(response.status).toBe(401);
        expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
      }
      expect(
        (
          await http(
            method,
            JSON.stringify({ body: "missing", reply_to: "_".repeat(21) }),
            key,
          )
        ).status,
      ).toBe(404);
      for (const fields of [
        { author_id: issued.id },
        { author_name: issued.name },
        { published_at: "1900-01-01" },
        { publication_order: "1" },
        { id: "x".repeat(21) },
      ])
        expect(
          (
            await http(
              method,
              JSON.stringify({ body: "spoof", ...fields }),
              key,
            )
          ).status,
        ).toBe(400);
    }
    expect(await snapshot(issued.id)).toEqual(before);
  });
  it("returns exact integer Retry-After on real SQL denial across both HTTP transports", async () => {
    const issued = await httpIdentity(),
      key = Redacted.value(issued.api_key);
    for (let n = 0; n < 60; n++)
      await Effect.runPromise(
        publish({ body: `window ${String(n)}` }, Option.some(issued.api_key)),
      );
    const before = await snapshot(issued.id);
    for (const method of ["GET", "POST"]) {
      const response = await http(method, '{"body":"denied"}', key);
      expect(response.status).toBe(429);
      const problem = Schema.decodeUnknownSync(
        Schema.Struct({
          status: Schema.Literal(429),
          retry_after: Schema.Number.pipe(Schema.int(), Schema.greaterThan(0)),
        }),
      )(await response.json());
      expect(response.headers.get("Retry-After")).toBe(
        String(problem.retry_after),
      );
      expect(response.headers.get("Cache-Control")).toBe("no-store, private");
    }
    expect(await snapshot(issued.id)).toEqual(before);
  });
  it("rolls back real insert failures and bounded ID collisions, then recovers without leaking details", async () => {
    const issued = await httpIdentity(),
      key = Redacted.value(issued.api_key),
      before = await snapshot(issued.id);
    const execute = (query: ReturnType<typeof sql>) =>
      Effect.runPromise(
        Effect.flatMap(DirectDatabase, (db) =>
          db.execute(() => query, Schema.Never),
        ).pipe(Effect.provide(direct)),
      );
    await execute(
      sql`CREATE FUNCTION test_reject_http_publication() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private database fixture failure'; END $$`,
    );
    await execute(
      sql`CREATE TRIGGER test_reject_http_publication BEFORE INSERT ON posts FOR EACH ROW EXECUTE FUNCTION test_reject_http_publication()`,
    );
    try {
      for (const method of ["GET", "POST"]) {
        const response = await http(method, '{"body":"rolled back"}', key);
        expect(response.status).toBe(500);
        expect(await response.text()).not.toContain(
          "private database fixture failure",
        );
      }
      expect(await snapshot(issued.id)).toEqual(before);
    } finally {
      await execute(sql`DROP TRIGGER test_reject_http_publication ON posts`);
      await execute(sql`DROP FUNCTION test_reject_http_publication()`);
    }
    const existing = await decodePost(
      await http("POST", '{"body":"original"}', key),
    );
    const beforeCollision = await snapshot(issued.id);
    let calls = 0;
    const recoveryId =
      "c" + crypto.randomUUID().replaceAll("-", "").slice(0, 20);
    const identifiers = Layer.succeed(PostIdentifiers, {
      next: Effect.sync(() => {
        calls++;
        return calls <= 4 ? existing.id : recoveryId;
      }),
    });
    const app = makeWorker(undefined, undefined, undefined, (b) =>
      publicationLive(b, identifiers),
    );
    const failed = await app.fetch(
      httpRequest("POST", '{"body":"collision"}', key),
      runtimeBindings,
      execution,
    );
    expect(failed.status).toBe(500);
    expect(calls).toBe(4);
    expect(await snapshot(issued.id)).toEqual(beforeCollision);
    const recovered = await app.fetch(
      httpRequest("GET", '{"body":"recovered"}', key),
      runtimeBindings,
      execution,
    );
    expect(recovered.status).toBe(201);
    expect((await decodePost(recovered)).id).toBe(recoveryId);
    expect(calls).toBe(5);
  });
});

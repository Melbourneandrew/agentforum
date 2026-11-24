import { env } from "cloudflare:workers";
import { Effect, Either, Schema } from "effect";
import { describe, expect, inject, it } from "vitest";
import { Identity, failure } from "../../../scripts/delivery/model.js";
import {
  Artifact,
  ReleaseCoordinator,
  ReleasePorts,
} from "../../../scripts/delivery/release-model.js";
import { release } from "../../../scripts/delivery/release.js";
import {
  inspectReadiness,
  ReadinessHttp,
} from "../../../scripts/delivery/release-readiness.js";
import {
  PostPageResult,
  PostResult,
  RegistrationResult,
} from "../src/api/contracts.js";
import { makeDispatcher } from "../src/runtime/dispatch.js";
import type { Bindings, Execution } from "../src/runtime/context.js";

interface Migration {
  name: string;
  queries: string[];
}
const identity = Schema.decodeUnknownSync(Identity)({
  version: 1,
  accountId: "a".repeat(32),
  workerName: "release-forum",
  databaseName: "release-database",
  databaseId: "11111111-1111-1111-1111-111111111111",
  defaultOrigin: "https://release-forum.owner.workers.dev",
});
const execution: Execution = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
};
// The actual same-version API implementation runs against native D1 before and
// after migrations. This is storage/API compatibility, NOT Worker-upload proof.
const runningApp = makeDispatcher(() =>
  Promise.resolve(new Response("read only")),
);
const call = (
  db: Bindings["DB"],
  operation: string,
  input: unknown,
  method = "POST",
  key = "",
) => {
  const body = JSON.stringify(input);
  return runningApp.fetch(
    new Request(
      `${identity.defaultOrigin}/v1/${operation}${method === "GET" ? `?payload=${encodeURIComponent(body)}` : ""}`,
      {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
        },
        ...(method === "POST" ? { body } : {}),
      },
    ),
    { ...env, DB: db },
    execution,
  );
};
const hash = async (text: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
const manifest = async (plan: Migration[]) =>
  Promise.all(
    plan.map(async (migration) => ({
      name: migration.name,
      digest: await hash(JSON.stringify(migration.queries)),
    })),
  );
const apply = async (db: Bindings["DB"], plan: Migration[]) => {
  await db
    .prepare("CREATE TABLE IF NOT EXISTS d1_migrations(name TEXT PRIMARY KEY)")
    .run();
  for (const migration of plan) {
    if (
      await db
        .prepare("SELECT name FROM d1_migrations WHERE name=?")
        .bind(migration.name)
        .first()
    )
      continue;
    await db.batch([
      ...migration.queries.map((query) => db.prepare(query)),
      db
        .prepare("INSERT INTO d1_migrations(name) VALUES (?)")
        .bind(migration.name),
    ]);
  }
};
const native = (use: () => Promise<void>) =>
  Effect.tryPromise({
    try: use,
    catch: () => failure("initialization", "native-d1-migration-failed"),
  });
const harness = async (
  db: Bindings["DB"],
  plan: Migration[],
  compatible = false,
) => {
  const history = await manifest(plan);
  const schemaDigest = await hash(JSON.stringify(history));
  const artifact = Schema.decodeUnknownSync(Artifact)({
    identity,
    sourceRevision: "b".repeat(40),
    artifactDigest: "c".repeat(64),
    schemaDigest,
    configPath: "/native-fixture/not-provider-build.json",
    migrations: history,
    compatibleSchemas: compatible ? [schemaDigest] : [],
  });
  const events: string[] = [];
  const ports: typeof ReleasePorts.Service = {
    build: () => Effect.succeed(artifact),
    verify: () => Effect.void,
    installed: () =>
      Effect.tryPromise({
        try: async () => {
          const rows = await db
            .prepare("SELECT name FROM d1_migrations ORDER BY name")
            .all<{ name: string }>();
          const installed = rows.results.map((row) => {
            const item = history.find(
              (migration) => migration.name === row.name,
            );
            if (!item) throw new Error("unknown migration");
            return item;
          });
          return {
            databaseId: identity.databaseId,
            schemaDigest: await hash(JSON.stringify(installed)),
          };
        },
        catch: () => failure("initialization", "native-history-unreadable"),
      }),
    migrate: (_, token) =>
      native(() => apply(db, plan)).pipe(
        Effect.as({
          ...token,
          identity,
          sourceRevision: artifact.sourceRevision,
          artifactDigest: artifact.artifactDigest,
          operationRef: "native-local-migrations",
          outcome: "succeeded" as const,
        }),
      ),
    activate: (_, token) =>
      Effect.sync(() => {
        events.push("activation-boundary-only");
        return {
          receipt: {
            ...token,
            identity,
            sourceRevision: artifact.sourceRevision,
            artifactDigest: artifact.artifactDigest,
            operationRef: "native-local-activation-fixture",
            outcome: "succeeded" as const,
          },
          activation: {
            sourceRevision: artifact.sourceRevision,
            artifactDigest: artifact.artifactDigest,
            version: "native-fixture-no-provider-version",
          },
        };
      }),
    readiness: (value, activation) =>
      inspectReadiness(value, activation, "/docs/openapi.json").pipe(
        Effect.provideService(ReadinessHttp, {
          request: (request) =>
            Effect.tryPromise({
              try: () =>
                runningApp.fetch(request, { ...env, DB: db }, execution),
              catch: () => failure("readiness", "native-request-failed"),
            }),
        }),
      ),
  };
  // Explicitly a single-executor test double, not distributed serialization.
  const coordinator: typeof ReleaseCoordinator.Service = {
    acquire: () =>
      Effect.succeed({
        assertHeld: Effect.void,
        arm: (kind) =>
          Effect.succeed({
            kind,
            ownerId: "33333333-3333-3333-3333-333333333333",
            generation: 1,
            sequence: 1,
          }),
        terminal: () => Effect.void,
        close: (outcome) =>
          Effect.sync(() => {
            events.push(outcome);
          }),
      }),
  };
  const run = (operation = "update") =>
    Effect.runPromise(
      Effect.either(
        release({
          identity,
          sourceRevision: artifact.sourceRevision,
          operation,
        }).pipe(
          Effect.provideService(ReleasePorts, ports),
          Effect.provideService(ReleaseCoordinator, coordinator),
        ),
      ),
    );
  return { run, events };
};
describe("WO-34 actual native D1 storage qualification", () => {
  it("initializes empty D1 through the lifecycle and refuses incomplete product readiness", async () => {
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS d1_migrations(name TEXT PRIMARY KEY)",
    ).run();
    const h = await harness(env.DB, inject("migrations"));
    const result = await h.run();
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) expect(result.left.stage).toBe("readiness");
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM d1_migrations").first(
        "n",
      ),
    ).toBe(inject("migrations").length);
    expect(
      (await call(env.DB, "register", { name: "EmptyReleaseAgent" })).status,
    ).toBe(201);
    expect(h.events).toEqual(["activation-boundary-only", "acknowledged"]);
  });
  it("retains prior-version Agents/keys/Posts/checkpoints after committed migrations, failure, retry and compatible application reuse", async () => {
    const db = env.ISOLATED_DB,
      baseline = inject("migrations");
    await apply(db, baseline.slice(0, 2));
    const signup = await call(db, "register", { name: "RetainedReleaseAgent" });
    expect(signup.status).toBe(201);
    const agent = await Schema.decodeUnknownPromise(RegistrationResult)(
      await signup.json(),
    );
    const priorId = "HistoricalPostFixture";
    await db
      .prepare(
        "INSERT INTO posts(id,author_id,body,published_at,publication_window) VALUES (?,?,?,'2000-01-01T00:00:00.000Z',15778080)",
      )
      .bind(priorId, agent.id, "historicaltoken unchanged")
      .run();
    const before = await call(db, "search", { author: agent.id }, "GET");
    expect(before.status).toBe(200);
    const checkpoint = await Schema.decodeUnknownPromise(PostPageResult)(
      await before.json(),
    );
    expect(checkpoint.posts.map((post) => post.id)).toEqual([priorId]);
    // Fixture-only additive index and bounded backfill: no production/control schema.
    const additive: Migration = {
      name: "99990001_fixture_additive.sql",
      queries: [
        "CREATE INDEX fixture_release_body ON posts(body)",
        "CREATE TABLE fixture_release_backfill(post_id TEXT PRIMARY KEY)",
        "INSERT INTO fixture_release_backfill SELECT id FROM posts ORDER BY publication_order LIMIT 2",
      ],
    };
    const failed: Migration = {
      name: "99990002_fixture_failure.sql",
      queries: [
        "CREATE TABLE fixture_release_rolled_back(value TEXT)",
        "SELECT * FROM fixture_release_missing",
      ],
    };
    const broken = await harness(db, [...baseline, additive, failed]);
    const failureResult = await broken.run();
    expect(Either.isLeft(failureResult)).toBe(true);
    expect(broken.events).toEqual(["uncertain"]);
    expect(
      await db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='fixture_release_rolled_back'",
        )
        .first(),
    ).toBeNull();
    expect(
      await db
        .prepare("SELECT count(*) AS n FROM fixture_release_backfill")
        .first("n"),
    ).toBe(1);
    expect(
      await db
        .prepare(
          "SELECT count(*) AS n FROM post_fts WHERE post_fts MATCH 'historicaltoken'",
        )
        .first("n"),
    ).toBe(1);
    await expect(
      db
        .prepare("UPDATE posts SET body='changed' WHERE id=?")
        .bind(priorId)
        .run(),
    ).rejects.toThrow();
    const corrected = {
      ...failed,
      queries: [
        "CREATE INDEX fixture_release_author_body ON posts(author_id,body)",
      ],
    };
    const fixedPlan = [...baseline, additive, corrected];
    const retry = await harness(db, fixedPlan);
    const retryResult = await retry.run();
    expect(Either.isLeft(retryResult)).toBe(true);
    expect(retry.events).toEqual(["activation-boundary-only", "acknowledged"]);
    await apply(db, fixedPlan); // Native history makes the committed prefix a no-op.
    const accepted = await call(
      db,
      "publish",
      { body: "after release retry", tags: ["Retained"] },
      "POST",
      agent.apiKey,
    );
    expect(accepted.status).toBe(201);
    const post = await Schema.decodeUnknownPromise(PostResult)(
      await accepted.json(),
    );
    for (const method of ["GET", "POST"]) {
      const resumed = await call(
        db,
        "search",
        { author: agent.id, readCursor: checkpoint.readCursor },
        method,
      );
      expect(resumed.status).toBe(200);
      expect(
        (
          await Schema.decodeUnknownPromise(PostPageResult)(
            await resumed.json(),
          )
        ).posts.map((value) => value.id),
      ).toEqual([post.id]);
    }
    const recovery = await harness(db, fixedPlan, true);
    const recovered = await recovery.run("recover");
    expect(Either.isLeft(recovered)).toBe(true);
    expect(recovery.events).toEqual([
      "activation-boundary-only",
      "acknowledged",
    ]);
    expect(
      (
        await call(
          db,
          "publish",
          { body: "same API key after compatible application reuse" },
          "GET",
          agent.apiKey,
        )
      ).status,
    ).toBe(201);
    expect(
      await db
        .prepare("SELECT body FROM posts WHERE id=?")
        .bind(priorId)
        .first("body"),
    ).toBe("historicaltoken unchanged");
    expect(
      (await db.prepare("PRAGMA foreign_key_check").all()).results,
    ).toEqual([]);
    expect(
      await db.prepare("SELECT count(*) AS n FROM d1_migrations").first("n"),
    ).toBe(fixedPlan.length);
  });
});

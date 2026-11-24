import { env } from "cloudflare:workers";
import { Deferred, Effect, Either, Option, Schema } from "effect";
import { beforeEach, describe, expect, inject, it } from "vitest";
import { Identity, failure } from "../../../scripts/delivery/model.js";
import { Artifact } from "../../../scripts/delivery/release-model.js";
import {
  bootstrapControl,
  NativeControlMigrations,
  verifyControlBootstrap,
} from "../../../scripts/delivery/control-bootstrap.js";
import {
  CONTROL_FILE,
  CONTROL_HISTORY,
  ControlDatabase,
  makeControlCoordinator,
  NATIVE_HISTORY_SQL,
  QuiescenceVerifier,
  readControl,
  reconcileControl,
  unavailableQuiescence,
  type EffectToken,
  type TerminalReceipt,
} from "../../../scripts/delivery/release-control.js";

declare module "vitest" {
  interface ProvidedContext {
    controlV1: string;
    controlMigrations: { name: string; queries: string[] }[];
  }
}
const identity = Schema.decodeUnknownSync(Identity)({
  version: 1,
  accountId: "a".repeat(32),
  workerName: "control-forum",
  databaseName: "control-database",
  databaseId: "11111111-1111-1111-1111-111111111111",
  defaultOrigin: "https://control-forum.owner.workers.dev",
});
const artifact = Schema.decodeUnknownSync(Artifact)({
  identity,
  sourceRevision: "b".repeat(40),
  artifactDigest: "c".repeat(64),
  schemaDigest: "d".repeat(64),
  configPath: "/local/target.json",
  migrations: [],
  compatibleSchemas: [],
});
const ownerA = "22222222-2222-2222-2222-222222222222",
  ownerB = "33333333-3333-3333-3333-333333333333";
const database = (): typeof ControlDatabase.Service => ({
  identity,
  query: (sql, params) =>
    Effect.tryPromise({
      try: async () => {
        const response = await env.ISOLATED_DB.prepare(sql)
          .bind(...params)
          .all();
        return response.results;
      },
      catch: () => failure("initialization", "local-d1-query-failed"),
    }),
});
const native = (): typeof NativeControlMigrations.Service => ({
  v1: inject("controlV1"),
  applyV1: Effect.tryPromise({
    try: async () => {
      await env.ISOLATED_DB.prepare(NATIVE_HISTORY_SQL).run();
      for (const migration of inject("controlMigrations")) {
        if (
          await env.ISOLATED_DB.prepare(
            `SELECT name FROM ${CONTROL_HISTORY} WHERE name=?`,
          )
            .bind(migration.name)
            .first()
        )
          continue;
        // Official Wrangler chunks + its exact history insert in ONE native batch.
        await env.ISOLATED_DB.batch([
          ...migration.queries.map((sql) => env.ISOLATED_DB.prepare(sql)),
          env.ISOLATED_DB.prepare(
            `INSERT INTO "${CONTROL_HISTORY}" (name)\nvalues ('${migration.name}');`,
          ),
        ]);
      }
    },
    catch: () => failure("initialization", "local-native-migration-failed"),
  }),
});
const run = <A, E>(
  effect: Effect.Effect<A, E, ControlDatabase | NativeControlMigrations>,
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(ControlDatabase, database()),
      Effect.provideService(NativeControlMigrations, native()),
    ),
  );
const coordinator = (ownerId = ownerA) =>
  makeControlCoordinator({
    artifact,
    ownerId,
    executorRef: `local:${ownerId}`,
  });
const receipt = (
  token: EffectToken,
  outcome: TerminalReceipt["outcome"] = "succeeded",
): TerminalReceipt => ({
  ...token,
  identity,
  sourceRevision: artifact.sourceRevision,
  artifactDigest: artifact.artifactDigest,
  operationRef: "local:terminal:1",
  outcome,
});
const errorCode = <A>(result: Either.Either<A, { readonly code: string }>) =>
  Either.isLeft(result) ? result.left.code : "unexpected-success";

describe("WO34 approved operational controls on actual native D1 (not provider proof)", () => {
  // Disposable qualification binding ONLY. The pinned plugin shares state
  // within a file; clean only this suite's fixture/control tables per case.
  beforeEach(async () => {
    for (const name of [
      "agentforum_release_control",
      "agentforum_release_migrations",
      "local_race_probe",
      "local_delayed_effect",
    ])
      await env.ISOLATED_DB.prepare(`DROP TABLE IF EXISTS ${name}`).run();
  });

  it("bootstraps only frozen native operational history, then performs read-only repeat verification", async () => {
    await run(bootstrapControl());
    expect(await run(verifyControlBootstrap())).toBe(true);
    await run(
      bootstrapControl().pipe(
        Effect.provideService(NativeControlMigrations, {
          ...native(),
          applyV1: Effect.die("must not replay"),
        }),
      ),
    );
    expect(
      await env.ISOLATED_DB.prepare(
        `SELECT name FROM ${CONTROL_HISTORY}`,
      ).all(),
    ).toMatchObject({ results: [{ name: CONTROL_FILE }] });
    expect(
      await env.ISOLATED_DB.prepare(
        "SELECT name FROM sqlite_master WHERE name='posts'",
      ).first(),
    ).toBeNull();
    expect(await run(readControl(database()))).toEqual(Option.none());
  });
  it("races cold native bootstraps with one committed unique history and no business effects", async () => {
    const results = await Promise.all([
      run(Effect.either(bootstrapControl())),
      run(Effect.either(bootstrapControl())),
    ]);
    expect(results.some(Either.isRight)).toBe(true);
    expect(await run(verifyControlBootstrap())).toBe(true);
    expect(
      await env.ISOLATED_DB.prepare(
        `SELECT count(*) AS n FROM ${CONTROL_HISTORY}`,
      ).first("n"),
    ).toBe(1);
  });
  it("rejects incompatible pre-existing schema instead of hiding it with IF NOT EXISTS", async () => {
    await env.ISOLATED_DB.prepare(
      "CREATE TABLE agentforum_release_control(slot INTEGER)",
    ).run();
    expect(errorCode(await run(Effect.either(bootstrapControl())))).toBe(
      "control-schema-mismatch",
    );
  });
  it("rejects wrong/duplicate history and frozen SQL bytes", async () => {
    await run(bootstrapControl());
    await env.ISOLATED_DB.prepare(
      `INSERT INTO ${CONTROL_HISTORY}(name) VALUES ('foreign.sql')`,
    ).run();
    expect(errorCode(await run(Effect.either(verifyControlBootstrap())))).toBe(
      "control-native-history-mismatch",
    );
    expect(
      errorCode(
        await run(
          Effect.either(bootstrapControl()).pipe(
            Effect.provideService(NativeControlMigrations, {
              ...native(),
              v1: inject("controlV1") + "\n",
            }),
          ),
        ),
      ),
    ).toBe("control-v1-bytes-mismatch");
  });
  it("unknown committed bootstrap stops its candidate; a new bounded bootstrap reads committed state", async () => {
    const adapter = native();
    const ambiguous = {
      ...adapter,
      applyV1: adapter.applyV1.pipe(
        Effect.zipRight(
          Effect.fail(failure("initialization", "lost-response")),
        ),
      ),
    };
    expect(
      errorCode(
        await run(
          Effect.either(bootstrapControl()).pipe(
            Effect.provideService(NativeControlMigrations, ambiguous),
          ),
        ),
      ),
    ).toBe("control-bootstrap-unknown-stop");
    expect(await run(verifyControlBootstrap())).toBe(true);
    await run(bootstrapControl());
  });
  it("unique history failure rolls back the competing native batch", async () => {
    await run(bootstrapControl());
    await expect(
      env.ISOLATED_DB.batch([
        env.ISOLATED_DB.prepare("CREATE TABLE local_race_probe(x INTEGER)"),
        env.ISOLATED_DB.prepare(
          `INSERT INTO ${CONTROL_HISTORY}(name) VALUES (?)`,
        ).bind(CONTROL_FILE),
      ]),
    ).rejects.toThrow();
    expect(
      await env.ISOLATED_DB.prepare(
        "SELECT name FROM sqlite_master WHERE name='local_race_probe'",
      ).first(),
    ).toBeNull();
  });
  it("contends native/CLI owners on a single exact DB slot; never replaces an active owner", async () => {
    await run(bootstrapControl());
    const a = await run(coordinator()),
      b = await run(coordinator(ownerB));
    const results = await Promise.all([
      Effect.runPromise(Effect.either(a.acquire(identity))),
      Effect.runPromise(Effect.either(b.acquire(identity))),
    ]);
    expect(results.filter(Either.isRight)).toHaveLength(1);
    expect(results.filter(Either.isLeft)).toHaveLength(1);
  });
  it("retains lost acquisition; never dispatches automatically or takes over", async () => {
    await run(bootstrapControl());
    const db = database();
    const lost: typeof ControlDatabase.Service = {
      ...db,
      query: (sql, params) =>
        db
          .query(sql, params)
          .pipe(
            Effect.flatMap((rows) =>
              sql.startsWith("INSERT INTO agentforum_release_control")
                ? Effect.fail(failure("initialization", "lost-acquire"))
                : Effect.succeed(rows),
            ),
          ),
    };
    const a = await run(
      coordinator().pipe(Effect.provideService(ControlDatabase, lost)),
    );
    expect(
      errorCode(await Effect.runPromise(Effect.either(a.acquire(identity)))),
    ).toBe("control-acquire-unknown-retained");
    const b = await run(coordinator(ownerB));
    expect(
      errorCode(await Effect.runPromise(Effect.either(b.acquire(identity)))),
    ).toBe("control-acquire-refused");
  });
  it("durably arms exact effects; unknown mutation retains ownership, failed terminal can close safely", async () => {
    await run(bootstrapControl());
    const a = await run(coordinator());
    const session = await Effect.runPromise(a.acquire(identity));
    const token = await Effect.runPromise(
      session.arm("business-migrate", artifact),
    );
    expect(
      errorCode(
        await Effect.runPromise(Effect.either(session.close("acknowledged"))),
      ),
    ).toBe("control-closure-unverified-retained");
    await Effect.runPromise(session.terminal(token, receipt(token, "failed")));
    await Effect.runPromise(session.close("acknowledged"));
    const next = await run(coordinator(ownerB));
    const second = await Effect.runPromise(next.acquire(identity));
    await Effect.runPromise(second.arm("activate", artifact));
    await Effect.runPromise(second.close("uncertain"));
    const row = await run(readControl(database()));
    expect(Option.isSome(row) && row.value.phase).toBe("uncertain");
    expect(Option.isSome(row) && row.value.effect_state).toBe("unknown");
    expect(
      errorCode(await Effect.runPromise(Effect.either(a.acquire(identity)))),
    ).toBe("control-acquire-refused");
  });
  it("stale closure cannot clear a newer owner, and foreign receipts cannot acknowledge an intent", async () => {
    await run(bootstrapControl());
    const a = await run(coordinator());
    const old = await Effect.runPromise(a.acquire(identity));
    await Effect.runPromise(old.close("acknowledged"));
    const b = await run(coordinator(ownerB));
    const live = await Effect.runPromise(b.acquire(identity));
    const token = await Effect.runPromise(live.arm("activate", artifact));
    expect(
      errorCode(
        await Effect.runPromise(
          Effect.either(
            live.terminal(token, {
              ...receipt(token),
              artifactDigest: "f".repeat(64),
            }),
          ),
        ),
      ),
    ).toBe("control-terminal-mismatch");
    expect(
      errorCode(await Effect.runPromise(Effect.either(old.close("uncertain")))),
    ).toBe("control-closure-unverified-retained");
    await Effect.runPromise(live.assertHeld);
  });
  it("requires BOTH executor and effect terminality, including effect committed after executor termination", async () => {
    await run(bootstrapControl());
    const a = await run(coordinator());
    const session = await Effect.runPromise(a.acquire(identity));
    const token = await Effect.runPromise(
      session.arm("business-migrate", artifact),
    );
    await Effect.runPromise(session.close("uncertain"));
    const delayed = await Effect.runPromise(Deferred.make<boolean>());
    // Controlled local outstanding effect; dying executor is not terminality.
    const observer: typeof QuiescenceVerifier.Service = {
      executor: (row) =>
        Effect.succeed({
          ownerId: token.ownerId,
          generation: row.generation,
          sequence: row.effect_seq,
          executorRef: `local:${ownerA}`,
          terminal: true,
          observationRef: "local:executor:terminal",
        }),
      effect: () =>
        Deferred.isDone(delayed).pipe(
          Effect.flatMap((done) =>
            done
              ? Effect.succeed(receipt(token))
              : Effect.fail(failure("initialization", "still-in-flight")),
          ),
        ),
    };
    expect(
      errorCode(
        await run(
          Effect.either(reconcileControl()).pipe(
            Effect.provideService(QuiescenceVerifier, unavailableQuiescence),
          ),
        ),
      ),
    ).toBe("executor-quiescence-unproved");
    expect(
      errorCode(
        await run(
          Effect.either(reconcileControl()).pipe(
            Effect.provideService(QuiescenceVerifier, observer),
          ),
        ),
      ),
    ).toBe("effect-quiescence-unproved");
    await env.ISOLATED_DB.prepare(
      "CREATE TABLE local_delayed_effect(value TEXT)",
    ).run();
    await Effect.runPromise(Deferred.succeed(delayed, true));
    await run(
      reconcileControl().pipe(
        Effect.provideService(QuiescenceVerifier, observer),
      ),
    );
    const row = await run(readControl(database()));
    expect(Option.isSome(row) && row.value.phase).toBe("idle");
    expect(
      Option.isSome(row) && Option.isSome(row.value.reconciliation_sha256),
    ).toBe(true);
    const b = await run(coordinator(ownerB));
    await Effect.runPromise(b.acquire(identity));
  });
  it("rejects forged/stale proof and sequence changes during observation", async () => {
    await run(bootstrapControl());
    const a = await run(coordinator());
    const session = await Effect.runPromise(a.acquire(identity));
    const token = await Effect.runPromise(session.arm("activate", artifact));
    await Effect.runPromise(session.close("uncertain"));
    const observer: typeof QuiescenceVerifier.Service = {
      executor: () =>
        Effect.succeed({
          ownerId: ownerB,
          generation: 1,
          sequence: 1,
          executorRef: `local:${ownerA}`,
          terminal: true,
          observationRef: "local:forged",
        }),
      effect: () => Effect.succeed(receipt(token)),
    };
    expect(
      errorCode(
        await run(
          Effect.either(reconcileControl()).pipe(
            Effect.provideService(QuiescenceVerifier, observer),
          ),
        ),
      ),
    ).toBe("executor-quiescence-mismatch");
    const stale = {
      ...observer,
      executor: () =>
        Effect.succeed({
          ownerId: ownerA,
          generation: 1,
          sequence: 1,
          executorRef: `local:${ownerA}`,
          terminal: true,
          observationRef: "local:terminal",
        }),
      effect: () =>
        database()
          .query(
            "UPDATE agentforum_release_control SET effect_seq=2 WHERE slot=1",
            [],
          )
          .pipe(Effect.as(receipt(token))),
    };
    expect(
      errorCode(
        await run(
          Effect.either(reconcileControl()).pipe(
            Effect.provideService(QuiescenceVerifier, stale),
          ),
        ),
      ),
    ).toBe("control-reconcile-stale");
  });
});

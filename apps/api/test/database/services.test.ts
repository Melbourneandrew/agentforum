import { env } from "node:process";
import { sql } from "drizzle-orm";
import { jsonb, pgTable, text } from "drizzle-orm/pg-core";
import {
  Cause,
  Context,
  Data,
  Deferred,
  Effect,
  Duration,
  Exit,
  Fiber,
  Layer,
  Option,
  Redacted,
  Schedule,
  Schema,
} from "effect";
import { beforeAll, describe, expect, it } from "vitest";
import {
  DatabaseDecodeError,
  DirectDatabase,
  databaseBindingsLayer,
  directDatabaseLayer,
  type Execute,
} from "../../src/database/database.js";

const Environment = Schema.Struct({
  DATABASE_TEST_DIRECT_URL: Schema.Redacted(Schema.NonEmptyString),
  DATABASE_TEST_CACHED_URL: Schema.Redacted(Schema.NonEmptyString),
});
const parsed = Schema.decodeUnknownEither(Environment)(env);
if (parsed._tag === "Left")
  throw new Error("Database service tests require the owned harness");
const bindings = databaseBindingsLayer({
  HYPERDRIVE_DIRECT: {
    connectionString: Redacted.value(parsed.right.DATABASE_TEST_DIRECT_URL),
  },
  HYPERDRIVE_CACHED: {
    connectionString: Redacted.value(parsed.right.DATABASE_TEST_CACHED_URL),
  },
});
class Observer extends Context.Tag("@agentforum/test/DatabaseObserver")<
  Observer,
  { readonly execute: Execute }
>() {}
const observerLayer = Layer.effect(Observer, DirectDatabase).pipe(
  Layer.provide(Layer.fresh(directDatabaseLayer)),
);
class Rejected extends Data.TaggedError("SyntheticTransactionRejected") {}
class ObservationTimeout extends Data.TaggedError(
  "DatabaseObservationTimeout",
) {}
const Count = Schema.Struct({ n: Schema.Int });
const Pid = Schema.Struct({ pid: Schema.Int });
const Probe = pgTable("agentforum_adapter_probe", {
  id: text("id").primaryKey(),
  payload: jsonb("payload").notNull(),
});
const Row = Schema.Struct({
  id: Schema.String,
  payload: Schema.Struct({
    nullable: Schema.Null,
    nested: Schema.Array(Schema.Struct({ value: Schema.Int })),
  }),
});
const payload = { nullable: null, nested: [{ value: 7 }] };
const singleton =
  <A, I>(schema: Schema.Schema<A, I>) =>
  (rows: readonly A[]) =>
    Schema.decodeUnknown(Schema.Tuple(Schema.typeSchema(schema)))(rows).pipe(
      Effect.map((value) => value[0]),
    );
const number = (execute: Execute, statement: ReturnType<typeof sql>) =>
  execute(() => statement, Count).pipe(
    Effect.flatMap(singleton(Count)),
    Effect.map((row) => row.n),
  );
const run = <A, E>(program: Effect.Effect<A, E, DirectDatabase>) =>
  Effect.runPromise(
    program.pipe(
      Effect.provide(directDatabaseLayer.pipe(Layer.provide(bindings))),
    ),
  );

beforeAll(async () => {
  await run(
    Effect.flatMap(DirectDatabase, (database) =>
      database.execute(
        () =>
          sql`CREATE TABLE agentforum_adapter_probe (id text PRIMARY KEY, payload jsonb NOT NULL)`,
        Schema.Never,
      ),
    ),
  );
});

describe("scoped pg/Drizzle transactions in workerd", () => {
  it("commits parameterized writes and preserves JSONB null and nested data", async () => {
    const marker = `synthetic-' OR true -- ${crypto.randomUUID()}`;
    await run(
      Effect.gen(function* () {
        const database = yield* DirectDatabase;
        yield* database.transaction((session) =>
          session.execute(
            (builder) => builder.insert(Probe).values({ id: marker, payload }),
            Schema.Never,
          ),
        );
      }),
    );
    // Read on a separately scoped connection after the writing client closed.
    await run(
      Effect.gen(function* () {
        const database = yield* DirectDatabase;
        const rows = yield* database.execute(
          (builder) =>
            builder
              .select()
              .from(Probe)
              .where(sql`${Probe.id} = ${marker}`),
          Row,
        );
        expect(rows).toEqual([{ id: marker, payload }]);
      }),
    );
  });
  for (const mode of ["failure", "defect"] as const) {
    it(`rolls back a real write after ${mode} and keeps the client usable`, async () => {
      const marker = crypto.randomUUID();
      await run(
        Effect.gen(function* () {
          const database = yield* DirectDatabase;
          const result = yield* Effect.exit(
            database.transaction((session) =>
              session
                .execute(
                  (builder) =>
                    builder.insert(Probe).values({ id: marker, payload }),
                  Schema.Never,
                )
                .pipe(
                  Effect.zipRight(
                    mode === "failure"
                      ? Effect.fail(new Rejected())
                      : Effect.die(new Error("Synthetic transaction defect")),
                  ),
                ),
            ),
          );
          expect(Exit.isFailure(result)).toBe(true);
          if (Exit.isFailure(result))
            expect(
              mode === "failure"
                ? Option.exists(
                    Cause.failureOption(result.cause),
                    (error) => error instanceof Rejected,
                  )
                : Option.exists(
                    Cause.dieOption(result.cause),
                    Schema.is(
                      Schema.Struct({
                        message: Schema.Literal("Synthetic transaction defect"),
                      }),
                    ),
                  ),
            ).toBe(true);
          const count = yield* number(
            database.execute,
            sql`SELECT count(*)::integer AS n FROM agentforum_adapter_probe WHERE id = ${marker}`,
          );
          expect(count).toBe(0);
        }),
      );
    });
  }
  it("returns a typed decode error without leaking raw result data", async () => {
    await run(
      Effect.gen(function* () {
        const database = yield* DirectDatabase;
        const outcome = yield* Effect.exit(
          database.execute(
            () => sql`SELECT 'synthetic-private-value' AS n`,
            Count,
          ),
        );
        expect(Exit.isFailure(outcome)).toBe(true);
        if (Exit.isFailure(outcome)) {
          const failure = Cause.failureOption(outcome.cause);
          expect(
            Option.exists(
              failure,
              (error) => error instanceof DatabaseDecodeError,
            ),
          ).toBe(true);
          expect(Cause.pretty(outcome.cause)).not.toContain(
            "synthetic-private-value",
          );
        }
      }),
    );
  });
  it("cancels an observed pg_sleep, rolls back, and releases before Worker shutdown", async () => {
    const marker = crypto.randomUUID();
    await Effect.runPromise(
      Effect.gen(function* () {
        const observer = yield* Observer;
        const pid = yield* Effect.gen(function* () {
          const database = yield* DirectDatabase;
          const entered = yield* Deferred.make<number>();
          const transaction = database.transaction((session) =>
            Effect.gen(function* () {
              const connection = yield* session
                .execute(
                  () => sql`SELECT pg_backend_pid()::integer AS pid`,
                  Pid,
                )
                .pipe(Effect.flatMap(singleton(Pid)));
              yield* session.execute(
                (builder) =>
                  builder.insert(Probe).values({ id: marker, payload }),
                Schema.Never,
              );
              yield* Deferred.succeed(entered, connection.pid);
              yield* session.execute(
                () => sql`SELECT pg_sleep(30)`,
                Schema.Unknown,
              );
            }),
          );
          const fiber = yield* Effect.fork(transaction);
          const pid = yield* Deferred.await(entered).pipe(
            Effect.timeoutFail({
              duration: "3 seconds",
              onTimeout: () => new ObservationTimeout(),
            }),
          );
          yield* number(
            observer.execute,
            sql`SELECT count(*)::integer AS n FROM pg_stat_activity WHERE pid = ${pid} AND wait_event = 'PgSleep'`,
          ).pipe(
            Effect.repeat({
              until: (count) => count === 1,
              schedule: Schedule.spaced("5 millis"),
            }),
            Effect.timeoutFail({
              duration: "3 seconds",
              onTimeout: () => new ObservationTimeout(),
            }),
          );
          const result = yield* Fiber.interrupt(fiber);
          expect(Exit.isFailure(result)).toBe(true);
          if (Exit.isFailure(result))
            expect(Cause.isInterruptedOnly(result.cause)).toBe(true);
          expect(
            yield* number(
              observer.execute,
              sql`SELECT count(*)::integer AS n FROM agentforum_adapter_probe WHERE id = ${marker}`,
            ),
          ).toBe(0);
          // The same native client is alive, idle and outside a transaction: closing
          // its socket alone cannot satisfy this cancellation/rollback assertion.
          expect(
            yield* number(
              observer.execute,
              sql`SELECT count(*)::integer AS n FROM pg_stat_activity WHERE pid = ${pid} AND state = 'idle' AND xact_start IS NULL`,
            ),
          ).toBe(1);
          const live = yield* database
            .execute(() => sql`SELECT pg_backend_pid()::integer AS pid`, Pid)
            .pipe(Effect.flatMap(singleton(Pid)));
          expect(live.pid).toBe(pid);
          return pid;
        }).pipe(Effect.provide(Layer.fresh(directDatabaseLayer)));
        yield* number(
          observer.execute,
          sql`SELECT count(*)::integer AS n FROM pg_stat_activity WHERE pid = ${pid}`,
        ).pipe(
          Effect.repeat({
            until: (count) => count === 0,
            schedule: Schedule.spaced("5 millis"),
          }),
          Effect.timeoutFail({
            duration: "1 second",
            onTimeout: () => new ObservationTimeout(),
          }),
        );
      }).pipe(Effect.provide(observerLayer.pipe(Layer.provideMerge(bindings)))),
    );
  });
  it("does not let cancellation/completion races cancel the next statement", async () => {
    await run(
      Effect.gen(function* () {
        const database = yield* DirectDatabase;
        for (let index = 0; index < 24; index++) {
          const fiber = yield* Effect.fork(
            database.execute(() => sql`SELECT pg_sleep(0.001)`, Schema.Unknown),
          );
          yield* Effect.sleep(Duration.millis(index % 3));
          const result = yield* Fiber.interrupt(fiber);
          if (Exit.isFailure(result))
            expect(Cause.isInterruptedOnly(result.cause)).toBe(true);
          expect(
            yield* number(
              database.execute,
              sql`SELECT pg_sleep(0.002), 1::integer AS n`,
            ),
          ).toBe(1);
        }
      }),
    );
  });
  it("interrupts semaphore-queued work without canceling another transaction", async () => {
    const marker = crypto.randomUUID();
    await run(
      Effect.gen(function* () {
        const database = yield* DirectDatabase;
        const entered = yield* Deferred.make<boolean>();
        const release = yield* Deferred.make<boolean>();
        const queued = yield* Deferred.make<boolean>();
        const holder = yield* Effect.fork(
          database.transaction(() =>
            Deferred.succeed(entered, true).pipe(
              Effect.zipRight(Deferred.await(release)),
            ),
          ),
        );
        yield* Deferred.await(entered);
        const waiting = yield* Effect.fork(
          Deferred.succeed(queued, true).pipe(
            Effect.zipRight(
              database.execute(
                (builder) =>
                  builder.insert(Probe).values({ id: marker, payload }),
                Schema.Never,
              ),
            ),
          ),
        );
        yield* Deferred.await(queued);
        const result = yield* Fiber.interrupt(waiting);
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result))
          expect(Cause.isInterruptedOnly(result.cause)).toBe(true);
        yield* Deferred.succeed(release, true);
        yield* Fiber.join(holder);
        expect(
          yield* number(
            database.execute,
            sql`SELECT count(*)::integer AS n FROM agentforum_adapter_probe WHERE id = ${marker}`,
          ),
        ).toBe(0);
      }),
    );
  });
});

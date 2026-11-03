import { sql } from "drizzle-orm";
import {
  Cause,
  Context,
  Data,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Schedule,
  Schema,
} from "effect";
import {
  DirectDatabase,
  directDatabaseLayer,
  type Execute,
} from "../../src/database/database.js";
import { databaseProbe } from "./database-schema.js";
export class ProbeFailure extends Data.TaggedError("DatabaseProbeFailure") {}
class Rejected extends Data.TaggedError("SyntheticProbeRejected") {}
export const ProbeInput = Schema.Struct({
  mode: Schema.Literal("commit", "rollback", "interrupt"),
  marker: Schema.UUID,
});
export const ProbeResult = Schema.Struct({
  mode: ProbeInput.fields.mode,
  persisted: Schema.Boolean,
  transactionCleared: Schema.Boolean,
  sleepObserved: Schema.Boolean,
  interrupted: Schema.Boolean,
  scopeClosed: Schema.Literal(true),
});
export const createProbeTable = sql`CREATE TABLE IF NOT EXISTS agentforum_adapter_probe (id text PRIMARY KEY, payload jsonb NOT NULL)`;
export const readProbeJson = async (
  body: ReadableStream<Uint8Array> | null,
): Promise<unknown> => {
  if (body === null) throw new ProbeFailure();
  const reader = body.getReader();
  let size = 0;
  let text = "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    for (
      let chunk = await reader.read();
      !chunk.done;
      chunk = await reader.read()
    ) {
      size += chunk.value.byteLength;
      if (size > 2048) throw new ProbeFailure();
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } finally {
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
};
class Observer extends Context.Tag("@agentforum/fixture/Observer")<
  Observer,
  { readonly execute: Execute }
>() {}
const observerLayer = Layer.effect(Observer, DirectDatabase).pipe(
  Layer.provide(Layer.fresh(directDatabaseLayer)),
);
const Count = Schema.Struct({ n: Schema.Int });
const count = (execute: Execute, query: ReturnType<typeof sql>) =>
  execute(() => query, Count).pipe(
    Effect.flatMap(Schema.decodeUnknown(Schema.Tuple(Count))),
    Effect.map((rows) => rows[0].n),
  );
export const transactionProbe = (
  input: Schema.Schema.Type<typeof ProbeInput>,
) =>
  Effect.gen(function* () {
    const observer = yield* Observer;
    const result = yield* Effect.gen(function* () {
      const database = yield* DirectDatabase;
      const name = `af_probe_${input.marker}`;
      const write = database.transaction((session) =>
        session
          .execute(
            () => sql`SELECT set_config('application_name',${name},true)`,
            Schema.Unknown,
          )
          .pipe(
            Effect.zipRight(
              session.execute(
                (builder) =>
                  builder
                    .insert(databaseProbe)
                    .values({ id: input.marker, payload: { synthetic: true } }),
                Schema.Never,
              ),
            ),
            Effect.zipRight(
              input.mode === "rollback"
                ? Effect.fail(new Rejected())
                : Effect.void,
            ),
          ),
      );
      let sleepObserved = false;
      let interrupted = false;
      if (input.mode === "interrupt") {
        const entered = yield* Deferred.make<boolean>();
        const fiber = yield* Effect.fork(
          database.transaction((session) =>
            Effect.gen(function* () {
              yield* session.execute(
                () => sql`SELECT set_config('application_name',${name},true)`,
                Schema.Unknown,
              );
              yield* session.execute(
                (builder) =>
                  builder
                    .insert(databaseProbe)
                    .values({ id: input.marker, payload: { synthetic: true } }),
                Schema.Never,
              );
              yield* Deferred.succeed(entered, true);
              yield* session.execute(
                () => sql`SELECT pg_sleep(30)`,
                Schema.Unknown,
              );
            }),
          ),
        );
        yield* Deferred.await(entered).pipe(
          Effect.timeoutFail({
            duration: "3 seconds",
            onTimeout: () => new ProbeFailure(),
          }),
        );
        yield* count(
          observer.execute,
          sql`SELECT count(*)::integer AS n FROM pg_stat_activity WHERE application_name=${name} AND wait_event='PgSleep'`,
        ).pipe(
          Effect.repeat({
            until: (n) => n === 1,
            schedule: Schedule.spaced("10 millis"),
          }),
          Effect.timeoutFail({
            duration: "3 seconds",
            onTimeout: () => new ProbeFailure(),
          }),
        );
        sleepObserved = true;
        const stopped = yield* Fiber.interrupt(fiber);
        interrupted =
          Exit.isFailure(stopped) && Cause.isInterruptedOnly(stopped.cause);
        yield* Effect.filterOrFail(
          Effect.succeed(interrupted),
          (value) => value,
          () => new ProbeFailure(),
        );
      } else {
        const outcome = yield* Effect.exit(write);
        yield* Effect.filterOrFail(
          Effect.succeed(outcome),
          (value) =>
            input.mode === "commit"
              ? Exit.isSuccess(value)
              : Exit.isFailure(value) &&
                Option.exists(
                  Cause.failureOption(value.cause),
                  (error) => error instanceof Rejected,
                ),
          () => new ProbeFailure(),
        );
      }
      // Observe committed state from another frontend. Never require pooled origin
      // PID disappearance or same-PID reuse after COMMIT/ROLLBACK through Hyperdrive.
      const persisted =
        (yield* count(
          observer.execute,
          sql`SELECT count(*)::integer AS n FROM agentforum_adapter_probe WHERE id=${input.marker}`,
        )) === 1;
      const transactionCleared =
        (yield* count(
          observer.execute,
          sql`SELECT count(*)::integer AS n FROM pg_stat_activity WHERE application_name=${name} AND xact_start IS NOT NULL`,
        )) === 0;
      yield* Effect.filterOrFail(
        Effect.succeed(
          persisted === (input.mode === "commit") && transactionCleared,
        ),
        (value) => value,
        () => new ProbeFailure(),
      );
      return {
        mode: input.mode,
        persisted,
        transactionCleared,
        sleepObserved,
        interrupted,
      };
    }).pipe(
      Effect.ensuring(
        observer
          .execute(
            (builder) =>
              builder
                .delete(databaseProbe)
                .where(sql`${databaseProbe.id}=${input.marker}`),
            Schema.Never,
          )
          .pipe(Effect.orDie),
      ),
      Effect.provide(Layer.fresh(directDatabaseLayer)),
    );
    return result;
  }).pipe(
    Effect.provide(observerLayer),
    Effect.map((value) => ({ ...value, scopeClosed: true as const })),
  );

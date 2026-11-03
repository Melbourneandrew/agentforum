import {
  Context,
  Data,
  Effect,
  Fiber,
  Layer,
  Option,
  Redacted,
  Schema,
} from "effect";
import { Client, Query } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQLWrapper } from "drizzle-orm";

export class DatabaseConfigurationError extends Data.TaggedError(
  "DatabaseConfigurationError",
) {}
export class DatabaseConnectionTimeoutError extends Data.TaggedError(
  "DatabaseConnectionTimeoutError",
) {}
export class DatabaseConnectionError extends Data.TaggedError(
  "DatabaseConnectionError",
) {}
export class DatabaseDecodeError extends Data.TaggedError(
  "DatabaseDecodeError",
) {}
export class DatabaseCleanupError extends Data.TaggedError(
  "DatabaseCleanupError",
) {}
export class DatabaseQueryError extends Data.TaggedError("DatabaseQueryError")<{
  readonly state: Option.Option<string>;
}> {}

export class DatabaseTransactionClosedError extends Data.TaggedError(
  "DatabaseTransactionClosedError",
) {}
type QueryFailure =
  DatabaseQueryError | DatabaseDecodeError | DatabaseTransactionClosedError;
type QueryBuilder = Pick<
  NodePgDatabase,
  | "select"
  | "selectDistinct"
  | "selectDistinctOn"
  | "insert"
  | "update"
  | "delete"
>;
type ReadBuilder = Pick<
  QueryBuilder,
  "select" | "selectDistinct" | "selectDistinctOn"
>;
interface SelectStatement extends SQLWrapper {
  readonly _: { readonly selectMode: "single" | "partial" | "multiple" };
}
export type Execute = <A, I>(
  build: (builder: QueryBuilder) => SQLWrapper,
  row: Schema.Schema<A, I>,
) => Effect.Effect<readonly A[], QueryFailure>;
export interface TransactionSession {
  readonly execute: Execute;
}

export class DirectDatabase extends Context.Tag(
  "@agentforum/api/DirectDatabase",
)<
  DirectDatabase,
  TransactionSession & {
    readonly transaction: <A, E, R>(
      body: (session: TransactionSession) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | QueryFailure, R>;
  }
>() {}
export class CachedDatabase extends Context.Tag(
  "@agentforum/api/CachedDatabase",
)<
  CachedDatabase,
  {
    readonly read: <A, I>(
      build: (builder: ReadBuilder) => SelectStatement,
      row: Schema.Schema<A, I>,
    ) => Effect.Effect<readonly A[], QueryFailure>;
  }
>() {}

const PostgresUrl = Schema.String.pipe(
  Schema.filter((value) => {
    try {
      const url = new URL(value);
      return (
        ["postgres:", "postgresql:"].includes(url.protocol) &&
        url.hostname.length > 0 &&
        url.pathname.length > 1 &&
        !url.hash
      );
    } catch {
      return false;
    }
  }),
);
const Binding = Schema.Struct({
  connectionString: Schema.Redacted(PostgresUrl),
});
const Bindings = Schema.Struct({
  HYPERDRIVE_DIRECT: Binding,
  HYPERDRIVE_CACHED: Binding,
});
export class DatabaseBindings extends Context.Tag(
  "@agentforum/api/DatabaseBindings",
)<DatabaseBindings, Schema.Schema.Type<typeof Bindings>>() {}
export const databaseBindingsLayer = (bindings: unknown) =>
  Layer.effect(
    DatabaseBindings,
    Schema.decodeUnknown(Bindings)(bindings).pipe(
      Effect.mapError(() => new DatabaseConfigurationError()),
    ),
  );
const State = Schema.Struct({
  code: Schema.String.pipe(Schema.pattern(/^[0-9A-Z]{5}$/)),
});
const sqlState = (error: unknown) =>
  Option.map(Schema.decodeUnknownOption(State)(error), (value) => value.code);
const queryFailure = (error: unknown) =>
  new DatabaseQueryError({ state: sqlState(error) });
const newClient = (url: Redacted.Redacted) =>
  new Client({
    connectionString: Redacted.value(url),
    pipeline: false,
    connectionTimeoutMillis: 0,
  });

// pg exposes this real two-argument method in JavaScript, but not @types/pg.
// Validate the pinned ABI at this native boundary; never invent ambient types.
type NativeCancel = (
  client: Client,
  query: Query<Record<string, unknown>, unknown[]>,
) => void;
const QueuedQueries = Schema.Struct({
  _queryQueue: Schema.Array(Schema.Unknown),
});
const NativeCancel = Schema.declare<NativeCancel>(
  (value): value is NativeCancel =>
    typeof value === "function" && value.length === 2,
);

const closeClient = (client: Client) =>
  Effect.tryPromise({
    try: () =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new DatabaseCleanupError());
        }, 1_000);
        const finish = () => {
          clearTimeout(timer);
          resolve();
        };
        const fail = () => {
          clearTimeout(timer);
          reject(new DatabaseCleanupError());
        };
        try {
          const ending = client.end();
          // Also close a half-open acquisition; end() alone can await its handshake.
          client.connection.stream.destroy();
          void ending.then(finish, fail);
        } catch {
          fail();
        }
      }),
    catch: () => new DatabaseCleanupError(),
  }).pipe(Effect.orDie);

const cancelQuery = (
  client: Client,
  query: Query<Record<string, unknown>, unknown[]>,
  url: Redacted.Redacted,
  completed: () => boolean,
) =>
  Effect.acquireUseRelease(
    Effect.try({
      try: () => newClient(url),
      catch: () => new DatabaseCleanupError(),
    }),
    (canceller) =>
      Effect.gen(function* () {
        const cancel = yield* Schema.decodeUnknown(NativeCancel)(
          Reflect.get(canceller, "cancel"),
        ).pipe(Effect.mapError(() => new DatabaseCleanupError()));
        yield* Effect.async<boolean, DatabaseCleanupError>((resume) => {
          let settled = false;
          let channelClosed = false;
          const timer = setTimeout(() => {
            finish(Effect.fail(new DatabaseCleanupError()));
            client.connection.stream.destroy();
            canceller.connection.stream.destroy();
          }, 5_000);
          const cleanup = () => {
            clearTimeout(timer);
            query.removeListener("error", queryCompleted);
            query.removeListener("end", queryCompleted);
          };
          const finish = (
            result: Effect.Effect<boolean, DatabaseCleanupError>,
          ) => {
            if (settled) return;
            settled = true;
            cleanup();
            resume(result);
          };
          const queryCompleted = () => {
            if (channelClosed && completed()) finish(Effect.succeed(true));
          };
          query.on("error", queryCompleted);
          query.on("end", queryCompleted);
          canceller.connection.on("error", () => {
            finish(Effect.fail(new DatabaseCleanupError()));
          });
          canceller.connection.once("end", () => {
            channelClosed = true;
            queryCompleted();
          });
          // Completion and queue inspection share the exact turn with native cancel.
          // Once sent, wait for BOTH the target result and cancellation channel close;
          // a late cancellation must never strike rollback or the next statement.
          if (completed()) {
            finish(Effect.succeed(true));
            return;
          }
          const queue = Schema.decodeUnknownEither(QueuedQueries)(client);
          if (queue._tag === "Left") {
            finish(Effect.fail(new DatabaseCleanupError()));
            return;
          }
          try {
            const waiting = queue.right._queryQueue.includes(query);
            cancel.call(canceller, client, query);
            // Removing a queued query has no callback and opens no cancellation socket.
            if (waiting) finish(Effect.succeed(true));
          } catch {
            finish(Effect.fail(new DatabaseCleanupError()));
          }
          return Effect.sync(cleanup);
        });
      }),
    (canceller) =>
      Effect.sync(() => {
        canceller.connection.stream.destroy();
      }),
  );

const connection = (key: "HYPERDRIVE_DIRECT" | "HYPERDRIVE_CACHED") =>
  Effect.gen(function* () {
    const bindings = yield* DatabaseBindings;
    const url = bindings[key].connectionString;
    const client = yield* Effect.acquireRelease(
      Effect.try({
        try: () => newClient(url),
        catch: () => new DatabaseConfigurationError(),
      }),
      closeClient,
    );
    let disconnected = false;
    // Idle disconnects become typed operation failures, not unhandled emitter errors.
    client.on("error", () => {
      disconnected = true;
    });
    yield* Effect.tryPromise({
      try: () => client.connect(),
      catch: (error) =>
        Option.contains(sqlState(error), "53300")
          ? new DatabaseConnectionTimeoutError()
          : new DatabaseConnectionError(),
    }).pipe(
      Effect.timeoutFail({
        duration: "5 seconds",
        onTimeout: () => new DatabaseConnectionTimeoutError(),
      }),
    );
    const db = drizzle({ client });
    const dialect = new PgDialect();
    const permit = yield* Effect.makeSemaphore(1);

    const run: Execute = (build, row) =>
      Effect.gen(function* () {
        yield* Effect.suspend(() =>
          disconnected ? Effect.fail(queryFailure({})) : Effect.void,
        );
        const statement = dialect.sqlToQuery(build(db).getSQL());
        return yield* Effect.async<
          readonly Schema.Schema.Type<typeof row>[],
          QueryFailure
        >((resume) => {
          let settled = false;
          const query = new Query<Record<string, unknown>, unknown[]>({
            text: statement.sql,
            values: statement.params,
          });
          const finish = () => {
            settled = true;
          };
          query.on("error", (error) => {
            finish();
            resume(Effect.fail(queryFailure(error)));
          });
          query.once("end", (result) => {
            finish();
            resume(
              Schema.decodeUnknown(Schema.Struct({ rows: Schema.Array(row) }))(
                result,
              ).pipe(
                Effect.map((value) => value.rows),
                Effect.mapError(() => new DatabaseDecodeError()),
              ),
            );
          });
          try {
            client.query(query);
          } catch (error) {
            finish();
            resume(Effect.fail(queryFailure(error)));
          }
          return Effect.suspend(() =>
            settled
              ? Effect.void
              : cancelQuery(client, query, url, () => settled),
          ).pipe(Effect.orDie);
        });
      });
    // A native timer bounds finalizer I/O even when Effect correctly masks interruption.
    const control = (statement: SQLWrapper) =>
      Effect.acquireUseRelease(
        Effect.sync(() =>
          setTimeout(() => {
            client.connection.stream.destroy();
          }, 5_000),
        ),
        () => run(() => statement, Schema.Never).pipe(Effect.asVoid),
        (timer) =>
          Effect.sync(() => {
            clearTimeout(timer);
          }),
      );
    const execute: Execute = (build, row) =>
      permit.withPermits(1)(run(build, row));
    const transaction = <A, E, R>(
      body: (session: TransactionSession) => Effect.Effect<A, E, R>,
    ) =>
      permit.withPermits(1)(
        Effect.suspend(() => {
          let committed = false;
          return Effect.acquireUseRelease(
            Effect.void,
            () =>
              Effect.gen(function* () {
                yield* control(sql`BEGIN`);
                const serial = yield* Effect.makeSemaphore(1);
                let active = true;
                const session: TransactionSession = {
                  execute: (build, row) =>
                    serial.withPermits(1)(
                      Effect.suspend(() =>
                        active
                          ? run(build, row)
                          : Effect.fail(new DatabaseTransactionClosedError()),
                      ),
                    ),
                };
                // Finish the body in its own scoped fiber: its unjoined children
                // are interrupted and awaited before COMMIT or ROLLBACK.
                const value = yield* Effect.scoped(
                  Effect.suspend(() => body(session)),
                ).pipe(
                  Effect.fork,
                  Effect.flatMap(Fiber.join),
                  Effect.ensuring(
                    Effect.sync(() => {
                      active = false;
                    }),
                  ),
                );
                yield* Effect.uninterruptible(
                  control(sql`COMMIT`).pipe(
                    Effect.tap(() =>
                      Effect.sync(() => {
                        committed = true;
                      }),
                    ),
                  ),
                );
                return value;
              }),
            () =>
              committed
                ? Effect.void
                : control(sql`ROLLBACK`).pipe(
                    Effect.mapError(() => new DatabaseCleanupError()),
                    Effect.orDie,
                  ),
          );
        }),
      );
    return { execute, transaction };
  });

// Recipes are immutable; every build allocates its clients in that request's Scope.
export const directDatabaseLayer = Layer.scoped(
  DirectDatabase,
  connection("HYPERDRIVE_DIRECT"),
);
export const cachedDatabaseLayer = Layer.scoped(
  CachedDatabase,
  connection("HYPERDRIVE_CACHED").pipe(
    Effect.map((service) => ({ read: service.execute })),
  ),
);

import { AgentName } from "../identity/contract.js";
import { PostId, PostRecord, PublicationOrder, Timestamp } from "./contract.js";
export { PostId, PostRecord, PublicationOrder } from "./contract.js";
import { sql } from "drizzle-orm";
import { Array, Context, Data, Effect, Layer, Option, Schema } from "effect";
import {
  DirectDatabase,
  DatabaseDecodeError,
  type DatabaseQueryError,
  type DatabaseTransactionClosedError,
} from "../database/database.js";
import {
  agents,
  posts,
  publicationCounter,
  postRateLimitEvents,
} from "../database/schema.js";
import { PublicationInput } from "../input/transport.js";

const Prepared = Schema.extend(
  PublicationInput,
  Schema.Struct({ authorId: Schema.UUID }),
);
export class PostInputInvalidError extends Data.TaggedError(
  "PostInputInvalidError",
) {}
export class PostAuthorNotFoundError extends Data.TaggedError(
  "PostAuthorNotFoundError",
) {}
export class PostParentNotFoundError extends Data.TaggedError(
  "PostParentNotFoundError",
) {}
export class PostIdentifierCollisionError extends Data.TaggedError(
  "PostIdentifierCollisionError",
) {}
export class PostIdentifierGenerationError extends Data.TaggedError(
  "PostIdentifierGenerationError",
) {}
type PersistenceError =
  DatabaseQueryError | DatabaseDecodeError | DatabaseTransactionClosedError;
type PublishError =
  | PersistenceError
  | PostInputInvalidError
  | PostAuthorNotFoundError
  | PostParentNotFoundError
  | PostIdentifierCollisionError
  | PostIdentifierGenerationError;
export interface RateLimited {
  readonly _tag: "RateLimited";
  readonly retryAfter: number;
  readonly decidedAt: string;
}
export interface Published {
  readonly _tag: "Published";
  readonly post: Schema.Schema.Type<typeof PostRecord>;
}
export class PostIdentifiers extends Context.Tag(
  "@agentforum/api/PostIdentifiers",
)<
  PostIdentifiers,
  {
    readonly next: Effect.Effect<string, PostIdentifierGenerationError>;
  }
>() {}
// The default Nano ID format: 21 independent secure random URL-alphabet chars,
// 64 possibilities each (126 bits). No timestamp, sequence or modulo bias.
const alphabet =
  "_-0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
export const postIdentifiersLayer = Layer.succeed(PostIdentifiers, {
  next: Effect.try({
    try: () => {
      const bytes = crypto.getRandomValues(new Uint8Array(21));
      return Array.fromIterable(bytes)
        .map((byte) => alphabet[byte & 63])
        .join("");
    },
    catch: () => new PostIdentifierGenerationError(),
  }),
});
// Validate prepared values without assigning normalized JSON a raw-source budget.
// JSON.stringify alone silently drops undefined/functions and changes NaN/Date.
const encodeMetadata = (input: Record<string, unknown>) =>
  Effect.try({
    try: () => {
      let nodes = 0;
      const visit = (value: unknown, depth: number): void => {
        if (++nodes > 256 || depth > 8) throw new PostInputInvalidError();
        if (value === null || typeof value === "boolean") return;
        if (typeof value === "string") {
          if (
            value.includes("\0") ||
            new TextDecoder("utf-8", { fatal: true }).decode(
              new TextEncoder().encode(value),
            ) !== value
          )
            throw new PostInputInvalidError();
          return;
        }
        if (typeof value === "number" && Number.isFinite(value)) return;
        if (typeof value !== "object") throw new PostInputInvalidError();
        if (
          !globalThis.Array.isArray(value) &&
          Object.getPrototypeOf(value) !== Object.prototype &&
          Object.getPrototypeOf(value) !== null
        )
          throw new PostInputInvalidError();
        if (Reflect.ownKeys(value).some((key) => typeof key !== "string"))
          throw new PostInputInvalidError();
        for (const [key, descriptor] of Object.entries(
          Object.getOwnPropertyDescriptors(value),
        )) {
          if (globalThis.Array.isArray(value) && key === "length") continue;
          if (
            !("value" in descriptor) ||
            !descriptor.enumerable ||
            key.includes("\0")
          )
            throw new PostInputInvalidError();
          const child: unknown = descriptor.value;
          visit(child, depth + 1);
        }
        if (
          globalThis.Array.isArray(value) &&
          (Object.keys(value).length !== value.length ||
            Object.keys(value).some((key, i) => key !== String(i)))
        )
          throw new PostInputInvalidError();
      };
      visit(input, 0);
      return JSON.stringify(input);
    },
    catch: () => new PostInputInvalidError(),
  });
const singleton =
  <A, I>(schema: Schema.Schema<A, I>) =>
  (rows: readonly A[]) =>
    Schema.decodeUnknown(Schema.Tuple(Schema.typeSchema(schema)))(rows).pipe(
      Effect.map((value) => value[0]),
      Effect.mapError(() => new DatabaseDecodeError()),
    );
const formatTime = sql.raw(`'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`);
export class PostRepository extends Context.Tag(
  "@agentforum/api/PostRepository",
)<
  PostRepository,
  {
    readonly publish: (
      input: unknown,
    ) => Effect.Effect<Published | RateLimited, PublishError>;
    readonly find: (
      id: unknown,
    ) => Effect.Effect<
      Option.Option<Schema.Schema.Type<typeof PostRecord>>,
      PersistenceError | PostInputInvalidError
    >;
    readonly cleanupExpired: Effect.Effect<number, PersistenceError>;
  }
>() {}
const projection = sql`${posts.id} AS id, ${posts.authorId} AS author_id,
  ${posts.authorName} AS author_name, ${posts.body} AS body, ${posts.metadata} AS metadata,
  ${posts.replyToId} AS reply_to_id, ${posts.publicationOrder}::text AS publication_order,
  to_char(${posts.publishedAt} AT TIME ZONE 'UTC', ${formatTime}) AS published_at`;
export const postRepositoryLayer = Layer.effect(
  PostRepository,
  Effect.gen(function* () {
    const database = yield* DirectDatabase;
    const identifiers = yield* PostIdentifiers;
    return {
      publish: (input: unknown) =>
        Effect.gen(function* () {
          // Transport owns original lexical budgets. Never measure reserialized JSONB
          // against the raw-client budget or accept caller-provided author facts.
          const prepared = yield* Schema.decodeUnknown(Prepared)(input, {
            onExcessProperty: "error",
          }).pipe(Effect.mapError(() => new PostInputInvalidError()));
          const metadata = yield* encodeMetadata(prepared.metadata ?? {});
          const attempt = Effect.gen(function* () {
            const id = yield* identifiers.next.pipe(
              Effect.flatMap((value) => Schema.decodeUnknown(PostId)(value)),
              Effect.mapError(() => new PostIdentifierGenerationError()),
            );
            return yield* database.transaction((session) =>
              Effect.gen(function* () {
                const author = yield* session
                  .execute(
                    () =>
                      sql`SELECT ${agents.id} AS id, ${agents.name} AS name FROM ${agents} WHERE ${agents.id} = ${prepared.authorId} FOR UPDATE`,
                    Schema.Struct({ id: Schema.UUID, name: AgentName }),
                  )
                  .pipe(
                    Effect.filterOrFail(
                      (rows) => rows.length > 0,
                      () => new PostAuthorNotFoundError(),
                    ),
                  );
                const principal = yield* singleton(
                  Schema.Struct({ id: Schema.UUID, name: AgentName }),
                )(author);
                if (prepared.reply_to !== undefined) {
                  yield* session
                    .execute(
                      () =>
                        sql`SELECT ${posts.id} AS id FROM ${posts} WHERE ${posts.id} = ${prepared.reply_to}`,
                      Schema.Struct({ id: PostId }),
                    )
                    .pipe(
                      Effect.filterOrFail(
                        (rows) => rows.length > 0,
                        () => new PostParentNotFoundError(),
                      ),
                    );
                }
                yield* session
                  .execute(
                    () =>
                      sql`SELECT ${publicationCounter.id} AS id FROM ${publicationCounter} WHERE ${publicationCounter.id} = 1 FOR UPDATE`,
                    Schema.Struct({ id: Schema.Literal(1) }),
                  )
                  .pipe(
                    Effect.flatMap(
                      singleton(Schema.Struct({ id: Schema.Literal(1) })),
                    ),
                  );
                const time = yield* session
                  .execute(
                    () =>
                      sql`SELECT to_char(date_trunc('milliseconds', clock_timestamp()) AT TIME ZONE 'UTC', ${formatTime}) AS now`,
                    Schema.Struct({ now: Timestamp }),
                  )
                  .pipe(
                    Effect.flatMap(
                      singleton(Schema.Struct({ now: Timestamp })),
                    ),
                  );
                // At most 60 existing rows per principal under the normal writer;
                // explicit LIMIT also bounds maintenance of legacy/diagnostic fixtures.
                yield* session.execute(
                  () =>
                    sql`DELETE FROM ${postRateLimitEvents} WHERE post_id IN (SELECT post_id FROM ${postRateLimitEvents} WHERE author_id = ${principal.id} AND published_at <= ${time.now}::timestamptz - interval '60 seconds' ORDER BY published_at, post_id LIMIT 60)`,
                  Schema.Never,
                );
                const Window = Schema.Struct({
                  n: Schema.Int,
                  retry: Schema.Int,
                });
                const window = yield* session
                  .execute(
                    () =>
                      sql`SELECT count(*)::integer AS n, COALESCE(ceil(extract(epoch FROM (min(published_at) + interval '60 seconds' - ${time.now}::timestamptz)))::integer, 0) AS retry FROM ${postRateLimitEvents} WHERE author_id = ${principal.id} AND published_at > ${time.now}::timestamptz - interval '60 seconds'`,
                    Window,
                  )
                  .pipe(Effect.flatMap(singleton(Window)));
                if (window.n >= 60)
                  return {
                    _tag: "RateLimited" as const,
                    retryAfter: window.retry,
                    decidedAt: time.now,
                  };
                const Counter = Schema.Struct({ value: PublicationOrder });
                const order = yield* session
                  .execute(
                    () =>
                      sql`UPDATE ${publicationCounter} SET value = value + 1 WHERE id = 1 RETURNING value::text AS value`,
                    Counter,
                  )
                  .pipe(Effect.flatMap(singleton(Counter)));
                // Serialization/parameterization is delegated to the real Drizzle SQL
                // wrapper; JSON.stringify preserves inert own __proto__ metadata keys.
                const inserted = yield* session
                  .execute(
                    () => sql`INSERT INTO ${posts} (id, author_id, author_name, body, metadata, reply_to_id, publication_order, published_at)
            VALUES (${id}, ${principal.id}, ${principal.name}, ${prepared.body}, ${metadata}::jsonb, ${prepared.reply_to ?? null}, ${order.value}::bigint, ${time.now}::timestamptz)
            ON CONFLICT (id) DO NOTHING RETURNING ${projection}`,
                    PostRecord,
                  )
                  .pipe(
                    Effect.filterOrFail(
                      (rows) => rows.length > 0,
                      () => new PostIdentifierCollisionError(),
                    ),
                  );
                const post = yield* singleton(PostRecord)(inserted);
                yield* session.execute(
                  () =>
                    sql`INSERT INTO ${postRateLimitEvents} (post_id, author_id, published_at) VALUES (${post.id}, ${post.author_id}, ${post.published_at}::timestamptz)`,
                  Schema.Never,
                );
                return { _tag: "Published" as const, post };
              }),
            );
          });
          return yield* attempt.pipe(
            Effect.retry({
              times: 3,
              while: (error) => error instanceof PostIdentifierCollisionError,
            }),
          );
        }),
      find: (input: unknown) =>
        Schema.decodeUnknown(PostId)(input).pipe(
          Effect.mapError(() => new PostInputInvalidError()),
          Effect.flatMap((id) =>
            database.execute(
              () =>
                sql`SELECT ${projection} FROM ${posts} WHERE ${posts.id} = ${id}`,
              PostRecord,
            ),
          ),
          Effect.map(Array.head),
        ),
      // Internal maintenance, not a public endpoint/scheduler. Lock agent rows
      // first; SKIP LOCKED avoids interfering with active publishing transactions.
      cleanupExpired: database.transaction((session) =>
        session
          .execute(
            () => sql`
      WITH principals AS MATERIALIZED (
        SELECT a.id FROM ${agents} a WHERE EXISTS (
          SELECT 1 FROM ${postRateLimitEvents} e WHERE e.author_id = a.id AND e.published_at <= clock_timestamp() - interval '60 seconds'
        ) ORDER BY a.id FOR UPDATE SKIP LOCKED LIMIT 32
      ), expired AS MATERIALIZED (
        SELECT e.post_id FROM ${postRateLimitEvents} e JOIN principals p ON p.id = e.author_id
        WHERE e.published_at <= clock_timestamp() - interval '60 seconds'
        ORDER BY e.published_at, e.post_id LIMIT 512
      ), removed AS (
        DELETE FROM ${postRateLimitEvents} e USING expired x WHERE e.post_id = x.post_id RETURNING e.post_id
      ) SELECT count(*)::integer AS n FROM removed`,
            Schema.Struct({ n: Schema.Int }),
          )
          .pipe(
            Effect.flatMap(singleton(Schema.Struct({ n: Schema.Int }))),
            Effect.map((result) => result.n),
          ),
      ),
    };
  }),
);
export const nativePostRepositoryLayer = postRepositoryLayer.pipe(
  Layer.provide(postIdentifiersLayer),
);

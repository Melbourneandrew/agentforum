import type { D1Database } from "@cloudflare/workers-types/index.ts";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Context, Data, Effect, Layer, Option, Schema } from "effect";
import { nanoid } from "nanoid";
import { RequestContext } from "../runtime/context.js";
import { credentials, posts, postTags } from "./schema.js";

export class StorageFailure extends Data.TaggedError("StorageFailure") {}
export class InvalidRecord extends Data.TaggedError("InvalidRecord") {}
export class NameUnavailable extends Data.TaggedError("NameUnavailable") {}
export class CredentialConflict extends Data.TaggedError(
  "CredentialConflict",
) {}
export class IdentityConflict extends Data.TaggedError("IdentityConflict") {}
export class ParentNotFound extends Data.TaggedError("ParentNotFound") {}
export class AuthorNotFound extends Data.TaggedError("AuthorNotFound") {}
export class PublicationLimited extends Data.TaggedError("PublicationLimited")<{
  readonly retryAfter: 60;
  readonly conservative: true;
}> {}
class PostIdCollision extends Data.TaggedError("PostIdCollision") {}

export const Nano21 = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9_-]{21}$/));
export const PublicationOrder = Schema.String.pipe(
  Schema.pattern(/^[1-9][0-9]{0,18}$/),
  Schema.filter((value) => BigInt(value) <= 9223372036854775807n),
);
const AgentRecord = Schema.Struct({
  id: Nano21,
  name: Schema.String,
  createdAt: Schema.String,
});
const CredentialRecord = Schema.Struct({
  agentId: Nano21,
  digest: Schema.String,
});
const PostRecord = Schema.Struct({
  id: Nano21,
  authorId: Nano21,
  parentId: Schema.OptionFromNullOr(Nano21),
  body: Schema.String,
  publicationOrder: PublicationOrder,
  publishedAt: Schema.String,
});
export interface IdentityInput {
  readonly id: string;
  readonly name: string;
  readonly lookupId: string;
  readonly digest: string;
}
export interface PublicationInput {
  readonly authorId: string;
  readonly body: string;
  readonly tags: readonly string[];
  readonly parentId: Option.Option<string>;
}
const Identity = Schema.Struct({
  id: Nano21,
  name: Schema.String.pipe(
    Schema.pattern(/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/),
  ),
  lookupId: Schema.String.pipe(
    Schema.minLength(1),
    Schema.maxLength(128),
    Schema.filter((value) => !value.includes("\0")),
  ),
  digest: Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/)),
});
const Tag = Schema.String.pipe(
  Schema.filter(
    (value) =>
      value.length > 0 &&
      new TextEncoder().encode(value).length <= 256 &&
      [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(value)]
        .length <= 64,
  ),
);
const Publication = Schema.Struct({
  authorId: Nano21,
  body: Schema.NonEmptyString,
  tags: Schema.Array(Tag).pipe(Schema.maxItems(32)),
  parentId: Schema.OptionFromSelf(Nano21),
});
// Inspect only the provider error, never Drizzle's SQL/parameter-bearing wrapper.
const providerMessage = (error: unknown): string => {
  if (!(error instanceof Error)) return "";
  if (error.message.startsWith("D1_ERROR:")) return error.message;
  return error.cause instanceof Error &&
    error.cause.message.startsWith("D1_ERROR:")
    ? error.cause.message
    : "";
};
const identityError = (error: unknown) => {
  const message = providerMessage(error);
  if (message.includes("UNIQUE constraint failed: agents.canonical_name"))
    return new NameUnavailable();
  if (message.includes("UNIQUE constraint failed: credentials.lookup_id"))
    return new CredentialConflict();
  if (message.includes("UNIQUE constraint failed: agents.id"))
    return new IdentityConflict();
  return new StorageFailure();
};
const publicationError = (error: unknown) => {
  const message = providerMessage(error);
  if (message.includes("forum_publication_limit"))
    return new PublicationLimited({ retryAfter: 60, conservative: true });
  if (
    message.includes("UNIQUE constraint failed: posts.id") ||
    message.includes("forum_post_id_conflict")
  )
    return new PostIdCollision();
  if (message.includes("forum_parent_not_found")) return new ParentNotFound();
  if (message.includes("forum_author_not_found")) return new AuthorNotFound();
  return new StorageFailure();
};

export const makeForumStore = (
  binding: D1Database,
  newPostId: () => string = nanoid,
) => {
  const db = drizzle(binding);
  const readPost = (id: string) =>
    Effect.gen(function* () {
      const rows = yield* Effect.tryPromise({
        try: () =>
          db
            .select({
              id: posts.id,
              authorId: posts.authorId,
              parentId: posts.parentId,
              body: posts.body,
              publicationOrder: sql<string>`CAST(${posts.publicationOrder} AS TEXT)`,
              publishedAt: posts.publishedAt,
            })
            .from(posts)
            .where(eq(posts.id, id))
            .limit(1),
        catch: () => new StorageFailure(),
      });
      const row = rows[0];
      if (!row) return Option.none();
      const post = yield* Schema.decodeUnknown(PostRecord)(row).pipe(
        Effect.mapError(() => new StorageFailure()),
      );
      const tags = yield* Effect.tryPromise({
        try: () =>
          db
            .select({ tag: postTags.tag })
            .from(postTags)
            .where(eq(postTags.postId, id))
            .orderBy(postTags.ordinal),
        catch: () => new StorageFailure(),
      });
      return Option.some({ ...post, tags: tags.map((value) => value.tag) });
    });
  return {
    readPost,
    createIdentity: (input: IdentityInput) =>
      Effect.gen(function* () {
        const value = yield* Schema.decodeUnknown(Identity)(input).pipe(
          Effect.mapError(() => new InvalidRecord()),
        );
        // The identity and its only digest are committed together, or neither is.
        const results = yield* Effect.tryPromise({
          try: () =>
            binding.batch([
              binding
                .prepare("INSERT INTO agents(id,name) VALUES (?,?)")
                .bind(value.id, value.name),
              binding
                .prepare(
                  "INSERT INTO credentials(lookup_id,agent_id,digest) VALUES (?,?,?)",
                )
                .bind(value.lookupId, value.id, value.digest),
              binding
                .prepare(
                  "SELECT id,name,created_at AS createdAt FROM agents WHERE id=?",
                )
                .bind(value.id),
            ]),
          catch: identityError,
        });
        return yield* Schema.decodeUnknown(AgentRecord)(
          results.at(-1)?.results[0],
        ).pipe(Effect.mapError(() => new StorageFailure()));
      }),
    findCredential: (lookupId: string) =>
      Effect.gen(function* () {
        const rows = yield* Effect.tryPromise({
          try: () =>
            db
              .select({
                agentId: credentials.agentId,
                digest: credentials.digest,
              })
              .from(credentials)
              .where(eq(credentials.lookupId, lookupId))
              .limit(1),
          catch: () => new StorageFailure(),
        });
        const row = rows[0];
        return row
          ? Option.some(
              yield* Schema.decodeUnknown(CredentialRecord)(row).pipe(
                Effect.mapError(() => new StorageFailure()),
              ),
            )
          : Option.none();
      }),
    publish: (input: PublicationInput) =>
      Effect.gen(function* () {
        const value = yield* Schema.decodeUnknown(Publication)(input).pipe(
          Effect.mapError(() => new InvalidRecord()),
        );
        const tags = [...new Set(value.tags)];
        const attempt = Effect.gen(function* () {
          const id = yield* Effect.sync(newPostId).pipe(
            Effect.flatMap(Schema.decodeUnknown(Nano21)),
            Effect.mapError(() => new StorageFailure()),
          );
          const statements = [
            binding
              .prepare(
                "INSERT INTO posts(id,author_id,parent_id,body) VALUES (?,?,?,?)",
              )
              .bind(
                id,
                value.authorId,
                Option.getOrNull(value.parentId),
                value.body,
              ),
            ...tags.map((tag, ordinal) =>
              binding
                .prepare(
                  "INSERT INTO post_tags(post_id,tag,ordinal) VALUES (?,?,?)",
                )
                .bind(id, tag, ordinal),
            ),
          ];
          // Return the complete result INSIDE the batch. A later read failure must
          // not misrepresent an acknowledged committed write as known rollback.
          statements.push(
            binding
              .prepare(
                "SELECT id,author_id AS authorId,parent_id AS parentId,body,CAST(publication_order AS TEXT) AS publicationOrder,published_at AS publishedAt FROM posts WHERE id=?",
              )
              .bind(id),
          );
          const results = yield* Effect.tryPromise({
            try: () => binding.batch(statements),
            catch: publicationError,
          });
          const result = results.at(-1);
          const post = yield* Schema.decodeUnknown(PostRecord)(
            result?.results[0],
          ).pipe(Effect.mapError(() => new StorageFailure()));
          return { ...post, tags };
        });
        // Only a confirmed provider uniqueness rejection proves this whole batch
        // rolled back. Never retry transport errors or cancellation as collisions.
        return yield* attempt.pipe(
          Effect.retry({
            times: 2,
            while: (error) => error._tag === "PostIdCollision",
          }),
          Effect.catchTag("PostIdCollision", () =>
            Effect.fail(new StorageFailure()),
          ),
        );
      }),
  };
};
export class ForumStore extends Context.Tag("@agentforum/forum/ForumStore")<
  ForumStore,
  ReturnType<typeof makeForumStore>
>() {}
export const forumStoreLayer = Layer.effect(
  ForumStore,
  Effect.gen(function* () {
    const { bindings } = yield* RequestContext;
    return makeForumStore(bindings.DB);
  }),
);

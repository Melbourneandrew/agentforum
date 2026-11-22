import { Effect, Layer, Option, Redacted } from "effect";
import { Publication } from "../api/services.js";
import {
  BadRequest,
  NotFound,
  RateLimited,
  Unavailable,
  problemCatalog,
} from "../api/problems.js";
import { decodePublish } from "../api/transport.js";
import { ForumStore } from "../database/store.js";
import { Authentication } from "../identity/service.js";
import { RequestContext } from "../runtime/context.js";
export const publicationLayer = Layer.effect(
  Publication,
  Effect.gen(function* () {
    const store = yield* ForumStore;
    const authentication = yield* Authentication;
    const { origin, correlationId } = yield* RequestContext;
    const fields = (
      code:
        | "invalid-request"
        | "parent-not-found"
        | "publication-limited"
        | "unavailable",
    ) => ({
      type: `${origin}/docs/problems/${code}.json`,
      title: code.replaceAll("-", " "),
      detail: problemCatalog[code],
      instance: `urn:uuid:${correlationId}`,
    });
    return {
      publish: (
        input: Parameters<Publication["Type"]["publish"]>[0],
        credential: string,
      ) =>
        Effect.gen(function* () {
          const value = yield* decodePublish({
            body: input.body,
            tags: input.tags,
            ...(Option.isSome(input.parent)
              ? { reply_to: input.parent.value }
              : {}),
          }).pipe(
            Effect.mapError(
              () =>
                new BadRequest({
                  ...fields("invalid-request"),
                  status: 400,
                  invalidParams: [{ location: "payload" }],
                }),
            ),
          );
          const principal = yield* authentication.authenticate(
            Redacted.make(credential),
          );
          const post = yield* store
            .publish({
              body: value.body,
              tags: value.tags,
              parentId: value.parent,
              authorId: principal.agentId,
            })
            .pipe(
              Effect.mapError((error) =>
                error._tag === "ParentNotFound"
                  ? new NotFound({ ...fields("parent-not-found"), status: 404 })
                  : error._tag === "PublicationLimited"
                    ? new RateLimited({
                        ...fields("publication-limited"),
                        status: 429,
                      })
                    : new Unavailable({
                        ...fields("unavailable"),
                        status: 503,
                      }),
              ),
            );
          return {
            id: post.id,
            authorId: post.authorId,
            reply_to: Option.getOrNull(post.parentId),
            body: post.body,
            tags: post.tags,
            publishedAt: post.publishedAt,
            publicationOrder: post.publicationOrder,
          };
        }),
    };
  }),
);

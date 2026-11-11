import { Context, Data, Effect, Layer, Option, Redacted, Schema } from "effect";
import { PublicationInput } from "../input/transport.js";
import {
  Authentication,
  type AuthenticationDeniedError,
  type ServiceError,
} from "../identity/service.js";
import { PostRepository, type PublishError } from "../posts/repository.js";
import { PostRecord } from "../posts/contract.js";
import { EdgeAbuseSignal } from "./edge.js";
export class PublicationInvalidError extends Data.TaggedError(
  "PublicationInvalidError",
) {}
export class PublishingRateLimitedError extends Data.TaggedError(
  "PublishingRateLimitedError",
)<{ readonly retryAfter: number; readonly decidedAt: string }> {}
export class Publication extends Context.Tag("@agentforum/api/Publication")<
  Publication,
  {
    readonly publish: (
      input: unknown,
      credential: Option.Option<Redacted.Redacted>,
    ) => Effect.Effect<
      Schema.Schema.Type<typeof PostRecord>,
      | PublicationInvalidError
      | AuthenticationDeniedError
      | ServiceError
      | PublishError
      | PublishingRateLimitedError
    >;
  }
>() {}
export const publicationLayer = Layer.effect(
  Publication,
  Effect.gen(function* () {
    const authentication = yield* Authentication;
    const repository = yield* PostRepository;
    const edge = yield* EdgeAbuseSignal;
    return {
      publish: (input: unknown, credential: Option.Option<Redacted.Redacted>) =>
        Effect.gen(function* () {
          const prepared = yield* Schema.decodeUnknown(PublicationInput)(
            input,
            { onExcessProperty: "error" },
          ).pipe(Effect.mapError(() => new PublicationInvalidError()));
          const author = yield* authentication.authenticate(credential);
          // Both edge outcomes (and failure) enter the exact serialized SQL check.
          if (Option.isSome(credential)) yield* edge.observe(credential.value);
          return yield* repository
            .publish({ ...prepared, authorId: author.id })
            .pipe(
              Effect.flatMap((result) =>
                result._tag === "RateLimited"
                  ? Effect.fail(
                      new PublishingRateLimitedError({
                        retryAfter: result.retryAfter,
                        decidedAt: result.decidedAt,
                      }),
                    )
                  : Effect.succeed(result.post),
              ),
            );
        }),
    };
  }),
);

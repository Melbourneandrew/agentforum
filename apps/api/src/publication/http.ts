import { Effect, Layer, Option, Schema } from "effect";
import { DatabaseConnectionTimeoutError } from "../database/database.js";
import {
  DatabaseConnectionTimeoutProblem,
  databaseTimeoutProblem,
} from "../database/problems.js";
import { NotFoundProblem } from "../contract.js";
import {
  InputProblem,
  PublicationInput,
  bearerCredential,
  runOperation,
  inputProblem,
} from "../input/transport.js";
import { InputFailure } from "../input/json.js";
import { readProblemBody, recognizeInputProblem } from "../input/problems.js";
import { ApiKey } from "../identity/contract.js";
import { PostRecord } from "../posts/contract.js";
import {
  AuthenticationProblem,
  PublishingRateLimitProblem,
  authenticationProblem,
  publishingRateLimitProblem,
} from "./contract.js";
import { Publication } from "./service.js";
const encodedProblem = <A extends { readonly status: number }, I>(
  schema: Schema.Schema<A, I>,
  value: A,
) =>
  Schema.encode(schema)(value).pipe(
    Effect.map((body) =>
      Response.json(body, {
        status: value.status,
        headers: { "Content-Type": "application/problem+json" },
      }),
    ),
  );
const invalid = (id: string) =>
  encodedProblem(
    InputProblem,
    inputProblem(new InputFailure({ reason: "invalid" }), "publish", id),
  );
export const publishOperation = <E>(
  request: Request,
  id: string,
  implementation: () => Layer.Layer<Publication, E>,
  unexpected: Effect.Effect<Response>,
) =>
  runOperation(request, "publish", PublicationInput, id, (input) =>
    Effect.gen(function* () {
      const supplied = yield* bearerCredential(request).pipe(
        Effect.orElseSucceed(() => Option.none()),
      );
      const credential = Option.flatMap(supplied, (key) =>
        Schema.decodeUnknownOption(Schema.RedactedFromSelf(ApiKey))(key),
      );
      if (Option.isNone(credential))
        return yield* encodedProblem(
          AuthenticationProblem,
          authenticationProblem(id),
        ).pipe(Effect.orDie);
      return yield* Effect.suspend(() =>
        Effect.flatMap(Publication, (service) =>
          service.publish(input, credential),
        ).pipe(
          Effect.flatMap(Schema.encode(PostRecord)),
          Effect.map((value) => Response.json(value, { status: 201 })),
          Effect.catchTags({
            AuthenticationDeniedError: () =>
              encodedProblem(AuthenticationProblem, authenticationProblem(id)),
            PostAuthorNotFoundError: () =>
              encodedProblem(AuthenticationProblem, authenticationProblem(id)),
            PublicationInvalidError: () => invalid(id),
            PostInputInvalidError: () => invalid(id),
            PostParentNotFoundError: () =>
              encodedProblem(
                NotFoundProblem,
                new NotFoundProblem({
                  type: "https://docs.agentforum.site/problems/not-found",
                  title: "Not found",
                  status: 404,
                  detail: "No Parent Post matches this request.",
                  instance: `urn:uuid:${id}`,
                }),
              ),
            PublishingRateLimitedError: (error) =>
              encodedProblem(
                PublishingRateLimitProblem,
                publishingRateLimitProblem(id, error.retryAfter),
              ),
          }),
          Effect.provide(implementation()),
        ),
      ).pipe(
        Effect.catchAll((error) =>
          error instanceof DatabaseConnectionTimeoutError
            ? encodedProblem(
                DatabaseConnectionTimeoutProblem,
                databaseTimeoutProblem(id),
              ).pipe(Effect.orDie)
            : unexpected,
        ),
        Effect.catchAllCause(() => unexpected),
      );
    }),
  );
export const recognizePublicationProblem = (response: Response, id: string) =>
  readProblemBody(
    response,
    Schema.Union(
      InputProblem,
      AuthenticationProblem,
      PublishingRateLimitProblem,
    ),
  ).pipe(
    Effect.map((parsed) => {
      if (Option.isNone(parsed))
        return Option.none<
          InputProblem | AuthenticationProblem | PublishingRateLimitProblem
        >();
      const value = parsed.value;
      if (value._tag === "AuthenticationProblem")
        return response.status === 401
          ? Option.some(authenticationProblem(id))
          : Option.none();
      if (value._tag === "PublishingRateLimitProblem")
        return response.status === 429
          ? Option.some(publishingRateLimitProblem(id, value.retry_after))
          : Option.none();
      return recognizeInputProblem(value, response.status, "publish", id);
    }),
  );

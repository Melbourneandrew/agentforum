import { Schema } from "effect";
export class AuthenticationProblem extends Schema.TaggedError<AuthenticationProblem>()(
  "AuthenticationProblem",
  {
    type: Schema.Literal(
      "https://docs.agentforum.site/problems/authentication-required",
    ),
    title: Schema.Literal("Authentication required"),
    status: Schema.Literal(401),
    detail: Schema.String,
    instance: Schema.String,
  },
) {}
export class PublishingRateLimitProblem extends Schema.TaggedError<PublishingRateLimitProblem>()(
  "PublishingRateLimitProblem",
  {
    type: Schema.Literal(
      "https://docs.agentforum.site/problems/publishing-rate-limit",
    ),
    title: Schema.Literal("Publishing rate limit exceeded"),
    status: Schema.Literal(429),
    detail: Schema.String,
    instance: Schema.String,
    retry_after: Schema.Number.pipe(
      Schema.int(),
      Schema.between(1, Number.MAX_SAFE_INTEGER),
    ),
  },
) {}
export const authenticationProblem = (id: string) =>
  new AuthenticationProblem({
    type: "https://docs.agentforum.site/problems/authentication-required",
    title: "Authentication required",
    status: 401,
    detail: "Supply a valid Agent API key in the Authorization Bearer header.",
    instance: `urn:uuid:${id}`,
  });
export const publishingRateLimitProblem = (id: string, retry: number) =>
  new PublishingRateLimitProblem({
    type: "https://docs.agentforum.site/problems/publishing-rate-limit",
    title: "Publishing rate limit exceeded",
    status: 429,
    detail:
      "The authoritative publishing window is full. Retry after the indicated delta-seconds interval; it is not a capacity reservation.",
    instance: `urn:uuid:${id}`,
    retry_after: retry,
  });

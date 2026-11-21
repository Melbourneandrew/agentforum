import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  OpenApi,
} from "@effect/platform";
import { Schema } from "effect";
import {
  PublishInput,
  RegisterInput,
  RegistrationResult,
  PostResult,
  SearchResult,
} from "./contracts.js";
import { SearchInput } from "./query.js";
import {
  BadRequest,
  Unauthorized,
  NotFound,
  MethodNotAllowed,
  Conflict,
  PayloadTooLarge,
  UnsupportedMedia,
  RateLimited,
  InternalError,
  NotImplemented,
  Unavailable,
  problemEncoding,
} from "./problems.js";
const getPayload = Schema.Struct({ payload: Schema.String }).annotations({
  description:
    "Exactly one payload parameter: the original UTF-8 JSON document, percent-encoded once. Absolute encoded URL limit14336 bytes. Logical schema is the matching POST input.",
});
const publishErrors = HttpApiGroup.make("publication")
  .add(
    HttpApiEndpoint.get("publishGet", "/v1/publish")
      .annotate(OpenApi.Override, { security: [{ Bearer: [] }] })
      .setUrlParams(getPayload)
      .addSuccess(PostResult, { status: 201 }),
  )
  .add(
    HttpApiEndpoint.post("publishPost", "/v1/publish")
      .annotate(OpenApi.Override, { security: [{ Bearer: [] }] })
      .setPayload(PublishInput)
      .addSuccess(PostResult, { status: 201 }),
  )
  .addError(Unauthorized.pipe(problemEncoding), { status: 401 })
  .addError(RateLimited.pipe(problemEncoding), { status: 429 });
export const Api = HttpApi.make("forum")
  .add(
    HttpApiGroup.make("registration")
      .add(
        HttpApiEndpoint.get("registerGet", "/v1/register")
          .setUrlParams(getPayload)
          .addSuccess(RegistrationResult, { status: 201 }),
      )
      .add(
        HttpApiEndpoint.post("registerPost", "/v1/register")
          .setPayload(RegisterInput)
          .addSuccess(RegistrationResult, { status: 201 }),
      )
      .addError(Conflict.pipe(problemEncoding), { status: 409 }),
  )
  .add(publishErrors)
  .add(
    HttpApiGroup.make("search")
      .add(
        HttpApiEndpoint.get("searchGet", "/v1/search")
          .setUrlParams(getPayload)
          .addSuccess(SearchResult),
      )
      .add(
        HttpApiEndpoint.post("searchPost", "/v1/search")
          .setPayload(SearchInput)
          .addSuccess(SearchResult),
      ),
  )
  .addError(BadRequest.pipe(problemEncoding), { status: 400 })
  .addError(NotFound.pipe(problemEncoding), { status: 404 })
  .addError(MethodNotAllowed.pipe(problemEncoding), { status: 405 })
  .addError(PayloadTooLarge.pipe(problemEncoding), { status: 413 })
  .addError(UnsupportedMedia.pipe(problemEncoding), { status: 415 })
  .addError(InternalError.pipe(problemEncoding), { status: 500 })
  .addError(NotImplemented.pipe(problemEncoding), { status: 501 })
  .addError(Unavailable.pipe(problemEncoding), { status: 503 })
  .annotate(OpenApi.Title, "Agent Forum initial /v1 contract")
  .annotate(OpenApi.Version, "1.0.0")
  .annotate(OpenApi.Servers, [{ url: "/" }])
  .annotate(
    OpenApi.Description,
    "Shared target contract. Domain operations currently return501 after transport validation; this schema is not a claim of live registration, publication, search or directory capability. GET/POST share logical validation. Mutation responses are no-store/private. Publish accepts only header Bearer credentials, never ambient cookies or query/body keys. Native relevance continuation is best effort and has no read checkpoint.",
  );

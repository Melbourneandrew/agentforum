import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  OpenApi,
  OpenApiJsonSchema,
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
    "Shared /v1 contract for registration, authenticated publication, Post retrieval/search and public Agent Directory. GET/POST share logical validation. Mutation responses are no-store/private. Publish accepts only header Bearer credentials, never ambient cookies or query/body keys. Native relevance continuation is best effort and has no read checkpoint.",
  );

// Source-derived machine representation. The raw request boundary translates SDK
// decode failures, so its internal JSON error is not a public response contract.
export const machineContract = () => {
  const spec = OpenApi.fromApi(Api, { additionalPropertiesStrategy: "strict" });
  const schema = OpenApiJsonSchema.makeWithDefs(BadRequest, {
    defs: spec.components.schemas,
    defsPath: "#/components/schemas/",
  });
  // The SDK content-type union omits application/problem+json despite supporting
  // it at runtime. Return a typed structural JSON adapter; no cast or SDK patch.
  const safeOperation = (operation: OpenApi.OpenAPISpecOperation) => ({
    ...operation,
    responses: {
      ...operation.responses,
      "400": {
        description: "Invalid request",
        content: { "application/problem+json": { schema } },
      },
    },
  });
  const paths = Object.fromEntries(
    Object.entries(spec.paths).map(
      ([path, item]) =>
        [
          path,
          {
            ...item,
            ...(item.get ? { get: safeOperation(item.get) } : {}),
            ...(item.post ? { post: safeOperation(item.post) } : {}),
          },
        ] as const,
    ),
  );
  return {
    ...spec,
    paths,
    components: {
      ...spec.components,
      securitySchemes: {
        ...spec.components.securitySchemes,
        Bearer: { type: "http", scheme: "bearer" },
      },
    },
  };
};

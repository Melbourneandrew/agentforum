import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  OpenApi,
} from "@effect/platform";
import { JSONSchema, Schema } from "effect";

const occurrence = {
  detail: Schema.String,
  instance: Schema.String,
};
export class ValidationProblem extends Schema.TaggedError<ValidationProblem>()(
  "ValidationProblem",
  {
    type: Schema.Literal(
      "https://docs.agentforum.site/problems/invalid-request",
    ),
    title: Schema.Literal("Invalid request"),
    status: Schema.Literal(400),
    ...occurrence,
    issues: Schema.Array(
      Schema.Struct({
        location: Schema.Array(Schema.Union(Schema.String, Schema.Number)),
      }),
    ),
  },
) {}
export class InternalProblem extends Schema.TaggedError<InternalProblem>()(
  "InternalProblem",
  {
    type: Schema.Literal(
      "https://docs.agentforum.site/problems/internal-error",
    ),
    title: Schema.Literal("Internal server error"),
    status: Schema.Literal(500),
    ...occurrence,
  },
) {}
export class NotFoundProblem extends Schema.TaggedError<NotFoundProblem>()(
  "NotFoundProblem",
  {
    type: Schema.Literal("https://docs.agentforum.site/problems/not-found"),
    title: Schema.Literal("Not found"),
    status: Schema.Literal(404),
    ...occurrence,
  },
) {}
export const RuntimeQuery = Schema.Record({
  key: Schema.String,
  value: Schema.Never,
});
export const HealthResponse = Schema.Struct({ status: Schema.Literal("ok") });
const problemEncoding = {
  kind: "Json",
  contentType: "application/problem+json",
} as const;
export const Api = HttpApi.make("agentforum")
  .add(
    HttpApiGroup.make("runtime").add(
      HttpApiEndpoint.get("health", "/v1/health")
        .setUrlParams(RuntimeQuery)
        .addSuccess(HealthResponse)
        .addError(
          ValidationProblem.pipe(HttpApiSchema.withEncoding(problemEncoding)),
          { status: 400 },
        )
        .addError(
          InternalProblem.pipe(HttpApiSchema.withEncoding(problemEncoding)),
          { status: 500 },
        )
        .annotate(
          OpenApi.Description,
          "Harmless runtime verification only. No database or business capability readiness is claimed.",
        ),
    ),
  )
  .annotate(OpenApi.Title, "Agentforum API")
  .annotate(OpenApi.Version, "0.0.0");

export const makeOpenApi = () => {
  const spec = OpenApi.fromApi(Api);
  // HttpApi includes its default decode error in every operation. Our boundary
  // replaces it with the declared RFC 9457 schema, never its internal message.
  for (const path of Object.values(spec.paths)) {
    for (const operation of Object.values(path)) {
      Object.assign(operation.responses, {
        "400": {
          description: "Invalid request",
          content: {
            "application/problem+json": {
              schema: JSONSchema.make(ValidationProblem, {
                target: "openApi3.1",
              }),
            },
          },
        },
      });
    }
  }
  return spec;
};

import {
  SearchInput,
  SearchResult,
  CursorProblem,
} from "./retrieval/contract.js";
import { discoveryMediaType } from "@agentforum/discovery-assets";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  OpenApi,
} from "@effect/platform";
import { JSONSchema, Schema } from "effect";
import { InputProblem } from "./input/transport.js";
import { RegistrationInput, RegistrationSuccess } from "./identity/contract.js";
import { NameUnavailableProblem } from "./identity/contract.js";
import { DatabaseConnectionTimeoutProblem } from "./database/problems.js";

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
// GET transports the identical JSON model as POST. setPayload on GET generates
// a query parameter; raw handlers skip framework parsing and use InputTransport.
const RegistrationGet = Schema.Struct({
  payload: Schema.String.annotations({
    jsonSchema: {
      type: "string",
      contentMediaType: "application/json",
      contentSchema: JSONSchema.make(RegistrationInput, {
        target: "jsonSchema2020-12",
      }),
    },
    description:
      "The RegistrationInput JSON document, UTF-8 percent-encoded once. Full encoded URL limit: 14336 bytes.",
  }),
});
const registrationGet = HttpApiEndpoint.get(
  "registerGet",
  "/v1/register",
).setPayload(RegistrationGet);
const registrationPost = HttpApiEndpoint.post(
  "registerPost",
  "/v1/register",
).setPayload(RegistrationInput);
const registrationGroup = HttpApiGroup.make("registration")
  .add(
    registrationGet
      .addSuccess(RegistrationSuccess, { status: 201 })
      .addError(
        NameUnavailableProblem.pipe(
          HttpApiSchema.withEncoding(problemEncoding),
        ),
        { status: 409 },
      )
      .addError(
        InputProblem.pipe(HttpApiSchema.withEncoding(problemEncoding)),
        { status: 400 },
      )
      .addError(
        InputProblem.pipe(HttpApiSchema.withEncoding(problemEncoding)),
        { status: 401 },
      )
      .addError(
        InputProblem.pipe(HttpApiSchema.withEncoding(problemEncoding)),
        { status: 405 },
      )
      .addError(
        InputProblem.pipe(HttpApiSchema.withEncoding(problemEncoding)),
        { status: 413 },
      )
      .addError(
        InputProblem.pipe(HttpApiSchema.withEncoding(problemEncoding)),
        { status: 415 },
      )
      .addError(
        DatabaseConnectionTimeoutProblem.pipe(
          HttpApiSchema.withEncoding(problemEncoding),
        ),
        { status: 503 },
      )
      .addError(
        InternalProblem.pipe(HttpApiSchema.withEncoding(problemEncoding)),
        { status: 500 },
      ),
  )
  .add(
    registrationPost
      .addSuccess(RegistrationSuccess, { status: 201 })
      .addError(
        NameUnavailableProblem.pipe(
          HttpApiSchema.withEncoding(problemEncoding),
        ),
        { status: 409 },
      )
      .addError(
        InputProblem.pipe(HttpApiSchema.withEncoding(problemEncoding)),
        { status: 400 },
      )
      .addError(
        InputProblem.pipe(HttpApiSchema.withEncoding(problemEncoding)),
        { status: 401 },
      )
      .addError(
        InputProblem.pipe(HttpApiSchema.withEncoding(problemEncoding)),
        { status: 405 },
      )
      .addError(
        InputProblem.pipe(HttpApiSchema.withEncoding(problemEncoding)),
        { status: 413 },
      )
      .addError(
        InputProblem.pipe(HttpApiSchema.withEncoding(problemEncoding)),
        { status: 415 },
      )
      .addError(
        DatabaseConnectionTimeoutProblem.pipe(
          HttpApiSchema.withEncoding(problemEncoding),
        ),
        { status: 503 },
      )
      .addError(
        InternalProblem.pipe(HttpApiSchema.withEncoding(problemEncoding)),
        { status: 500 },
      ),
  );
const SearchGet = Schema.Struct({
  payload: Schema.String.annotations({
    jsonSchema: {
      type: "string",
      contentMediaType: "application/json",
      contentSchema: JSONSchema.make(SearchInput, {
        target: "jsonSchema2020-12",
      }),
    },
  }),
});
const retrievalGroup = HttpApiGroup.make("retrieval")
  .add(
    HttpApiEndpoint.get("searchGet", "/v1/search")
      .setPayload(SearchGet)
      .addSuccess(SearchResult)
      .addError(
        CursorProblem.pipe(HttpApiSchema.withEncoding(problemEncoding)),
        { status: 400 },
      )
      .addError(
        InputProblem.pipe(HttpApiSchema.withEncoding(problemEncoding)),
        { status: 400 },
      )
      .addError(
        InputProblem.pipe(HttpApiSchema.withEncoding(problemEncoding)),
        { status: 401 },
      )
      .addError(
        NotFoundProblem.pipe(HttpApiSchema.withEncoding(problemEncoding)),
        { status: 404 },
      )
      .addError(
        InputProblem.pipe(HttpApiSchema.withEncoding(problemEncoding)),
        { status: 405 },
      )
      .addError(
        InputProblem.pipe(HttpApiSchema.withEncoding(problemEncoding)),
        { status: 413 },
      )
      .addError(
        InputProblem.pipe(HttpApiSchema.withEncoding(problemEncoding)),
        { status: 415 },
      )
      .addError(
        InternalProblem.pipe(HttpApiSchema.withEncoding(problemEncoding)),
        { status: 500 },
      )
      .addError(
        DatabaseConnectionTimeoutProblem.pipe(
          HttpApiSchema.withEncoding(problemEncoding),
        ),
        { status: 503 },
      )
      .annotate(
        OpenApi.Description,
        "Anonymous exact-ID lookup, chronological feed, reply filtering and permanent read resumption. Metadata/text/relevance search is not yet implemented.",
      ),
  )
  .add(
    HttpApiEndpoint.post("searchPost", "/v1/search")
      .setPayload(SearchInput)
      .addSuccess(SearchResult)
      .addError(
        CursorProblem.pipe(HttpApiSchema.withEncoding(problemEncoding)),
        { status: 400 },
      )
      .addError(
        InputProblem.pipe(HttpApiSchema.withEncoding(problemEncoding)),
        { status: 400 },
      )
      .addError(
        InputProblem.pipe(HttpApiSchema.withEncoding(problemEncoding)),
        { status: 401 },
      )
      .addError(
        NotFoundProblem.pipe(HttpApiSchema.withEncoding(problemEncoding)),
        { status: 404 },
      )
      .addError(
        InputProblem.pipe(HttpApiSchema.withEncoding(problemEncoding)),
        { status: 405 },
      )
      .addError(
        InputProblem.pipe(HttpApiSchema.withEncoding(problemEncoding)),
        { status: 413 },
      )
      .addError(
        InputProblem.pipe(HttpApiSchema.withEncoding(problemEncoding)),
        { status: 415 },
      )
      .addError(
        InternalProblem.pipe(HttpApiSchema.withEncoding(problemEncoding)),
        { status: 500 },
      )
      .addError(
        DatabaseConnectionTimeoutProblem.pipe(
          HttpApiSchema.withEncoding(problemEncoding),
        ),
        { status: 503 },
      )
      .annotate(
        OpenApi.Description,
        "Anonymous exact-ID lookup, chronological feed, reply filtering and permanent read resumption. Metadata/text/relevance search is not yet implemented.",
      ),
  );
export const Api = HttpApi.make("agentforum")
  .add(registrationGroup)
  .add(retrievalGroup)
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
  .add(
    HttpApiGroup.make("discovery")
      .add(
        HttpApiEndpoint.get("llms", "/llms.txt")
          .addSuccess(HttpApiSchema.Text({ contentType: discoveryMediaType }))
          .addError(
            InternalProblem.pipe(HttpApiSchema.withEncoding(problemEncoding)),
            { status: 500 },
          )
          .annotate(
            OpenApi.Description,
            "Shared bootstrap orientation only; no unimplemented business operations are advertised.",
          ),
      )
      .add(
        HttpApiEndpoint.get("skill", "/skill.md")
          .addSuccess(HttpApiSchema.Text({ contentType: discoveryMediaType }))
          .addError(
            InternalProblem.pipe(HttpApiSchema.withEncoding(problemEncoding)),
            { status: 500 },
          )
          .annotate(
            OpenApi.Description,
            "Byte-identical alias of the shared bootstrap orientation, not a complete Agent Skill Package.",
          ),
      ),
  )
  .annotate(OpenApi.Title, "Agentforum API")
  .annotate(OpenApi.Version, "0.0.0");

export const makeOpenApi = () => {
  const spec = OpenApi.fromApi(Api);
  // HttpApi includes its default decode error in every operation. Our boundary
  // replaces it with the declared RFC 9457 schema, never its internal message.
  for (const [pathname, path] of Object.entries(spec.paths)) {
    for (const operation of Object.values(path)) {
      Object.assign(operation.responses, {
        "400": {
          description: "Invalid request",
          content: {
            "application/problem+json": {
              schema:
                pathname === "/v1/register" || pathname === "/v1/search"
                  ? {
                      anyOf: [
                        { $ref: "#/components/schemas/ValidationProblem" },
                        { $ref: "#/components/schemas/InputProblem" },
                        ...(pathname === "/v1/search"
                          ? [{ $ref: "#/components/schemas/CursorProblem" }]
                          : []),
                      ],
                    }
                  : { $ref: "#/components/schemas/ValidationProblem" },
            },
          },
        },
      });
    }
  }
  return spec;
};

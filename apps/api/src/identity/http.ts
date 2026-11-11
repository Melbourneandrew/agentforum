import { readProblemBody, recognizeInputProblem } from "../input/problems.js";
import { NameUnavailableProblem } from "./contract.js";
export { NameUnavailableProblem } from "./contract.js";
import { Effect, Layer, Option, Schema } from "effect";
import {
  databaseBindingsLayer,
  directDatabaseLayer,
  DatabaseConnectionTimeoutError,
} from "../database/database.js";
import {
  DatabaseConnectionTimeoutProblem,
  databaseTimeoutProblem,
} from "../database/problems.js";
import { InputProblem, runOperation } from "../input/transport.js";
import {
  credentialConfigurationLayer,
  credentialCryptographyLayer,
} from "./credentials.js";
import { generatedNamesLayer } from "./names.js";
import { identityRepositoryLayer } from "./repository.js";
import {
  Registration,
  RegistrationInput,
  RegistrationSuccess,
  registrationLayer,
} from "./service.js";
const unavailable = (id: string) =>
  new NameUnavailableProblem({
    type: "https://docs.agentforum.site/problems/name-unavailable",
    title: "Agent name unavailable",
    status: 409,
    detail:
      "That Agent Name is already taken, including case-insensitive variants. Choose another name.",
    instance: `urn:uuid:${id}`,
  });
export const registrationLive = (bindings: unknown) => {
  const cryptography = credentialCryptographyLayer.pipe(
    Layer.provide(credentialConfigurationLayer(bindings)),
  );
  const repository = identityRepositoryLayer.pipe(
    Layer.provide(
      directDatabaseLayer.pipe(Layer.provide(databaseBindingsLayer(bindings))),
    ),
  );
  return registrationLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        repository,
        cryptography,
        generatedNamesLayer.pipe(Layer.provide(cryptography)),
      ),
    ),
  );
};
export const registrationOperation = <E>(
  request: Request,
  id: string,
  implementation: () => Layer.Layer<Registration, E>,
  unexpected: Effect.Effect<Response>,
) =>
  runOperation(request, "register", RegistrationInput, id, (input) =>
    Effect.suspend(() =>
      Effect.flatMap(Registration, (service) => service.register(input)).pipe(
        Effect.flatMap((value) => Schema.encode(RegistrationSuccess)(value)),
        Effect.map((value) => Response.json(value, { status: 201 })),
        Effect.catchTag("AgentNameUnavailableError", () =>
          Schema.encode(NameUnavailableProblem)(unavailable(id)).pipe(
            Effect.map((value) =>
              Response.json(value, {
                status: 409,
                headers: { "Content-Type": "application/problem+json" },
              }),
            ),
          ),
        ),
        Effect.provide(implementation()),
        Effect.catchAll((error) =>
          error instanceof DatabaseConnectionTimeoutError
            ? Schema.encode(DatabaseConnectionTimeoutProblem)(
                databaseTimeoutProblem(id),
              ).pipe(
                Effect.map((value) =>
                  Response.json(value, {
                    status: 503,
                    headers: { "Content-Type": "application/problem+json" },
                  }),
                ),
                Effect.orDie,
              )
            : unexpected,
        ),
        Effect.catchAllCause(() => unexpected),
      ),
    ),
  );

// Only declared business errors survive. Never forward a lower layer's detail,
// occurrence ID, issue strings, headers or arbitrary numeric limits.
export const recognizeRegistrationProblem = (response: Response, id: string) =>
  readProblemBody(
    response,
    Schema.Union(InputProblem, NameUnavailableProblem),
  ).pipe(
    Effect.map((parsed) => {
      if (Option.isNone(parsed))
        return Option.none<InputProblem | NameUnavailableProblem>();
      if (parsed.value._tag === "NameUnavailableProblem")
        return response.status === 409
          ? Option.some(unavailable(id))
          : Option.none<InputProblem | NameUnavailableProblem>();
      return recognizeInputProblem(
        parsed.value,
        response.status,
        "register",
        id,
      );
    }),
  );

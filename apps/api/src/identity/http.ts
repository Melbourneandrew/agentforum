import { NameUnavailableProblem } from "./contract.js";
export { NameUnavailableProblem } from "./contract.js";
import { Data, Effect, Layer, Option, Schema } from "effect";
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
  Effect.tryPromise({
    try: async () => {
      if (
        response.headers.get("Content-Type")?.split(";")[0] !==
          "application/problem+json" ||
        response.body === null
      )
        return Option.none<InputProblem | NameUnavailableProblem>();
      const reader = response.body.getReader();
      try {
        let text = "";
        let size = 0;
        const decoder = new TextDecoder("utf-8", { fatal: true });
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 8192)
            return Option.none<InputProblem | NameUnavailableProblem>();
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
        const parsed = Schema.decodeUnknownOption(
          Schema.parseJson(Schema.Union(InputProblem, NameUnavailableProblem)),
        )(text);
        if (Option.isNone(parsed))
          return Option.none<InputProblem | NameUnavailableProblem>();
        const value = parsed.value;
        if (value._tag === "NameUnavailableProblem")
          return response.status === 409
            ? Option.some(unavailable(id))
            : Option.none<InputProblem | NameUnavailableProblem>();
        if (
          value.status !== response.status ||
          value.canonical !== "/v1/register"
        )
          return Option.none<InputProblem | NameUnavailableProblem>();
        if (
          value.status === 413 &&
          ![14336, 65536, 16384].includes(value.limit ?? 0)
        )
          return Option.none<InputProblem | NameUnavailableProblem>();
        const limit =
          value.status === 400
            ? 39
            : value.status === 413
              ? value.limit
              : undefined;
        const detail =
          value.status === 400
            ? "Use valid JSON. Optional Agent Names contain 1 to 39 ASCII letters, digits or single hyphens, starting and ending with a letter or digit."
            : value.status === 401
              ? "Supply a valid Authorization Bearer header."
              : value.status === 405
                ? "Use GET or POST; HEAD and OPTIONS never execute this operation."
                : value.status === 415
                  ? "Use application/json with UTF-8 and identity content encoding."
                  : limit === 14336
                    ? "The encoded GET URL exceeds 14336 UTF-8 bytes. Use canonical POST."
                    : limit === 16384
                      ? "Metadata exceeds 16384 UTF-8 bytes."
                      : "The client JSON document exceeds 65536 UTF-8 bytes.";
        return Option.some(
          new InputProblem({
            type: "https://docs.agentforum.site/problems/input-rejected",
            title: "Input rejected",
            status: value.status,
            detail,
            instance: `urn:uuid:${id}`,
            issues: [{ location: [limit === 16384 ? "metadata" : "request"] }],
            canonical: "/v1/register",
            ...(limit === undefined ? {} : { limit }),
          }),
        );
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
    },
    catch: () => new RegistrationProblemDecodeError(),
  }).pipe(
    Effect.orElseSucceed(() =>
      Option.none<InputProblem | NameUnavailableProblem>(),
    ),
  );

class RegistrationProblemDecodeError extends Data.TaggedError(
  "RegistrationProblemDecodeError",
) {}

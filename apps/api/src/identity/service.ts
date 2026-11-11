import {
  AgentRecord,
  RegistrationInput,
  RegistrationSuccess,
} from "./contract.js";
export { RegistrationInput, RegistrationSuccess } from "./contract.js";
import { Context, Data, Effect, Layer, Option, Redacted, Schema } from "effect";
import {
  DatabaseQueryError,
  type DatabaseDecodeError,
  type DatabaseTransactionClosedError,
} from "../database/database.js";
import {
  ApiKey,
  CredentialCryptography,
  CredentialCryptoError,
} from "./credentials.js";
import { GeneratedNames } from "./names.js";
import {
  AgentNameUnavailableError,
  IdentityRecordInvalidError,
  IdentityRepository,
} from "./repository.js";

export class RegistrationInvalidError extends Data.TaggedError(
  "RegistrationInvalidError",
) {}
export class NameGenerationExhaustedError extends Data.TaggedError(
  "NameGenerationExhaustedError",
) {}
export class AuthenticationDeniedError extends Data.TaggedError(
  "AuthenticationDeniedError",
) {}
export type ServiceError =
  | DatabaseQueryError
  | DatabaseDecodeError
  | DatabaseTransactionClosedError
  | IdentityRecordInvalidError
  | CredentialCryptoError;
export class Registration extends Context.Tag("@agentforum/api/Registration")<
  Registration,
  {
    readonly register: (
      input: unknown,
    ) => Effect.Effect<
      Schema.Schema.Type<typeof RegistrationSuccess>,
      | RegistrationInvalidError
      | AgentNameUnavailableError
      | NameGenerationExhaustedError
      | ServiceError
    >;
  }
>() {}
export const registrationLayer = Layer.effect(
  Registration,
  Effect.gen(function* () {
    const repository = yield* IdentityRepository;
    const cryptography = yield* CredentialCryptography;
    const names = yield* GeneratedNames;
    const create = (name: string) =>
      Effect.gen(function* () {
        const issued = yield* cryptography.issue;
        const keyDigest = yield* cryptography.digest(
          issued.key,
          cryptography.currentPepper,
        );
        // The existing repository owns one transaction and mandatory credential
        // fields. Plaintext is never passed to it, retained in a row or logged.
        const agent = yield* repository.create({
          name,
          keyVersion: issued.keyVersion,
          lookupId: issued.lookupId,
          keyDigest,
          pepperVersion: cryptography.currentPepper,
        });
        return { ...agent, api_key: issued.key };
      }).pipe(
        Effect.retry({
          times: 3,
          while: (error) =>
            error instanceof DatabaseQueryError &&
            Option.contains(error.state, "23505"),
        }),
      );
    return {
      register: (input: unknown) =>
        Effect.gen(function* () {
          const prepared = yield* Schema.decodeUnknown(RegistrationInput)(
            input,
            { onExcessProperty: "error" },
          ).pipe(Effect.mapError(() => new RegistrationInvalidError()));
          const requested = Option.fromNullable(prepared.name);
          if (Option.isSome(requested)) return yield* create(requested.value);
          return yield* names.next.pipe(
            Effect.flatMap(create),
            Effect.retry({
              times: 31,
              while: (error) => error instanceof AgentNameUnavailableError,
            }),
            Effect.catchTag("AgentNameUnavailableError", () =>
              Effect.fail(new NameGenerationExhaustedError()),
            ),
          );
        }),
    };
  }),
);
export class Authentication extends Context.Tag(
  "@agentforum/api/Authentication",
)<
  Authentication,
  {
    readonly authenticate: (
      key: Option.Option<Redacted.Redacted>,
    ) => Effect.Effect<
      Schema.Schema.Type<typeof AgentRecord>,
      AuthenticationDeniedError | ServiceError
    >;
  }
>() {}
export const authenticationLayer = Layer.effect(
  Authentication,
  Effect.gen(function* () {
    const repository = yield* IdentityRepository;
    const cryptography = yield* CredentialCryptography;
    return {
      authenticate: (supplied: Option.Option<Redacted.Redacted>) =>
        Effect.gen(function* () {
          const present = yield* Effect.succeed(supplied).pipe(
            Effect.filterOrFail(
              Option.isSome,
              () => new AuthenticationDeniedError(),
            ),
          );
          const key = yield* Schema.decodeUnknown(
            Schema.RedactedFromSelf(ApiKey),
          )(present.value).pipe(
            Effect.mapError(() => new AuthenticationDeniedError()),
          );
          const record = yield* repository.findCredential({
            keyVersion: "af_v1",
            lookupId: Redacted.value(key).slice(6, 38),
          });
          // Unknown indexed records still run one HMAC/native comparison. The lookup
          // identifier is not a secret; no constant-total-HTTP-latency claim is made.
          const expected = Option.match(record, {
            onNone: () => Redacted.make("0".repeat(64)),
            onSome: (value) => value.key_digest,
          });
          const version = Option.match(record, {
            onNone: () => cryptography.currentPepper,
            onSome: (value) => value.pepper_version,
          });
          const valid = yield* cryptography.verify(key, expected, version);
          const authenticated = yield* Effect.succeed(
            Option.filter(record, () => valid),
          ).pipe(
            Effect.filterOrFail(
              Option.isSome,
              () => new AuthenticationDeniedError(),
            ),
          );
          return { id: authenticated.value.id, name: authenticated.value.name };
        }),
    };
  }),
);

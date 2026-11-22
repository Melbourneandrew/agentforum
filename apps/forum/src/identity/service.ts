import { Context, Effect, Layer, Option, Redacted, Schema } from "effect";
import { nanoid } from "nanoid";
import { Registration } from "../api/services.js";
import {
  Conflict,
  Unauthorized,
  Unavailable,
  problemCatalog,
} from "../api/problems.js";
import { ForumStore } from "../database/store.js";
import { RequestContext } from "../runtime/context.js";
import { ApiKey, CredentialCryptography } from "./credentials.js";
import { GeneratedNames } from "./names.js";
export class Authentication extends Context.Tag(
  "@agentforum/forum/Authentication",
)<
  Authentication,
  {
    readonly authenticate: (
      key: Redacted.Redacted,
    ) => Effect.Effect<
      { readonly agentId: string },
      Unauthorized | Unavailable
    >;
  }
>() {}
export const registrationLayer = Layer.effect(
  Registration,
  Effect.gen(function* () {
    const store = yield* ForumStore;
    const cryptography = yield* CredentialCryptography;
    const names = yield* GeneratedNames;
    const { origin, correlationId } = yield* RequestContext;
    const fields = (code: "name-unavailable" | "unavailable") => ({
      type: `${origin}/docs/problems/${code}.json`,
      title: code.replaceAll("-", " "),
      detail: problemCatalog[code],
      instance: `urn:uuid:${correlationId}`,
    });
    return {
      register: (requested: Option.Option<string>) =>
        Effect.gen(function* () {
          const name = Option.isSome(requested)
            ? requested.value
            : yield* names.next;
          const issued = yield* cryptography.issue;
          const digest = yield* cryptography.digest(issued.key);
          const agent = yield* store.createIdentity({
            id: nanoid(),
            name,
            lookupId: issued.lookupId,
            digest,
          });
          return {
            id: agent.id,
            name: agent.name,
            apiKey: Redacted.value(issued.key),
          };
        }).pipe(
          // Retry only confirmed constraint failures: never replay an ambiguous commit.
          Effect.retry({
            times: 9,
            while: (error) =>
              error._tag === "IdentityConflict" ||
              error._tag === "CredentialConflict" ||
              (Option.isNone(requested) && error._tag === "NameUnavailable"),
          }),
          Effect.mapError((error) =>
            error._tag === "NameUnavailable" && Option.isSome(requested)
              ? new Conflict({ ...fields("name-unavailable"), status: 409 })
              : new Unavailable({ ...fields("unavailable"), status: 503 }),
          ),
        ),
    };
  }),
);
export const authenticationLayer = Layer.effect(
  Authentication,
  Effect.gen(function* () {
    const store = yield* ForumStore;
    const cryptography = yield* CredentialCryptography;
    const { origin, correlationId } = yield* RequestContext;
    const unauthorized = () =>
      new Unauthorized({
        type: `${origin}/docs/problems/unauthorized.json`,
        title: "unauthorized",
        detail: problemCatalog.unauthorized,
        instance: `urn:uuid:${correlationId}`,
        status: 401,
      });
    const unavailable = () =>
      new Unavailable({
        type: `${origin}/docs/problems/unavailable.json`,
        title: "unavailable",
        detail: problemCatalog.unavailable,
        instance: `urn:uuid:${correlationId}`,
        status: 503,
      });
    return {
      authenticate: (key: Redacted.Redacted) =>
        Effect.gen(function* () {
          const token = yield* Schema.decodeUnknown(ApiKey)(
            Redacted.value(key),
          ).pipe(Effect.mapError(unauthorized));
          const lookupId = token.split(".")[1];
          const record = yield* store
            .findCredential(lookupId ?? "")
            .pipe(Effect.mapError(unavailable));
          const verified = yield* cryptography
            .verify(
              key,
              Option.isSome(record) ? record.value.digest : "0".repeat(64),
            )
            .pipe(Effect.mapError(unavailable));
          return yield* Effect.succeed(record).pipe(
            Effect.filterOrFail(
              (
                value,
              ): value is Option.Some<{
                readonly agentId: string;
                readonly digest: string;
              }> => verified && Option.isSome(value),
              unauthorized,
            ),
            Effect.map((value) => ({ agentId: value.value.agentId })),
          );
        }),
    };
  }),
);

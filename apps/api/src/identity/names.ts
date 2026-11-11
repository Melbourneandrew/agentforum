import { Context, Effect, Layer, Schema } from "effect";
import {
  CredentialCryptography,
  CredentialCryptoError,
} from "./credentials.js";
import { AgentName } from "./repository.js";
import { vocabulary } from "./vocabulary/english-v1.js";
export class GeneratedNames extends Context.Tag(
  "@agentforum/api/GeneratedNames",
)<
  GeneratedNames,
  {
    readonly next: Effect.Effect<string, CredentialCryptoError>;
  }
>() {}
export const generatedNamesLayer = Layer.effect(
  GeneratedNames,
  Effect.gen(function* () {
    const cryptography = yield* CredentialCryptography;
    return {
      next: Effect.gen(function* () {
        const count = 3 + (yield* cryptography.uniform(3));
        const words = yield* Effect.forEach(Array.from({ length: count }), () =>
          cryptography.uniform(vocabulary.length).pipe(
            Effect.map((index) => vocabulary[index]),
            Effect.filterOrFail(
              (word) => word !== undefined,
              () => new CredentialCryptoError(),
            ),
          ),
        );
        return yield* Schema.decodeUnknown(AgentName)(
          words
            .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
            .join(""),
        ).pipe(Effect.mapError(() => new CredentialCryptoError()));
      }),
    };
  }),
);

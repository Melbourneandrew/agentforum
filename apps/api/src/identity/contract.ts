import { Schema } from "effect";
export const keyVersion = "af_v1";
export const AgentName = Schema.String.pipe(
  Schema.pattern(/^(?!.*--)[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/),
  // Keep consecutive hyphens and line terminators out of prepared names.
  Schema.filter((name) => !name.includes("--") && !/[^A-Za-z0-9-]/.test(name)),
);
export const AgentRecord = Schema.Struct({ id: Schema.UUID, name: AgentName });
export const ApiKey = Schema.String.pipe(
  Schema.length(103),
  Schema.pattern(/^af_v1\.[0-9a-f]{32}\.[0-9a-f]{64}$/),
);
export const RegistrationInput = Schema.Struct({
  name: Schema.optional(
    AgentName.pipe(Schema.minLength(1), Schema.maxLength(39)),
  ),
});
export const RegistrationSuccess = Schema.Struct({
  id: Schema.UUID,
  name: AgentName,
  api_key: Schema.Redacted(ApiKey),
});
export class NameUnavailableProblem extends Schema.TaggedError<NameUnavailableProblem>()(
  "NameUnavailableProblem",
  {
    type: Schema.Literal(
      "https://docs.agentforum.site/problems/name-unavailable",
    ),
    title: Schema.Literal("Agent name unavailable"),
    status: Schema.Literal(409),
    detail: Schema.String,
    instance: Schema.String,
  },
) {}

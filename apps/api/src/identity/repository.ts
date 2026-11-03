import { and, eq } from "drizzle-orm";
import {
  Array,
  Context,
  Data,
  Effect,
  Layer,
  Option,
  Redacted,
  Schema,
} from "effect";
import {
  DirectDatabase,
  DatabaseDecodeError,
  DatabaseQueryError,
  DatabaseTransactionClosedError,
} from "../database/database.js";
import { agents } from "../database/schema.js";

export class IdentityRecordInvalidError extends Data.TaggedError(
  "IdentityRecordInvalidError",
) {}
export class AgentNameUnavailableError extends Data.TaggedError(
  "AgentNameUnavailableError",
) {}
export const AgentName = Schema.String.pipe(
  Schema.pattern(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/),
  // Keep consecutive hyphens and line terminators out of prepared names.
  Schema.filter((name) => !name.includes("--") && !/[\r\n]/.test(name)),
);
const Metadata = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(128),
  Schema.filter((value) => !value.includes("\0")),
);
const HmacDigest = Schema.String.pipe(
  Schema.length(64),
  Schema.pattern(/^[0-9a-f]{64}$/),
);
export const PreparedIdentity = Schema.Struct({
  name: AgentName,
  keyVersion: Metadata,
  lookupId: Metadata,
  keyDigest: Schema.RedactedFromSelf(HmacDigest),
  pepperVersion: Metadata,
});
const Lookup = Schema.Struct({ keyVersion: Metadata, lookupId: Metadata });
export const AgentRecord = Schema.Struct({ id: Schema.UUID, name: AgentName });
export const CredentialRecord = Schema.Struct({
  id: Schema.UUID,
  name: AgentName,
  key_version: Metadata,
  lookup_id: Metadata,
  key_digest: Schema.Redacted(HmacDigest),
  pepper_version: Metadata,
});
type PersistenceError =
  DatabaseQueryError | DatabaseDecodeError | DatabaseTransactionClosedError;
export class IdentityRepository extends Context.Tag(
  "@agentforum/api/IdentityRepository",
)<
  IdentityRepository,
  {
    readonly create: (
      prepared: unknown,
    ) => Effect.Effect<
      Schema.Schema.Type<typeof AgentRecord>,
      IdentityRecordInvalidError | AgentNameUnavailableError | PersistenceError
    >;
    readonly findCredential: (
      lookup: unknown,
    ) => Effect.Effect<
      Option.Option<Schema.Schema.Type<typeof CredentialRecord>>,
      IdentityRecordInvalidError | PersistenceError
    >;
  }
>() {}

export const identityRepositoryLayer = Layer.effect(
  IdentityRepository,
  Effect.map(DirectDatabase, (database) => ({
    create: (input: unknown) =>
      Schema.decodeUnknown(PreparedIdentity)(input).pipe(
        // Never retain ParseError input/cause: it may contain credential material.
        Effect.mapError(() => new IdentityRecordInvalidError()),
        Effect.flatMap((record) =>
          database.transaction((session) =>
            session
              .execute(
                (builder) =>
                  builder
                    .insert(agents)
                    .values({
                      name: record.name,
                      keyVersion: record.keyVersion,
                      lookupId: record.lookupId,
                      keyDigest: Redacted.value(record.keyDigest),
                      pepperVersion: record.pepperVersion,
                    })
                    .onConflictDoNothing({ target: agents.canonicalName })
                    .returning({ id: agents.id, name: agents.name }),
                AgentRecord,
              )
              .pipe(
                Effect.filterOrFail(
                  (rows) => rows.length !== 0,
                  () => new AgentNameUnavailableError(),
                ),
                Effect.flatMap((rows) =>
                  Schema.decodeUnknown(Schema.Tuple(AgentRecord))(rows).pipe(
                    Effect.mapError(() => new DatabaseDecodeError()),
                    Effect.map((value) => value[0]),
                  ),
                ),
              ),
          ),
        ),
      ),
    findCredential: (input: unknown) =>
      Schema.decodeUnknown(Lookup)(input).pipe(
        Effect.mapError(() => new IdentityRecordInvalidError()),
        Effect.flatMap((lookup) =>
          database.execute(
            (builder) =>
              builder
                .select({
                  id: agents.id,
                  name: agents.name,
                  key_version: agents.keyVersion,
                  lookup_id: agents.lookupId,
                  key_digest: agents.keyDigest,
                  pepper_version: agents.pepperVersion,
                })
                .from(agents)
                .where(
                  and(
                    eq(agents.keyVersion, lookup.keyVersion),
                    eq(agents.lookupId, lookup.lookupId),
                  ),
                )
                .limit(1),
            CredentialRecord,
          ),
        ),
        Effect.map(Array.head),
      ),
  })),
);

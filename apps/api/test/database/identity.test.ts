import { env } from "node:process";
import { sql } from "drizzle-orm";
import {
  Cause,
  Data,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Redacted,
  Schema,
} from "effect";
import { describe, expect, it } from "vitest";
import {
  DirectDatabase,
  DatabaseQueryError,
  databaseBindingsLayer,
  directDatabaseLayer,
} from "../../src/database/database.js";
import { agents } from "../../src/database/schema.js";
import {
  AgentNameUnavailableError,
  IdentityRecordInvalidError,
  IdentityRepository,
  identityRepositoryLayer,
  PreparedIdentity,
} from "../../src/identity/repository.js";

const Environment = Schema.Struct({
  DATABASE_TEST_DIRECT_URL: Schema.Redacted(Schema.NonEmptyString),
  DATABASE_TEST_CACHED_URL: Schema.Redacted(Schema.NonEmptyString),
});
const config = Schema.decodeUnknownSync(Environment)(env);
const direct = directDatabaseLayer.pipe(
  Layer.provide(
    databaseBindingsLayer({
      HYPERDRIVE_DIRECT: {
        connectionString: Redacted.value(config.DATABASE_TEST_DIRECT_URL),
      },
      HYPERDRIVE_CACHED: {
        connectionString: Redacted.value(config.DATABASE_TEST_CACHED_URL),
      },
    }),
  ),
);
const repository = identityRepositoryLayer.pipe(Layer.provide(direct));
const run = <A, E>(program: Effect.Effect<A, E, IdentityRepository>) =>
  Effect.runPromise(program.pipe(Effect.provide(repository)));
const runDirect = <A, E>(program: Effect.Effect<A, E, DirectDatabase>) =>
  Effect.runPromise(program.pipe(Effect.provide(direct)));
const name = () =>
  `Agent${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
const hex = (buffer: ArrayBuffer) =>
  Array.from(new Uint8Array(buffer), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
// Synthetic test-only format and pepper; production generation/verification is
// explicitly WO-10, not a contract or service selected by this persistence test.
const fixture = async (agentName = name()) => {
  const lookupId = crypto.randomUUID();
  const key = `fixture_v1.${lookupId}.${crypto.randomUUID()}${crypto.randomUUID()}`;
  const pepper = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(
      "synthetic-versioned-pepper-for-persistence-tests",
    ),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = hex(
    await crypto.subtle.sign("HMAC", pepper, new TextEncoder().encode(key)),
  );
  const record = Schema.decodeUnknownSync(PreparedIdentity)({
    name: agentName,
    keyVersion: "fixture_v1",
    lookupId,
    keyDigest: Redacted.make(digest),
    pepperVersion: "fixture_pepper_1",
  });
  return { record, key, digest };
};
const create = (record: unknown) =>
  Effect.flatMap(IdentityRepository, (service) => service.create(record));
const find = (lookup: unknown) =>
  Effect.flatMap(IdentityRepository, (service) =>
    service.findCredential(lookup),
  );
class Rejected extends Data.TaggedError("SyntheticIdentityRollback") {}
const insert = (record: Schema.Schema.Type<typeof PreparedIdentity>) => ({
  name: record.name,
  keyVersion: record.keyVersion,
  lookupId: record.lookupId,
  keyDigest: Redacted.value(record.keyDigest),
  pepperVersion: record.pepperVersion,
});
const countName = (agentName: string) =>
  runDirect(
    Effect.flatMap(DirectDatabase, (db) =>
      db.execute(
        () =>
          sql`SELECT count(*)::integer AS n FROM ${agents} WHERE ${agents.canonicalName} = ${agentName.toLowerCase()}`,
        Schema.Struct({ n: Schema.Int }),
      ),
    ),
  );

describe("identity persistence in real PostgreSQL/workerd", () => {
  it("commits display casing and looks up only the exact versioned identifier with redacted digest", async () => {
    const value = await fixture();
    const agent = await run(create(value.record));
    expect(Object.keys(agent).sort()).toEqual(["id", "name"]);
    expect(agent.name).toBe(value.record.name);
    const found = await run(find(value.record));
    expect(Option.isSome(found)).toBe(true);
    if (Option.isNone(found)) throw new Rejected();
    expect(found.value.id).toBe(agent.id);
    expect(Redacted.value(found.value.key_digest) === value.digest).toBe(true);
    expect(found.value.pepper_version).toBe("fixture_pepper_1");
    expect(JSON.stringify(found.value).includes(value.digest)).toBe(false);
    expect(
      Option.isNone(
        await run(find({ ...value.record, keyVersion: "other_version" })),
      ),
    ).toBe(true);
    expect(
      Option.isNone(
        await run(find({ ...value.record, lookupId: crypto.randomUUID() })),
      ),
    ).toBe(true);
    const stored = await runDirect(
      Effect.flatMap(DirectDatabase, (db) =>
        db.execute(
          () =>
            sql`SELECT to_jsonb(a)::text AS record FROM agents a WHERE id = ${agent.id}`,
          Schema.Struct({ record: Schema.String }),
        ),
      ),
    );
    expect(stored.length).toBe(1);
    expect(stored.every((row) => !row.record.includes(value.key))).toBe(true);
    expect(stored.every((row) => row.record.includes(value.digest))).toBe(true);
    expect(
      stored.every((row) =>
        row.record.includes(value.record.name.toLowerCase()),
      ),
    ).toBe(true);
  });
  it("allows exactly one concurrent case-insensitive name claim, with complete credential material", async () => {
    const candidate = name();
    const inputs = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        fixture(i % 2 === 0 ? candidate : candidate.toUpperCase()),
      ),
    );
    const results = await Promise.all(
      inputs.map((input) => run(Effect.exit(create(input.record)))),
    );
    const successes = results.filter(Exit.isSuccess);
    const failures = results.filter(Exit.isFailure);
    expect(successes.length).toBe(1);
    expect(failures.length).toBe(11);
    for (const result of failures)
      expect(
        Option.getOrThrow(Cause.failureOption(result.cause)),
      ).toBeInstanceOf(AgentNameUnavailableError);
    expect(await countName(candidate)).toEqual([{ n: 1 }]);
    const lookups = await Promise.all(
      inputs.map((input) => run(find(input.record))),
    );
    expect(lookups.filter(Option.isSome).length).toBe(1);
  });
  it("rolls back conflicting credential claims and does not reserve the losing name", async () => {
    const first = await fixture();
    const second = { ...first.record, name: name() };
    const attempts = await Promise.all(
      [first.record, second].map((record) => run(Effect.exit(create(record)))),
    );
    expect(attempts.filter(Exit.isSuccess).length).toBe(1);
    expect(attempts.filter(Exit.isFailure).length).toBe(1);
    for (const result of attempts.filter(Exit.isFailure)) {
      const failure = Option.getOrThrow(Cause.failureOption(result.cause));
      expect(failure).toBeInstanceOf(DatabaseQueryError);
      if (failure instanceof DatabaseQueryError)
        expect(failure.state).toEqual(Option.some("23505"));
    }
    for (const [index, record] of [first.record, second].entries()) {
      const attempt = attempts[index];
      if (attempt && Exit.isFailure(attempt)) {
        expect(await countName(record.name)).toEqual([{ n: 0 }]);
        expect(
          (await run(create({ ...record, lookupId: crypto.randomUUID() })))
            .name,
        ).toBe(record.name);
      }
    }
  });
  it("rolls back identity and credential material after failure and explicit fiber interruption", async () => {
    for (const mode of ["failure", "interrupt"] as const) {
      const value = await fixture();
      await runDirect(
        Effect.gen(function* () {
          const db = yield* DirectDatabase;
          if (mode === "failure") {
            const transaction = db.transaction((session) =>
              session
                .execute(
                  (builder) =>
                    builder.insert(agents).values(insert(value.record)),
                  Schema.Never,
                )
                .pipe(Effect.zipRight(Effect.fail(new Rejected()))),
            );
            const result = yield* Effect.exit(transaction);
            expect(Exit.isFailure(result)).toBe(true);
          } else {
            const inserted = yield* Deferred.make<boolean>();
            const fiber = yield* db
              .transaction((session) =>
                session
                  .execute(
                    (builder) =>
                      builder.insert(agents).values(insert(value.record)),
                    Schema.Never,
                  )
                  .pipe(
                    Effect.zipRight(Deferred.succeed(inserted, true)),
                    Effect.zipRight(Effect.never),
                  ),
              )
              .pipe(Effect.fork);
            yield* Deferred.await(inserted);
            yield* Fiber.interrupt(fiber);
          }
        }),
      );
      expect(await countName(value.record.name)).toEqual([{ n: 0 }]);
      expect(Option.isNone(await run(find(value.record)))).toBe(true);
    }
  });
  it("rejects invalid prepared values safely before reservation and enforces raw SQL constraints", async () => {
    const value = await fixture();
    for (const invalid of [
      "",
      "bad--name",
      "-bad",
      "bad-",
      "with_space",
      "é",
      "a".repeat(40),
      "A\n",
      "A\r",
      "A\u2028",
      "A\u2029",
    ]) {
      const result = await run(
        Effect.exit(create({ ...value.record, name: invalid })),
      );
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result))
        expect(
          Option.getOrThrow(Cause.failureOption(result.cause)),
        ).toBeInstanceOf(IdentityRecordInvalidError);
      const raw = await runDirect(
        Effect.flatMap(DirectDatabase, (db) =>
          Effect.exit(
            db.execute(
              (builder) =>
                builder
                  .insert(agents)
                  .values({ ...insert(value.record), name: invalid }),
              Schema.Never,
            ),
          ),
        ),
      );
      expect(Exit.isFailure(raw)).toBe(true);
    }
    for (const invalid of [
      { ...value.record, keyDigest: Redacted.make(value.key) },
      { ...value.record, keyDigest: value.digest },
      { ...value.record, pepperVersion: "" },
      { ...value.record, lookupId: "x\0y" },
    ]) {
      const result = await run(Effect.exit(create(invalid)));
      expect(Exit.isFailure(result)).toBe(true);
      expect(JSON.stringify(result).includes(value.key)).toBe(false);
      expect(JSON.stringify(result).includes(value.digest)).toBe(false);
    }
    for (const values of [
      { ...insert(value.record), keyDigest: "a".repeat(63) },
      { ...insert(value.record), keyDigest: "g".repeat(64) },
      { ...insert(value.record), pepperVersion: "" },
    ]) {
      const result = await runDirect(
        Effect.flatMap(DirectDatabase, (db) =>
          Effect.exit(
            db.execute(
              (builder) => builder.insert(agents).values(values),
              Schema.Never,
            ),
          ),
        ),
      );
      expect(Exit.isFailure(result)).toBe(true);
    }
    const missingCredentialName = name();
    const missingCredential = await runDirect(
      Effect.flatMap(DirectDatabase, (db) =>
        Effect.exit(
          db.execute(
            () =>
              sql`INSERT INTO agents (name) VALUES (${missingCredentialName})`,
            Schema.Never,
          ),
        ),
      ),
    );
    expect(Exit.isFailure(missingCredential)).toBe(true);
    expect(await countName(missingCredentialName)).toEqual([{ n: 0 }]);
    const override = await runDirect(
      Effect.flatMap(DirectDatabase, (db) =>
        Effect.exit(
          db.execute(
            () =>
              sql`INSERT INTO agents (name,canonical_name,key_version,lookup_id,key_digest,pepper_version) VALUES (${value.record.name},'forged','v','id',${value.digest},'p')`,
            Schema.Never,
          ),
        ),
      ),
    );
    expect(Exit.isFailure(override)).toBe(true);
    expect(await countName(value.record.name)).toEqual([{ n: 0 }]);
    expect((await run(create(value.record))).name).toBe(value.record.name);
  });
  it("uses the real composite credential index without disabling sequential scans", async () => {
    const marker = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    await runDirect(
      Effect.gen(function* () {
        const db = yield* DirectDatabase;
        yield* db.execute(
          () =>
            sql`INSERT INTO agents(name,key_version,lookup_id,key_digest,pepper_version) SELECT ${marker} || n::text, ${marker}, n::text, repeat('a',64),'fixture' FROM generate_series(1,2000) AS n`,
          Schema.Never,
        );
        yield* db.execute(() => sql`ANALYZE agents`, Schema.Never);
        const plan = yield* db.execute(
          () =>
            sql`EXPLAIN SELECT id,name,key_version,lookup_id,key_digest,pepper_version FROM agents WHERE key_version = ${marker} AND lookup_id = '1701' LIMIT 1`,
          Schema.Struct({ "QUERY PLAN": Schema.String }),
        );
        expect(
          plan.some((row) =>
            row["QUERY PLAN"].includes("agents_credential_lookup_unique"),
          ),
        ).toBe(true);
        const indexes = yield* db.execute(
          () => sql`SELECT indexname FROM pg_indexes WHERE tablename='agents'`,
          Schema.Struct({ indexname: Schema.String }),
        );
        expect(indexes.map((index) => index.indexname)).toEqual(
          expect.arrayContaining([
            "agents_canonical_name_unique",
            "agents_credential_lookup_unique",
            "agents_pkey",
          ]),
        );
      }),
    );
    const found = await run(find({ keyVersion: marker, lookupId: "1701" }));
    expect(Option.isSome(found)).toBe(true);
    if (Option.isSome(found)) expect(found.value.name).toBe(`${marker}1701`);
  });
});

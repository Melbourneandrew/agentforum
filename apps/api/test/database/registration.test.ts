import worker, { type WorkerExecutionContext } from "../../src/worker.js";
import { env } from "node:process";
import { sql } from "drizzle-orm";
import { Cause, Effect, Exit, Layer, Option, Redacted, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  DirectDatabase,
  DatabaseQueryError,
  databaseBindingsLayer,
  directDatabaseLayer,
} from "../../src/database/database.js";
import {
  CredentialCryptography,
  credentialConfigurationLayer,
  credentialCryptographyLayer,
} from "../../src/identity/credentials.js";
import {
  GeneratedNames,
  generatedNamesLayer,
} from "../../src/identity/names.js";
import {
  AgentNameUnavailableError,
  identityRepositoryLayer,
} from "../../src/identity/repository.js";
import {
  Authentication,
  AuthenticationDeniedError,
  Registration,
  RegistrationInvalidError,
  RegistrationSuccess,
  NameGenerationExhaustedError,
  authenticationLayer,
  registrationLayer,
} from "../../src/identity/service.js";
const config = Schema.decodeUnknownSync(
  Schema.Struct({
    DATABASE_TEST_DIRECT_URL: Schema.Redacted(Schema.NonEmptyString),
    DATABASE_TEST_CACHED_URL: Schema.Redacted(Schema.NonEmptyString),
  }),
)(env);
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
const cryptoLayer = (current = "p2") =>
  credentialCryptographyLayer.pipe(
    Layer.provide(
      credentialConfigurationLayer({
        AUTH_CURRENT_PEPPER: current,
        AUTH_PEPPERS: JSON.stringify({
          p1: "01".repeat(32),
          p2: "02".repeat(32),
        }),
      }),
    ),
  );
const cryptoLive = cryptoLayer();
const dependencies = Layer.mergeAll(
  repository,
  cryptoLive,
  generatedNamesLayer.pipe(Layer.provide(cryptoLive)),
);
const services = Layer.merge(registrationLayer, authenticationLayer).pipe(
  Layer.provide(dependencies),
);
const run = <A, E>(
  effect: Effect.Effect<A, E, Registration | Authentication>,
) => Effect.runPromise(effect.pipe(Effect.provide(services)));
const register = (input: unknown) =>
  Effect.flatMap(Registration, (service) => service.register(input));
const authenticate = (key: Option.Option<Redacted.Redacted>) =>
  Effect.flatMap(Authentication, (service) => service.authenticate(key));
const name = () =>
  `Signup${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
const count = (value: string) =>
  Effect.runPromise(
    Effect.flatMap(DirectDatabase, (db) =>
      db.execute(
        () =>
          sql`SELECT count(*)::int AS n FROM agents WHERE canonical_name = ${value.toLowerCase()}`,
        Schema.Struct({ n: Schema.Int }),
      ),
    ).pipe(Effect.provide(direct)),
  );
const execute = (statement: ReturnType<typeof sql>) =>
  Effect.runPromise(
    Effect.flatMap(DirectDatabase, (db) =>
      db.execute(() => statement, Schema.Never),
    ).pipe(Effect.provide(direct)),
  );
const failure = <A, E>(result: Exit.Exit<A, E>) => {
  expect(Exit.isFailure(result)).toBe(true);
  return Exit.isFailure(result)
    ? Option.getOrThrow(Cause.failureOption(result.cause))
    : undefined;
};

describe("registration/authentication services in real PostgreSQL/workerd", () => {
  it("atomically persists only keyed material, preserves display casing and authenticates without exposing the key again", async () => {
    const requested = name();
    const issued = await run(register({ name: requested }));
    expect(issued.name).toBe(requested);
    const wire = await Effect.runPromise(
      Schema.encode(RegistrationSuccess)(issued),
    );
    expect(wire.api_key).toBe(Redacted.value(issued.api_key));
    expect(JSON.stringify(issued)).not.toContain(wire.api_key);
    const authenticated = await run(authenticate(Option.some(issued.api_key)));
    expect(authenticated).toEqual({ id: issued.id, name: requested });
    expect(Object.hasOwn(authenticated, "api_key")).toBe(false);
    const stored = await Effect.runPromise(
      Effect.flatMap(DirectDatabase, (db) =>
        db.execute(
          () =>
            sql`SELECT row_to_json(a)::text AS record FROM agents a WHERE id = ${issued.id}`,
          Schema.Struct({ record: Schema.String }),
        ),
      ).pipe(Effect.provide(direct)),
    );
    expect(JSON.stringify(stored)).not.toContain(wire.api_key);
    expect(stored[0]?.record).toContain('"pepper_version":"p2"');
    expect(stored[0]?.record).toContain('"key_digest":');
    const second = await run(register({}));
    expect(second.id).not.toBe(issued.id);
    expect(Redacted.value(second.api_key)).not.toBe(wire.api_key);
  });
  it("rejects missing, malformed, unknown and wrong-secret credentials without reflected key data", async () => {
    const issued = await run(register({}));
    const key = Redacted.value(issued.api_key);
    for (const supplied of [
      Option.none<Redacted.Redacted>(),
      Option.some(Redacted.make("invalid")),
      Option.some(
        Redacted.make(key.slice(0, 6) + "0".repeat(32) + key.slice(38)),
      ),
      Option.some(Redacted.make(key.slice(0, -64) + "0".repeat(64))),
    ]) {
      const result = await run(Effect.exit(authenticate(supplied)));
      expect(failure(result)).toBeInstanceOf(AuthenticationDeniedError);
      expect(JSON.stringify(result)).not.toContain(key);
    }
    expect(await run(authenticate(Option.some(issued.api_key)))).toEqual({
      id: issued.id,
      name: issued.name,
    });
  });
  it("uses authoritative canonical uniqueness under concurrent case-variant requests", async () => {
    const requested = name();
    const results = await Promise.all(
      [
        requested,
        requested.toLowerCase(),
        requested.toUpperCase(),
        requested,
      ].map((value) => run(Effect.exit(register({ name: value })))),
    );
    expect(results.filter(Exit.isSuccess)).toHaveLength(1);
    for (const result of results.filter(Exit.isFailure))
      expect(failure(result)).toBeInstanceOf(AgentNameUnavailableError);
    expect(await count(requested)).toEqual([{ n: 1 }]);
  });
  it("retries complete generated candidates and fails bounded exhaustion without partial identities", async () => {
    const taken = name();
    await run(register({ name: taken }));
    const fresh = name();
    let attempts = 0;
    const names = Layer.succeed(GeneratedNames, {
      next: Effect.sync(() => (++attempts < 3 ? taken : fresh)),
    });
    const layer = registrationLayer.pipe(
      Layer.provide(Layer.mergeAll(repository, cryptoLive, names)),
    );
    const result = await Effect.runPromise(
      register({}).pipe(Effect.provide(layer)),
    );
    expect(result.name).toBe(fresh);
    expect(attempts).toBe(3);
    expect(await count(taken)).toEqual([{ n: 1 }]);
    expect(await count(fresh)).toEqual([{ n: 1 }]);
    let exhausted = 0;
    const exhaustedNames = Layer.succeed(GeneratedNames, {
      next: Effect.sync(() => {
        exhausted++;
        return taken;
      }),
    });
    const exit = await Effect.runPromise(
      register({}).pipe(
        Effect.provide(
          registrationLayer.pipe(
            Layer.provide(
              Layer.mergeAll(repository, cryptoLive, exhaustedNames),
            ),
          ),
        ),
        Effect.exit,
      ),
    );
    expect(failure(exit)).toBeInstanceOf(NameGenerationExhaustedError);
    expect(exhausted).toBe(32);
    expect(await count(taken)).toEqual([{ n: 1 }]);
  });
  it("retries real indexed-key collisions only within a bound and rolls every reservation back", async () => {
    const original = await run(register({}));
    const candidate = name();
    let attempts = 0;
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const actual = yield* CredentialCryptography;
        const collision = Layer.succeed(CredentialCryptography, {
          ...actual,
          issue: Effect.sync(() => {
            attempts++;
            return {
              key: original.api_key,
              keyVersion: "af_v1" as const,
              lookupId: Redacted.value(original.api_key).slice(6, 38),
            };
          }),
        });
        return yield* register({ name: candidate }).pipe(
          Effect.provide(
            registrationLayer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  repository,
                  collision,
                  Layer.succeed(GeneratedNames, {
                    next: Effect.succeed("UnusedGeneratedName"),
                  }),
                ),
              ),
            ),
          ),
          Effect.exit,
        );
      }).pipe(Effect.provide(cryptoLive)),
    );
    expect(failure(exit)).toBeInstanceOf(DatabaseQueryError);
    expect(attempts).toBe(4);
    expect(await count(candidate)).toEqual([{ n: 0 }]);
    expect(JSON.stringify(exit)).not.toContain(
      Redacted.value(original.api_key),
    );
    expect((await run(register({ name: candidate }))).name).toBe(candidate);
  });
  it("rejects malformed/overlength/excess signup fields without reserving a name", async () => {
    for (const input of [
      { name: "a".repeat(40) },
      { name: "" },
      { name: "bad--name" },
      { name: "non_ascii_雪" },
      { name: true },
      { name: "a\n" },
      { name: name(), email: "not-supported" },
      { name: name(), api_key: "must-not-be-reflected" },
    ]) {
      const result = await run(Effect.exit(register(input)));
      expect(failure(result)).toBeInstanceOf(RegistrationInvalidError);
      expect(JSON.stringify(result)).not.toContain("must-not-be-reflected");
    }
    const boundary = "a".repeat(39);
    expect((await run(register({ name: boundary }))).name).toBe(boundary);
  });
  it("retains verification of older pepper versions after changing the issuance version", async () => {
    const oldCrypto = cryptoLayer("p1");
    const old = registrationLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          repository,
          oldCrypto,
          generatedNamesLayer.pipe(Layer.provide(oldCrypto)),
        ),
      ),
    );
    const issued = await Effect.runPromise(
      register({}).pipe(Effect.provide(old)),
    );
    expect(await run(authenticate(Option.some(issued.api_key)))).toEqual({
      id: issued.id,
      name: issued.name,
    });
  });
  it("rolls back a real SQL signup failure and leaves the requested name available", async () => {
    const candidate = `RollbackSignup${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
    await execute(
      sql`CREATE FUNCTION test_reject_signup() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN IF NEW.name LIKE 'RollbackSignup%' THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Synthetic signup failure'; END IF; RETURN NEW; END; $body$`,
    );
    await execute(
      sql`CREATE TRIGGER test_reject_signup BEFORE INSERT ON agents FOR EACH ROW EXECUTE FUNCTION test_reject_signup()`,
    );
    try {
      expect(
        failure(await run(Effect.exit(register({ name: candidate })))),
      ).toBeInstanceOf(DatabaseQueryError);
      expect(await count(candidate)).toEqual([{ n: 0 }]);
    } finally {
      await execute(sql`DROP TRIGGER test_reject_signup ON agents`);
      await execute(sql`DROP FUNCTION test_reject_signup()`);
    }
    expect((await run(register({ name: candidate }))).name).toBe(candidate);
  });
  it("executes actual GET and POST registration with identical contracts, header safety and one-time keys", async () => {
    const execution: WorkerExecutionContext = {
      waitUntil: () => undefined,
      passThroughOnException: () => undefined,
      props: {},
    };
    const bindings = {
      ENVIRONMENT: "local",
      AUTH_CURRENT_PEPPER: "p2",
      AUTH_PEPPERS: JSON.stringify({ p2: "02".repeat(32) }),
      HYPERDRIVE_DIRECT: {
        connectionString: Redacted.value(config.DATABASE_TEST_DIRECT_URL),
      },
      HYPERDRIVE_CACHED: {
        connectionString: Redacted.value(config.DATABASE_TEST_CACHED_URL),
      },
    };
    for (const method of ["GET", "POST"]) {
      const requested = name();
      const document = JSON.stringify({ name: requested });
      const request =
        method === "GET"
          ? new Request(
              "https://api.agentforum.test/v1/register?payload=" +
                encodeURIComponent(document),
            )
          : new Request("https://api.agentforum.test/v1/register", {
              method,
              headers: { "Content-Type": "application/json" },
              body: document,
            });
      const response = await worker.fetch(request, bindings, execution);
      expect(response.status).toBe(201);
      expect(response.headers.get("Cache-Control")).toBe("no-store, private");
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
      const decoded = await Effect.runPromise(
        Schema.decodeUnknown(Schema.parseJson(RegistrationSuccess))(
          await response.text(),
        ),
      );
      expect(decoded.name).toBe(requested);
      expect(await run(authenticate(Option.some(decoded.api_key)))).toEqual({
        id: decoded.id,
        name: requested,
      });
      const duplicate =
        method === "GET"
          ? new Request(request.url)
          : new Request(request.url, {
              method,
              headers: { "Content-Type": "application/json" },
              body: document,
            });
      const conflict = await worker.fetch(duplicate, bindings, execution);
      expect(conflict.status).toBe(409);
      expect(conflict.headers.get("Content-Type")).toBe(
        "application/problem+json",
      );
      expect(await conflict.text()).not.toContain(
        Redacted.value(decoded.api_key),
      );
    }
  });
  it("keeps actual HEAD/OPTIONS safe even without bindings and reports name limits without allocating", async () => {
    const execution: WorkerExecutionContext = {
      waitUntil: () => undefined,
      passThroughOnException: () => undefined,
      props: {},
    };
    for (const method of ["HEAD", "OPTIONS"]) {
      const response = await worker.fetch(
        new Request("https://api.agentforum.test/v1/register", { method }),
        undefined,
        execution,
      );
      expect(response.status).toBe(method === "HEAD" ? 200 : 204);
      expect(await response.text()).toBe("");
    }
    const bindings = { ENVIRONMENT: "local" };
    for (const method of ["GET", "POST"]) {
      const document = JSON.stringify({ name: "a".repeat(40) });
      const request =
        method === "GET"
          ? new Request(
              "https://api.agentforum.test/v1/register?payload=" +
                encodeURIComponent(document),
            )
          : new Request("https://api.agentforum.test/v1/register", {
              method,
              headers: { "Content-Type": "application/json" },
              body: document,
            });
      const response = await worker.fetch(request, bindings, execution);
      expect(response.status).toBe(400);
      const problem = Schema.decodeUnknownSync(
        Schema.Struct({
          limit: Schema.Literal(39),
          status: Schema.Literal(400),
          canonical: Schema.Literal("/v1/register"),
        }),
      )(await response.json());
      expect(problem.limit).toBe(39);
    }
  });
  it("preserves declared transport failures and Bearer challenges through the real outer normalizer", async () => {
    const execution: WorkerExecutionContext = {
      waitUntil: () => undefined,
      passThroughOnException: () => undefined,
      props: {},
    };
    const requests = [
      {
        request: new Request(
          "https://api.agentforum.test/v1/register?payload=%7B%7D&payload=%7B%7D",
        ),
        status: 400,
      },
      {
        request: new Request(
          "https://api.agentforum.test/v1/register?payload=%ff",
        ),
        status: 400,
      },
      {
        request: new Request("https://api.agentforum.test/v1/register", {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: "{}",
        }),
        status: 415,
      },
      {
        request: new Request("https://api.agentforum.test/v1/register", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "not-a-Bearer-secret",
          },
          body: "{}",
        }),
        status: 401,
      },
      {
        request: new Request(
          "https://api.agentforum.test/v1/register?payload=" +
            "x".repeat(14336),
        ),
        status: 413,
      },
      {
        request: new Request("https://api.agentforum.test/v1/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: " ".repeat(65537),
        }),
        status: 413,
      },
    ];
    for (const { request, status } of requests) {
      const response = await worker.fetch(
        request,
        { ENVIRONMENT: "local" },
        execution,
      );
      expect(response.status).toBe(status);
      expect(response.headers.get("Content-Type")).toBe(
        "application/problem+json",
      );
      if (status === 401)
        expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
      const text = await response.text();
      expect(text).not.toContain("not-a-Bearer-secret");
      if (status === 413) expect(text).toContain('"canonical":"/v1/register"');
    }
  });
});

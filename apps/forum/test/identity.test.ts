import { env } from "cloudflare:workers";
import { Effect, Layer, Option, Redacted, Schema } from "effect";
import { beforeAll, describe, expect, it } from "vitest";
import { makeDispatcher } from "../src/runtime/dispatch.js";
import { requestLayer, type Execution } from "../src/runtime/context.js";
import {
  ApiKey,
  makeCryptography,
  CredentialCryptography,
  unbiasedIndex,
} from "../src/identity/credentials.js";
import { GeneratedNames, generatedNamesLayer } from "../src/identity/names.js";
import {
  Authentication,
  authenticationLayer,
  registrationLayer,
} from "../src/identity/service.js";
import { Registration } from "../src/api/services.js";
import { RegistrationResult } from "../src/api/contracts.js";
import {
  ForumStore,
  makeForumStore,
  StorageFailure,
} from "../src/database/store.js";
import { migrate } from "./d1.js";

const origin = "https://identity.owner.workers.dev";
const execution: Execution = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
};
const app = makeDispatcher(() => Promise.resolve(new Response("read only")));
const cryptoService = makeCryptography();
const cryptoLayer = Layer.succeed(CredentialCryptography, cryptoService);
const context = requestLayer(env, execution, origin, crypto.randomUUID());
const request = (
  operation: string,
  value: unknown,
  method = "POST",
  headers: Record<string, string> = {},
) =>
  new Request(
    `${origin}/v1/${operation}` +
      (method === "GET"
        ? `?payload=${encodeURIComponent(JSON.stringify(value))}`
        : ""),
    {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      ...(method === "POST" ? { body: JSON.stringify(value) } : {}),
    },
  );
const signup = async (name?: string, method = "POST") => {
  const response = await app.fetch(
    request("register", name ? { name } : {}, method),
    env,
    execution,
  );
  expect(response.status).toBe(201);
  expect(response.headers.get("Cache-Control")).toBe("no-store, private");
  return Schema.decodeUnknownPromise(RegistrationResult)(await response.json());
};
const authenticate = (key: string, db = env.DB) =>
  Effect.flatMap(Authentication, (service) =>
    service.authenticate(Redacted.make(key)),
  ).pipe(
    Effect.provide(
      authenticationLayer.pipe(
        Layer.provide(
          Layer.merge(
            Layer.succeed(ForumStore, makeForumStore(db)),
            cryptoLayer,
          ),
        ),
        Layer.provide(context),
      ),
    ),
  );
beforeAll(async () => {
  await migrate();
  await migrate(env.ISOLATED_DB);
});
describe("native D1 registration and digest-only authentication", () => {
  it("registers equivalent GET/POST names with no application secret and preserves display casing", async () => {
    for (const method of ["GET", "POST"]) {
      const result = await signup(`Display${method}`, method);
      expect(result.name).toBe(`Display${method}`);
      expect(Schema.is(ApiKey)(result.apiKey)).toBe(true);
      expect(
        (await Effect.runPromise(authenticate(result.apiKey))).agentId,
      ).toBe(result.id);
    }
  });
  it("persists only complete-key SHA256 digest and nonsecret lookup; redeployment retains authentication", async () => {
    const result = await signup();
    const lookup = result.apiKey.split(".")[1];
    const row = await env.DB.prepare(
      "SELECT lookup_id,digest,agent_id FROM credentials WHERE lookup_id=?",
    )
      .bind(lookup)
      .first();
    expect(row).toEqual({
      lookup_id: lookup,
      digest: await Effect.runPromise(
        cryptoService.digest(Redacted.make(result.apiKey)),
      ),
      agent_id: result.id,
    });
    expect(JSON.stringify(row).includes(result.apiKey)).toBe(false);
    await migrate();
    expect((await Effect.runPromise(authenticate(result.apiKey))).agentId).toBe(
      result.id,
    );
  });
  it("keeps signup disposable and generates reviewed three-to-five word names", async () => {
    const first = await signup();
    const second = await signup();
    expect(first.id === second.id).toBe(false);
    expect(first.name === second.name).toBe(false);
    expect((first.name.match(/[A-Z]/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect((first.name.match(/[A-Z]/g) ?? []).length).toBeLessThanOrEqual(5);
  });
  it("enforces canonical name uniqueness under concurrent GET/POST without orphan credentials", async () => {
    const before = await env.DB.prepare(
      "SELECT count(*) AS n FROM credentials",
    ).first<number>("n");
    const responses = await Promise.all([
      app.fetch(
        request("register", { name: "ConcurrentName" }, "GET"),
        env,
        execution,
      ),
      app.fetch(
        request("register", { name: "concurrentname" }),
        env,
        execution,
      ),
    ]);
    expect(responses.map((value) => value.status).sort()).toEqual([201, 409]);
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM credentials").first("n"),
    ).toBe((before ?? 0) + 1);
  });
  it("rejects invalid names and reports the39-character limit before writing", async () => {
    for (const name of [
      "x".repeat(40),
      "-bad",
      "bad-",
      "bad--name",
      "Agent\n",
      "Agent\r",
      "Agent\u2028",
      "Agent\u2029",
      "two words",
      "é",
      "",
    ]) {
      const response = await app.fetch(
        request("register", { name }),
        env,
        execution,
      );
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("39");
    }
  });
  it("rejects other-installation keys, altered secrets and unsupported versions", async () => {
    const result = await signup();
    expect(
      await Effect.runPromise(
        Effect.isSuccess(authenticate(result.apiKey, env.ISOLATED_DB)),
      ),
    ).toBe(false);
    for (const key of [
      "",
      result.apiKey.slice(0, -1) + (result.apiKey.endsWith("0") ? "1" : "0"),
      result.apiKey.replace("af1.", "af2."),
    ])
      expect(await Effect.runPromise(Effect.isSuccess(authenticate(key)))).toBe(
        false,
      );
  });
  it("permits only HTTPS header authentication and leaves publication honest501 after verification", async () => {
    const result = await signup();
    for (const method of ["GET", "POST"]) {
      const valid = request("publish", { body: "not published" }, method, {
        Authorization: `Bearer ${result.apiKey}`,
      });
      expect((await app.fetch(valid, env, execution)).status).toBe(501);
      const missing = await app.fetch(
        request("publish", { body: "not published" }, method, {
          Cookie: `apiKey=${result.apiKey}`,
        }),
        env,
        execution,
      );
      expect(missing.status).toBe(401);
      expect(missing.headers.get("WWW-Authenticate")).toContain("Bearer");
      expect((await missing.text()).includes(result.apiKey)).toBe(false);
    }
    const insecure = request("publish", { body: "not published" }, "POST", {
      Authorization: `Bearer ${result.apiKey}`,
    });
    expect(
      (
        await app.fetch(
          new Request(
            insecure.url.replace(origin, "http://localhost"),
            insecure,
          ),
          env,
          execution,
        )
      ).status,
    ).toBe(401);
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM posts").first("n"),
    ).toBe(0);
  });
  it("safe methods allocate nothing and recovery endpoints do not exist", async () => {
    const before = await env.DB.prepare(
      "SELECT count(*) AS n FROM agents",
    ).first("n");
    for (const method of ["HEAD", "OPTIONS"])
      expect(
        (
          await app.fetch(
            new Request(origin + "/v1/register", { method }),
            env,
            execution,
          )
        ).status,
      ).toBe(204);
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM agents").first("n"),
    ).toBe(before);
    expect(
      (await app.fetch(new Request(origin + "/v1/recover"), env, execution))
        .status,
    ).toBe(404);
    expect(
      (await app.fetch(request("search", {}), env, execution)).status,
    ).toBe(501);
  });
  it("uses256-bit secret material and unbiased rejection sampling", async () => {
    expect(Option.isNone(unbiasedIndex(0xffffffff, 3))).toBe(true);
    expect(Option.getOrThrow(unbiasedIndex(5, 3))).toBe(2);
    const keys = new Set<string>();
    for (let n = 0; n < 32; n++) {
      const issued = await Effect.runPromise(cryptoService.issue);
      const key = Redacted.value(issued.key);
      expect(Schema.is(ApiKey)(key)).toBe(true);
      expect(key.split(".")[2]?.length).toBe(64);
      keys.add(key);
    }
    expect(keys.size).toBe(32);
  });
  it("does not replay ambiguous committed registration or retain its plaintext", async () => {
    let calls = 0;
    const real = makeForumStore(env.DB);
    const uncertain = {
      ...real,
      createIdentity: (input: Parameters<typeof real.createIdentity>[0]) =>
        real.createIdentity(input).pipe(
          Effect.flatMap(() => {
            calls++;
            return Effect.fail(new StorageFailure());
          }),
        ),
    };
    const program = Effect.flatMap(Registration, (service) =>
      service.register(Option.some("LostResponse")),
    ).pipe(
      Effect.provide(
        registrationLayer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(ForumStore, uncertain),
              cryptoLayer,
              generatedNamesLayer.pipe(Layer.provide(cryptoLayer)),
            ),
          ),
          Layer.provide(context),
        ),
      ),
    );
    expect(await Effect.runPromise(Effect.isSuccess(program))).toBe(false);
    expect(calls).toBe(1);
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM agents WHERE name='LostResponse'",
      ).first("n"),
    ).toBe(1);
  });
  it("bounds generated-name collisions with no partial identities", async () => {
    await signup("FixedGeneratedName");
    let attempts = 0;
    const names = Layer.succeed(GeneratedNames, {
      next: Effect.sync(() => {
        attempts++;
        return "FixedGeneratedName";
      }),
    });
    const program = Effect.flatMap(Registration, (service) =>
      service.register(Option.none()),
    ).pipe(
      Effect.provide(
        registrationLayer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(ForumStore, makeForumStore(env.DB)),
              cryptoLayer,
              names,
            ),
          ),
          Layer.provide(context),
        ),
      ),
    );
    expect(await Effect.runPromise(Effect.isSuccess(program))).toBe(false);
    expect(attempts).toBe(10);
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM agents WHERE name='FixedGeneratedName'",
      ).first("n"),
    ).toBe(1);
  });
});

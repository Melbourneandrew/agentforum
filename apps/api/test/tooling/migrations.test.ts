import { ownedProcess } from "../../scripts/owned-process.js";
import { SmokeEnvironment } from "../../scripts/database-smoke-program.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Cause, Effect, Exit, Option, Redacted, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  MigrationError,
  migrationOrigin,
  redactMigrationOutput,
} from "../../scripts/migrations.js";
import {
  ownedLocalDatabaseUrl,
  resetOwnedLocalDatabase,
} from "../../scripts/local-postgres.js";
const secret = "synthetic-origin-password";
const uri = `postgresql://migration:${secret}@origin.example.invalid/agentforum`;
describe("migration and reset safety", () => {
  it("requires dedicated Actions credentials and canonicalizes direct origin TLS/port", async () => {
    const target = Redacted.value(
      await Effect.runPromise(
        migrationOrigin({
          GITHUB_ACTIONS: "true",
          MIGRATION_DATABASE_URL: uri,
        }),
      ),
    );
    const url = new URL(target);
    expect(url.port).toBe("5432");
    expect(url.searchParams.get("sslmode")).toBe("verify-full");
  });
  it("never falls back to runtime bindings and rejects non-origin or non-Actions targets", async () => {
    for (const environment of [
      { GITHUB_ACTIONS: "true", HYPERDRIVE_DIRECT: { connectionString: uri } },
      { GITHUB_ACTIONS: "false", MIGRATION_DATABASE_URL: uri },
      {
        GITHUB_ACTIONS: "true",
        MIGRATION_DATABASE_URL: uri.replace(
          "origin.example.invalid",
          "origin.example.invalid:6543",
        ),
      },
      {
        GITHUB_ACTIONS: "true",
        MIGRATION_DATABASE_URL: uri.replace(
          "origin.example.invalid",
          "127.0.0.1:5432",
        ),
      },
      {
        GITHUB_ACTIONS: "true",
        MIGRATION_DATABASE_URL: uri.replace(
          "origin.example.invalid",
          "hyperdrive.local:5432",
        ),
      },
    ]) {
      const result = await Effect.runPromiseExit(migrationOrigin(environment));
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        expect(
          Option.exists(
            Cause.failureOption(result.cause),
            (error) =>
              error instanceof MigrationError && error.stage === "target",
          ),
        ).toBe(true);
        expect(Cause.pretty(result.cause)).not.toContain(secret);
      }
    }
  });
  it("redacts URLs and raw/encoded/JSON-escaped passwords without hiding unrelated warnings", () => {
    const password = 'synthetic-"p@ss';
    const url = new URL(uri);
    url.password = password;
    const output = `warning: retain this\n${url.toString()}\n${password}\n${url.password}\n${JSON.stringify(password).slice(1, -1)}`;
    const safe = redactMigrationOutput(
      output,
      Option.some(Redacted.make(url.toString())),
    );
    expect(safe).toContain("warning: retain this");
    for (const value of [
      password,
      url.password,
      JSON.stringify(password).slice(1, -1),
      url.toString(),
    ])
      expect(safe).not.toContain(value);
  });
  it("rejects URL/database-name reset inputs before any Docker target can be selected", async () => {
    for (const input of [
      uri,
      { url: uri, database: "postgres" },
      { name: "production", id: "0".repeat(64), port: 5432 },
    ]) {
      expect(
        Exit.isFailure(
          await Effect.runPromiseExit(resetOwnedLocalDatabase(input)),
        ),
      ).toBe(true);
      expect(
        Exit.isFailure(
          await Effect.runPromiseExit(ownedLocalDatabaseUrl(input)),
        ),
      ).toBe(true);
    }
  });
  it("fails the actual migration CLI without reflecting dedicated credentials", async () => {
    const result = await Effect.runPromiseExit(
      Effect.tryPromise({
        try: () =>
          promisify(execFile)("pnpm", ["exec", "tsx", "scripts/migrate.ts"], {
            env: {
              ...process.env,
              GITHUB_ACTIONS: "false",
              MIGRATION_DATABASE_URL: uri,
            },
            encoding: "utf8",
          }),
        catch: (error) =>
          Schema.decodeUnknownSync(
            Schema.Struct({
              stdout: Schema.String,
              stderr: Schema.String,
              code: Schema.Int,
            }),
          )(error),
      }),
    );
    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result)) {
      const failure = Cause.failureOption(result.cause);
      expect(Option.isSome(failure)).toBe(true);
      if (Option.isSome(failure)) {
        expect(failure.value.code).toBe(1);
        expect(failure.value.stdout + failure.value.stderr).not.toContain(
          secret,
        );
        expect(failure.value.stdout + failure.value.stderr).not.toContain(uri);
      }
    }
  });
});

it("refuses insecure or non-Actions smoke targets before network access", () => {
  const environment = {
    GITHUB_ACTIONS: "true",
    DATABASE_SMOKE_ORIGIN: "http://127.0.0.1:1",
    DATABASE_SMOKE_TOKEN: "synthetic",
    DATABASE_SMOKE_DATABASE: "synthetic",
  };
  expect(Schema.decodeUnknownEither(SmokeEnvironment)(environment)._tag).toBe(
    "Left",
  );
  expect(
    Schema.decodeUnknownEither(SmokeEnvironment)({
      ...environment,
      GITHUB_ACTIONS: "false",
      DATABASE_SMOKE_ORIGIN: "https://smoke.example.invalid",
    })._tag,
  ).toBe("Left");
});

for (const [script, args] of [
  ["database-smoke.ts", []],
  ["smoke-fixture.ts", ["prepare"]],
] as const) {
  it(`refuses actual ${script} outside Actions without leaking credentials`, async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const lease = yield* ownedProcess(
            "pnpm",
            ["exec", "tsx", `scripts/${script}`, ...args],
            {
              output: "capture",
              environment: {
                GITHUB_ACTIONS: "false",
                MIGRATION_DATABASE_URL: uri,
                DATABASE_SMOKE_ORIGIN: "https://smoke.example.invalid",
                DATABASE_SMOKE_TOKEN: secret,
                DATABASE_SMOKE_DATABASE: "synthetic",
                DATABASE_SMOKE_RUNTIME_ROLE: "postgres",
              },
            },
          );
          return yield* Effect.promise(() => lease.completion);
        }),
      ),
    );
    expect(result.code).toBe(1);
    expect(result.stdout + result.stderr).not.toContain(secret);
    expect(result.stdout + result.stderr).not.toContain(uri);
  });
}

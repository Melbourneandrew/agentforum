import { Effect, Exit, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  MigrationIdentity,
  ProductionEnvironment,
  ProductionPreflight,
  productionAccount,
  verifyProductionCredentials,
} from "../../scripts/production-preflight-program.js";

const environment = {
  GITHUB_ACTIONS: "true",
  GITHUB_REPOSITORY: "Melbourneandrew/agentforum",
  GITHUB_REF: "refs/heads/main",
  CLOUDFLARE_ACCOUNT_ID: productionAccount,
  CLOUDFLARE_API_TOKEN: "synthetic-cloudflare-secret",
  MIGRATION_DATABASE_URL:
    "postgresql://agentforum_migrator:synthetic-password@ep-misty-frog-bcjau72l.c-16.us-east-1.aws.neon.tech:5432/neondb?sslmode=verify-full",
};

describe("production credential trust boundary", () => {
  it.each([
    { GITHUB_ACTIONS: "false" },
    { GITHUB_REPOSITORY: "other/agentforum" },
    { GITHUB_REF: "refs/pull/20/merge" },
    { GITHUB_REF: "refs/heads/feature" },
    { CLOUDFLARE_ACCOUNT_ID: "different-account" },
    { CLOUDFLARE_API_TOKEN: "" },
    {
      MIGRATION_DATABASE_URL: environment.MIGRATION_DATABASE_URL.replace(
        "agentforum_migrator",
        "neondb_owner",
      ),
    },
    {
      MIGRATION_DATABASE_URL: environment.MIGRATION_DATABASE_URL.replace(
        "ep-misty-frog-bcjau72l.",
        "ep-misty-frog-bcjau72l-pooler.",
      ),
    },
    {
      MIGRATION_DATABASE_URL: environment.MIGRATION_DATABASE_URL.replace(
        "verify-full",
        "require",
      ),
    },
    {
      MIGRATION_DATABASE_URL: environment.MIGRATION_DATABASE_URL.replace(
        "/neondb?",
        "/different?",
      ),
    },
  ])(
    "rejects an unauthorized target before accessing providers: %j",
    async (change) => {
      let calls = 0;
      const layer = Layer.succeed(ProductionPreflight, {
        cloudflare: () => {
          calls += 1;
          return Effect.succeed("2026-11-22T07:59:59Z");
        },
        database: () => {
          calls += 1;
          return Effect.void;
        },
      });
      const result = await Effect.runPromiseExit(
        verifyProductionCredentials({ ...environment, ...change }).pipe(
          Effect.provide(layer),
        ),
      );
      expect(Exit.isFailure(result)).toBe(true);
      expect(calls).toBe(0);
      expect(String(result)).not.toContain("synthetic-password");
      expect(String(result)).not.toContain("synthetic-cloudflare-secret");
    },
  );

  it("keeps decoded credentials redacted", () => {
    const config = Schema.decodeUnknownSync(ProductionEnvironment)(environment);
    expect(JSON.stringify(config)).not.toContain("synthetic-password");
    expect(JSON.stringify(config)).not.toContain("synthetic-cloudflare-secret");
  });
});

it("refuses an owner or administratively elevated migration identity", () => {
  const identity = {
    database: "neondb",
    role: "agentforum_migrator",
    superuser: false,
    create_role: false,
    create_database: false,
    replication: false,
    bypass_rls: false,
    neon_admin: false,
    database_create: true,
    schema_create: true,
  };
  const accepts = Schema.is(MigrationIdentity);
  expect(accepts([identity])).toBe(true);
  for (const permission of [
    "superuser",
    "create_role",
    "create_database",
    "replication",
    "bypass_rls",
    "neon_admin",
  ]) {
    expect(accepts([{ ...identity, [permission]: true }])).toBe(false);
  }
  expect(accepts([{ ...identity, role: "neondb_owner" }])).toBe(false);
  expect(accepts([{ ...identity, database_create: false }])).toBe(false);
  expect(accepts([])).toBe(false);
});

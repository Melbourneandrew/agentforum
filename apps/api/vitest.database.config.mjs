import { env } from "node:process";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { Schema } from "effect";
import { defineConfig } from "vitest/config";

const parsed = Schema.decodeUnknownEither(
  Schema.Struct({
    DATABASE_TEST_DIRECT_URL: Schema.NonEmptyString,
    DATABASE_TEST_CACHED_URL: Schema.NonEmptyString,
    DATABASE_SMOKE_TOKEN: Schema.NonEmptyString,
    DATABASE_TEST_ORIGIN: Schema.String,
  }),
)(env);
if (parsed._tag === "Left")
  throw new Error("Database tests require the owned PostgreSQL harness");
const config = parsed.right;
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./test/fixtures/wrangler.database.json" },
      miniflare: {
        bindings: {
          HYPERDRIVE_DIRECT: {
            connectionString: config.DATABASE_TEST_DIRECT_URL,
          },
          HYPERDRIVE_CACHED: {
            connectionString: config.DATABASE_TEST_CACHED_URL,
          },
          DATABASE_SMOKE_TOKEN: config.DATABASE_SMOKE_TOKEN,
          DATABASE_TEST_ORIGIN: config.DATABASE_TEST_ORIGIN,
        },
      },
    }),
  ],
  test: { include: ["test/database/**/*.test.ts"], testTimeout: 15_000 },
});

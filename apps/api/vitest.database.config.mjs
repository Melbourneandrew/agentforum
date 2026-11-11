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
    DATABASE_TEST_SATURATED_URL: Schema.NonEmptyString,
    DATABASE_TEST_STATISTICS_URL: Schema.NonEmptyString,
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
          DATABASE_TEST_DIRECT_URL: config.DATABASE_TEST_DIRECT_URL,
          DATABASE_TEST_CACHED_URL: config.DATABASE_TEST_CACHED_URL,
          DATABASE_TEST_SATURATED_URL: config.DATABASE_TEST_SATURATED_URL,
          DATABASE_TEST_STATISTICS_URL: config.DATABASE_TEST_STATISTICS_URL,
        },
      },
    }),
  ],
  test: {
    include: ["test/database/**/*.test.ts"],
    testTimeout: 15_000,
    // Files share the physical publication counter and DDL fixtures. Isolate
    // those snapshots; explicit within-test concurrent publishers remain real.
    fileParallelism: false,
  },
});

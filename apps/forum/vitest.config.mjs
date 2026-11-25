import process from "node:process";
// Never import obsolete workspace .env files into the independent installation.
process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = "false";
import { readFileSync } from "node:fs";
import { URL, fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "../../wrangler.jsonc" },
      miniflare: { d1Databases: ["ISOLATED_DB"] },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    provide: {
      controlV1: readFileSync(
        fileURLToPath(
          new URL(
            "../../scripts/delivery/control-migrations/0001_release_control.sql",
            import.meta.url,
          ),
        ),
        "utf8",
      ),
      controlMigrations: await readD1Migrations(
        fileURLToPath(
          new URL("../../scripts/delivery/control-migrations", import.meta.url),
        ),
      ),
      migrations: await readD1Migrations(
        fileURLToPath(new URL("./migrations", import.meta.url)),
      ),
    },
  },
});

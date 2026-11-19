import process from "node:process";
// Never import obsolete workspace .env files into the independent installation.
process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = "false";
import { URL, fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
export default defineConfig({
  plugins: [
    cloudflareTest({ wrangler: { configPath: "../../wrangler.jsonc" } }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    provide: {
      migrations: await readD1Migrations(
        fileURLToPath(new URL("./migrations", import.meta.url)),
      ),
    },
  },
});

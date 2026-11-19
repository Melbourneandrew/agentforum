import process from "node:process";
// Never import obsolete workspace .env files into the independent installation.
process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = "false";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
export default defineConfig({
  plugins: [
    cloudflareTest({ wrangler: { configPath: "../../wrangler.jsonc" } }),
  ],
  test: { include: ["test/**/*.test.ts"] },
});

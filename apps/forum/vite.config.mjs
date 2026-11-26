import process from "node:process";
// Never import obsolete workspace .env files into the independent installation.
process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = "false";
import { cloudflare } from "@cloudflare/vite-plugin";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";

export default defineConfig({
  envDir: false,
  // Ordinary/local builds deliberately have no admitted deployment metadata.
  define: { __AGENTFORUM_DEPLOYMENT__: "null" },
  plugins: [
    cloudflare({
      configPath: "../../wrangler.jsonc",
      viteEnvironment: { name: "ssr" },
    }),
    reactRouter(),
  ],
});

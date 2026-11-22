import type { Bindings } from "../src/runtime/context.js";
// Native test-only independent installation. Production Wrangler still binds one DB.
declare module "@cloudflare/workers-types/index.ts" {
  namespace Cloudflare {
    interface Env {
      readonly ISOLATED_DB: Bindings["DB"];
    }
  }
}

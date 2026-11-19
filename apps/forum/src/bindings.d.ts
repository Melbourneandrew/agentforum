import type { Bindings } from "./runtime/context.js";
declare module "@cloudflare/workers-types/index.ts" {
  namespace Cloudflare {
    interface Env {
      readonly DB: Bindings["DB"];
      readonly ASSETS: Bindings["ASSETS"];
      readonly CANONICAL_ORIGIN?: string;
    }
  }
}

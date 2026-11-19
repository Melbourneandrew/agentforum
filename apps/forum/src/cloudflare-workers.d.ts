// Forward the real SDK namespace, without duplicate ambient DOM declarations.
declare module "cloudflare:workers" {
  import { CloudflareWorkersModule } from "@cloudflare/workers-types/index.ts";
  export = CloudflareWorkersModule;
}

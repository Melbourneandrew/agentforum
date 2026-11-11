// The SDK's importable index.ts exposes this exact native-module namespace,
// without installing duplicate global DOM declarations. Forward it unchanged;
// no local API signatures, fake implementation or ambient any is introduced.
declare module "cloudflare:workers" {
  import { CloudflareWorkersModule } from "@cloudflare/workers-types/index.ts";
  export = CloudflareWorkersModule;
}

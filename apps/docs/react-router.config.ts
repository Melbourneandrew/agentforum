import type { Config } from "@react-router/dev/config";
export default {
  ssr: false,
  prerender: ["/", "/docs/overview", "/docs/runtime", "/docs/contract"],
} satisfies Config;

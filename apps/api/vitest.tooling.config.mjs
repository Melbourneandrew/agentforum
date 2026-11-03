import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["test/tooling/**/*.test.ts"], environment: "node" },
});

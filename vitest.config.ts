import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["scripts/**/*.test.ts"],
    environment: "node",
    // Integration probes spawn real tools and temporarily add project inputs.
    // Serial files avoid concurrent project mutation and cold typed-lint contention.
    fileParallelism: false,
    testTimeout: 15_000,
  },
});

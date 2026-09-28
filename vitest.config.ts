import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: ".",
    include: ["tests/**/*.test.ts"],
    globals: true,
    restoreMocks: true,
    env: {
      BLIKO_E2E_DATA_DIR: "/tmp/bliko-meta-ads-mcp-tests",
    },
  },
});

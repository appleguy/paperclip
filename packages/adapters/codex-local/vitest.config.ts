import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./src/server/test-setup-rc-guard.ts"],
  },
});

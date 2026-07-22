import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "client",
    environment: "happy-dom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.ts"],
  },
});

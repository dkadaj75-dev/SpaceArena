import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "server",
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Use worker_threads (not forked processes): @colyseus/core lazy-loads
    // @pm2/io, whose IPC transport calls process.send() with objects when a
    // process IPC channel exists (vitest's default "forks" pool), corrupting
    // vitest's own IPC. Worker threads have no process.send, so it stays inert.
    pool: "threads",
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});

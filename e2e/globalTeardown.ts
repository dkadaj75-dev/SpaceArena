/**
 * Playwright's Windows webServer reaper cannot signal the npm→tsx child tree.
 * Ask the environment-gated E2E server to shut itself down; a reused developer
 * server has no such route, returns 404, and remains untouched.
 */
export default async function globalTeardown(): Promise<void> {
  try {
    await fetch("http://localhost:2567/__e2e/shutdown", {
      method: "POST",
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // The server may already be gone after an early boot/test failure.
  }
}

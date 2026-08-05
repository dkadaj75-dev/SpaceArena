import { mkdirSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end smoke test config (ROADMAP §11 6.1).
 *
 * Playwright brings up BOTH halves of the app and tears them down again:
 *   1. the game server (Colyseus + Express REST + SQLite) on :2567, and
 *   2. the Vite dev client on :5173 — pinned, because the server's dev CORS
 *      allowlist is the regex `^https?://[^/]+:5173$` (see server/src/httpApp.ts),
 *      so any other port silently breaks every `/api/*` call from the page.
 *
 * The client derives the game-server origin from `location.hostname` + 2567
 * (client/src/core/serverConfig.ts), so `baseURL` only names the Vite origin.
 */

const CI = !!process.env["CI"];

/**
 * Playwright re-evaluates this file inside every worker process. Only the
 * runner process owns the servers and the throwaway database, so destructive
 * housekeeping is gated on "am I the runner?" — otherwise a worker could delete
 * the DB file the running server currently holds open.
 */
const IS_RUNNER = process.env["TEST_WORKER_INDEX"] === undefined;

/** Throwaway SQLite database, one file per run — never the dev `data/` DB. */
const DB_DIR = path.join(os.tmpdir(), "space-arena-e2e");
const DB_PATH = path.join(DB_DIR, `e2e-${Date.now()}.db`);

function prepareThrowawayDb(): void {
  mkdirSync(DB_DIR, { recursive: true });
  if (!IS_RUNNER) return;
  for (const entry of readdirSync(DB_DIR)) {
    if (!/\.db(-wal|-shm)?$/.test(entry)) continue;
    try {
      rmSync(path.join(DB_DIR, entry), { force: true });
    } catch {
      // Still held open by another run's server (Windows locks open files).
      // Harmless: this run writes to its own uniquely-named file.
    }
  }
}

prepareThrowawayDb();

export default defineConfig({
  testDir: "./e2e",
  globalTeardown: "./e2e/globalTeardown.ts",
  // The two servers and the SQLite DB behind them are shared state: one worker,
  // no `.only` sneaking into CI, one retry there for genuine flake.
  workers: 1,
  fullyParallel: false,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [["list"], ["html", { open: "never" }]],

  // The @hudshot rig spec is a design tool, not a test: keep it out of default runs.
  grepInvert: /@hudshot/,

  use: {
    baseURL: "http://localhost:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },

  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          // Sandboxed CI/agent containers ship a system Chromium instead of
          // the version-pinned headless shell; point PW_CHROMIUM_PATH at it.
          executablePath: process.env.PW_CHROMIUM_PATH || undefined,
          // The client boots Babylon with `new Engine(canvas, true)` (WebGL2).
          // Headless Chromium has no GPU, so force the ANGLE/SwiftShader
          // software rasterizer — without this the engine never initializes and
          // nothing downstream of `bootstrap()` renders.
          args: [
            "--use-gl=angle",
            "--use-angle=swiftshader",
            "--enable-unsafe-swiftshader",
            "--disable-gpu-sandbox",
          ],
        },
      },
    },
  ],

  webServer: [
    {
      // `start`, not `dev`: no tsx watcher to leak between runs.
      command: "npm run start -w server",
      url: "http://localhost:2567/health",
      env: {
        PORT: "2567",
        // NOT "production": the dev-login route and the Colyseus monitor are
        // dev-gated, and the client's DEV build expects them to exist.
        NODE_ENV: "development",
        // Isolation: a fresh per-run SQLite file under the OS temp dir.
        // better-sqlite3 creates it and runs migrations at boot.
        SPACE_ARENA_DB: DB_PATH,
        SPACE_ARENA_E2E_SHUTDOWN: "1",
      },
      reuseExistingServer: !CI,
      // First boot compiles TS through tsx and runs the SQLite migrations.
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      // Port is load-bearing (server CORS allowlist) — fail loudly rather than
      // let Vite silently pick 5174.
      command: "npm run dev -w client -- --port 5173 --strictPort",
      url: "http://localhost:5173",
      reuseExistingServer: !CI,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});

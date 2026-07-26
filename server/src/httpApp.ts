import express, { type Express } from "express";
import cors from "cors";
import { PROTOCOL_VERSION, SIM_TICK_RATE } from "@space-arena/shared";
import { createAuthRouter } from "./auth/routes.js";
import { createFittingsRouter } from "./api/fittings.js";
import { createShipsRouter } from "./api/ships.js";
import { createModulesRouter } from "./api/modules.js";
import { createConfigsRouter } from "./api/configs.js";
import { createTelemetryRouter } from "./api/telemetry.js";
import { createAdminContentRouter } from "./api/adminContent.js";
import { createRateLimiter } from "./api/rateLimit.js";
import { getPackStore } from "./content/packStore.js";
import { getEnv } from "./env.js";
import { mountClient, mountContent } from "./staticSite.js";
import { createMatchmakingRouter } from "./matchmaking/routes.js";
import type { MatchmakingQueue } from "./matchmaking/MatchmakingQueue.js";

/** Max JSON body size accepted by the API (3.2/3.7 payload cap). */
export const JSON_BODY_LIMIT = "64kb";

export interface HttpAppOptions {
  /**
   * Explicit CORS allowlist. `null` selects the permissive dev rule (any origin
   * on port 5173); omit entirely to take whatever `CORS_ORIGIN` resolved to.
   */
  corsOrigins?: readonly string[] | null;
  /** Absolute path to the content pack to serve at `/content/*`. Omit to serve none. */
  contentDir?: string | null;
  /** Absolute path to a built client (`client/dist`) to serve. Omit to serve none. */
  clientDir?: string | null;
  matchmaking?: MatchmakingQueue;
}

/**
 * Build the Express app with health, auth, and the authenticated REST API.
 * Kept separate from index.ts so tests can mount it with supertest without the
 * Colyseus/WebSocket transport.
 *
 * Static serving is opt-in via {@link HttpAppOptions}: index.ts passes the
 * resolved env paths in production, unit tests pass nothing and get the bare API
 * (so a 404 stays a 404 rather than becoming the SPA shell).
 */
export function createHttpApp(options: HttpAppOptions = {}): Express {
  const app = express();

  // CORS. The allowlist comes from CORS_ORIGIN (comma list), validated in env.ts:
  //   - a list  → exactly those origins (production)
  //   - []      → same-origin only; every cross-origin browser call is refused
  //   - null    → dev rule: any origin on the Vite port, so phones on the LAN
  //               (`npm run dev -- --host`, e.g. http://10.x.x.x:5173) can reach
  //               the API without configuration.
  const allowlist = options.corsOrigins !== undefined ? options.corsOrigins : getEnv().corsOrigins;
  const corsOrigin: cors.CorsOptions["origin"] =
    allowlist === null
      ? (origin, cb) => {
          cb(null, !origin || /^https?:\/\/[^/]+:5173$/.test(origin));
        }
      : [...allowlist];
  app.use(cors({ origin: corsOrigin, credentials: true }));

  // Admin content-pack API (§11 6.7). Mounted BEFORE the global 64 kb JSON
  // parser on purpose: a content pack is ~120 kb and needs its own, much larger
  // cap. body-parser skips a request that an earlier parser already consumed, so
  // registration order is what keeps the two limits from fighting.
  app.use("/api/admin/content", createAdminContentRouter());

  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  app.get("/health", (_req, res) => {
    // The live pack's identity rides along so an operator can verify a
    // deploy-free content update landed (§11 6.7) with a single unauthenticated
    // GET. Best-effort: health must stay up even if the pack directory is unreadable.
    void getPackStore()
      .packInfo()
      .then(
        (pack) => res.json({ status: "ok", protocolVersion: PROTOCOL_VERSION, tickRate: SIM_TICK_RATE, contentPack: pack }),
        () => res.json({ status: "ok", protocolVersion: PROTOCOL_VERSION, tickRate: SIM_TICK_RATE, contentPack: null }),
      );
  });

  // Auth endpoints (own rate limiter, slightly stricter to blunt credential stuffing).
  app.use("/api/auth", createRateLimiter(), createAuthRouter());

  // Authenticated game API, all behind the per-IP token bucket.
  const apiLimiter = createRateLimiter();
  app.use("/api/fittings", apiLimiter, createFittingsRouter());
  app.use("/api/ships", apiLimiter, createShipsRouter());
  app.use("/api/modules", apiLimiter, createModulesRouter());
  app.use("/api/configs", apiLimiter, createConfigsRouter());
  if (options.matchmaking) app.use("/api/matchmaking", apiLimiter, createMatchmakingRouter(options.matchmaking));
  // Anonymous, unauthenticated, but on the same per-IP bucket as everything
  // else (ROADMAP §11 6.8) — "no login required" must not mean "no limit".
  app.use("/api/telemetry", apiLimiter, createTelemetryRouter());

  // Static serving last: the content pack and the client build are the only
  // things allowed to answer a URL the API did not claim, and the SPA fallback
  // inside mountClient() is the true catch-all.
  if (options.contentDir) mountContent(app, options.contentDir);
  if (options.clientDir) mountClient(app, options.clientDir);

  return app;
}

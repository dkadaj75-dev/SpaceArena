import express, { type Express } from "express";
import cors from "cors";
import { PROTOCOL_VERSION, SIM_TICK_RATE } from "@space-arena/shared";
import { createAuthRouter } from "./auth/routes.js";
import { createFittingsRouter } from "./api/fittings.js";
import { createShipsRouter } from "./api/ships.js";
import { createModulesRouter } from "./api/modules.js";
import { createConfigsRouter } from "./api/configs.js";
import { createRateLimiter } from "./api/rateLimit.js";

/** Max JSON body size accepted by the API (3.2/3.7 payload cap). */
export const JSON_BODY_LIMIT = "64kb";

/**
 * Build the Express app with health, auth, and the authenticated REST API.
 * Kept separate from index.ts so tests can mount it with supertest without the
 * Colyseus/WebSocket transport.
 */
export function createHttpApp(): Express {
  const app = express();

  // CORS: allow the Vite dev origin(s). Configurable via CORS_ORIGIN (comma list).
  // Without CORS_ORIGIN (dev), any origin on the Vite port is allowed so
  // phones on the LAN (`npm run dev -- --host`, e.g. http://10.x.x.x:5173)
  // can reach the API — production deployments always set CORS_ORIGIN.
  const originEnv = process.env.CORS_ORIGIN;
  const corsOrigin: cors.CorsOptions["origin"] = originEnv
    ? originEnv.split(",").map((s) => s.trim())
    : (origin, cb) => {
        cb(null, !origin || /^https?:\/\/[^/]+:5173$/.test(origin));
      };
  app.use(cors({ origin: corsOrigin, credentials: true }));

  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", protocolVersion: PROTOCOL_VERSION, tickRate: SIM_TICK_RATE });
  });

  // Auth endpoints (own rate limiter, slightly stricter to blunt credential stuffing).
  app.use("/api/auth", createRateLimiter(), createAuthRouter());

  // Authenticated game API, all behind the per-IP token bucket.
  const apiLimiter = createRateLimiter();
  app.use("/api/fittings", apiLimiter, createFittingsRouter());
  app.use("/api/ships", apiLimiter, createShipsRouter());
  app.use("/api/modules", apiLimiter, createModulesRouter());
  app.use("/api/configs", apiLimiter, createConfigsRouter());

  return app;
}

import { randomUUID } from "node:crypto";
import { Router } from "express";
import { clientMetricBodySchema, createLogger } from "@space-arena/shared";
import { clientMetricsRepo } from "../db/repos.js";
import { parseBody, sendError } from "./http.js";

const log = createLogger("TelemetryApi");

/**
 * Per-session report cap and the window it applies over. A match lasts tens of
 * seconds at minimum, so a genuine client cannot exceed ~120 reports/h; 240
 * leaves generous headroom for a fast practice grind while still stopping a
 * looping or hostile client from single-handedly reshaping a bucket histogram.
 *
 * This is deliberately a *second* limit on top of the shared per-IP token
 * bucket: the IP limiter blunts bursts, this one blunts a slow steady trickle
 * from one session, and neither alone covers the other's case.
 */
export const MAX_REPORTS_PER_SESSION = 240;
export const SESSION_WINDOW_MS = 60 * 60 * 1000;

/**
 * `POST /api/telemetry/client` — one anonymous per-match client report
 * (ROADMAP §11 6.8).
 *
 * Unauthenticated by design: the payload contains no user id and gains nothing
 * from being tied to one, and requiring a token would silently drop reports from
 * exactly the sessions most worth measuring (offline practice, guests bouncing
 * off a slow device). It shares the same per-IP rate limiter as the rest of
 * `/api/*`.
 *
 * Answers `204 No Content` — the client fires and forgets, so there is nothing
 * useful to send back and no reason to make it parse a body.
 */
export function createTelemetryRouter(): Router {
  const router = Router();

  router.post("/client", (req, res) => {
    const body = parseBody(res, clientMetricBodySchema, req.body);
    if (!body) return;

    const now = Date.now();
    const recent = clientMetricsRepo.countForSession(body.sessionHash, now - SESSION_WINDOW_MS);
    if (recent >= MAX_REPORTS_PER_SESSION) {
      log.warn("client telemetry session cap reached", { reports: recent });
      sendError(res, 429, "rate-limited", "too many reports for this session");
      return;
    }

    clientMetricsRepo.create({
      id: randomUUID(),
      session_hash: body.sessionHash,
      fps_bucket: body.fpsBucket,
      device_class: body.deviceClass,
      quality_tier: body.qualityTier,
      created_at: now,
    });

    res.status(204).end();
  });

  return router;
}

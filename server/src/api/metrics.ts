import { Router } from "express";
import { getMetrics, histogramAvg, histogramQuantile } from "../telemetry/metrics.js";

/**
 * `GET /metrics` — a live JSON view of the metrics registry (ROADMAP §11 6.6).
 *
 * This is what the load-test harness polls. It runs the server in a **separate
 * process** on purpose: 20 rooms' worth of simulated clients each hold a decoded
 * schema state, and folding that into the same process being measured would make
 * the RSS curve meaningless. An HTTP read is the cheapest honest way across that
 * boundary.
 *
 * Counters are cumulative — see telemetry/metrics.ts — so the poller derives
 * windows by diffing consecutive responses.
 *
 * Mounted only where `env.devTools` is on (dev, or production with
 * `COLYSEUS_MONITOR=1`), alongside `/monitor`. The payload holds no user data —
 * room ids, tick timings, byte counts and process memory — but it does describe
 * server load, so it belongs behind the admin auth that §11 6.4 puts in front of
 * `/monitor`.
 */
export function createMetricsRouter(): Router {
  const router = Router();

  router.get("/", (req, res) => {
    // `?gc=1` collects before sampling, so the teardown audit compares a settled
    // heap against the baseline instead of whatever V8 has not got round to
    // freeing yet. A no-op unless the process was started with `--expose-gc`,
    // which only the load-test harness does — production never has `global.gc`.
    if (req.query.gc === "1") globalThis.gc?.();
    const snapshot = getMetrics().snapshot();
    res.json({
      ...snapshot,
      rooms: snapshot.rooms.map((room) => ({
        ...room,
        tickAvgMs: histogramAvg(room.tick),
        tickP95Ms: histogramQuantile(room.tick, 0.95),
      })),
      tickAvgMs: histogramAvg(snapshot.tick),
      tickP95Ms: histogramQuantile(snapshot.tick, 0.95),
    });
  });

  return router;
}

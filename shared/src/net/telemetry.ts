import { z } from "zod";
import { QUALITY_TIERS } from "../schemas/quality.js";

/**
 * Telemetry contracts shared by client and server (ROADMAP §11 6.8).
 *
 * Design constraint: **the payload must not identify anybody.** There is no user
 * id, no guest token, no IP-derived field and no persisted identifier anywhere in
 * this module. The only correlation handle is {@link sessionHashSchema} — 128
 * random bits minted once per page load, held in memory, never written to
 * storage and never linked to an account. It exists so two reports from the same
 * boot can be recognised as one device-session (and so a stuck client cannot
 * inflate a bucket unnoticed); it is worthless the moment the tab closes.
 *
 * Everything else is a coarse bucket on purpose: an FPS *band* rather than a
 * number, "mobile"/"desktop" rather than a user-agent string. That is enough to
 * answer the two questions the roadmap asks of client telemetry — "is anyone
 * below 30 FPS?" and "on what class of device?" — while being far too coarse to
 * fingerprint a visitor.
 */

// ---------------------------------------------------------------------------
// FPS buckets
// ---------------------------------------------------------------------------

/**
 * Average-FPS bands, ascending. Chosen around the roadmap's two thresholds:
 * 30 FPS is the mobile exit criterion (§10 exit: "≥ 30 FPS on mid-range phone")
 * and 60 FPS is the desktop target, so the interesting boundaries are 30 and 60
 * with one band either side of each.
 */
export const FPS_BUCKETS = ["<20", "20-30", "30-45", "45-60", "60+"] as const;
export type FpsBucket = (typeof FPS_BUCKETS)[number];

/**
 * Inclusive lower bound of each band, descending. This table *is* the definition
 * of the buckets — the strings above are only labels for it.
 */
const FPS_BUCKET_FLOORS: readonly (readonly [number, FpsBucket])[] = [
  [60, "60+"],
  [45, "45-60"],
  [30, "30-45"],
  [20, "20-30"],
];

/**
 * Band an average FPS reading. Ranges are half-open and ascending:
 * `[0,20) → "<20"`, `[20,30) → "20-30"`, `[30,45) → "30-45"`,
 * `[45,60) → "45-60"`, `[60,∞) → "60+"`.
 *
 * Total by construction: a non-finite or negative reading (a sampler that never
 * saw a frame, a division by zero) lands in the pessimistic `"<20"` bucket
 * rather than throwing. Callers must still refuse to *report* a match in which
 * no frame was sampled — see `TelemetryClient.endMatch` — or the histogram fills
 * with phantom slow sessions.
 */
export function bucketFps(fps: number): FpsBucket {
  if (!Number.isFinite(fps)) return "<20";
  for (const [floor, bucket] of FPS_BUCKET_FLOORS) {
    if (fps >= floor) return bucket;
  }
  return "<20";
}

// ---------------------------------------------------------------------------
// Device class
// ---------------------------------------------------------------------------

/**
 * Device class, from the UA *hint* (`navigator.userAgentData.mobile`) with a
 * UA-string fallback — never from screen size, which changes with a window
 * resize. Two values only: the roadmap wants "does mobile keep up?", not a
 * device catalogue.
 */
export const DEVICE_CLASSES = ["mobile", "desktop"] as const;
export type DeviceClass = (typeof DEVICE_CLASSES)[number];

/** Device class implied by the client's quality device probe. */
export function deviceClassOf(probe: { mobile: boolean }): DeviceClass {
  return probe.mobile ? "mobile" : "desktop";
}

// ---------------------------------------------------------------------------
// POST /api/telemetry/client
// ---------------------------------------------------------------------------

/**
 * Per-boot random correlation handle: 32–64 lowercase hex characters
 * (128–256 bits). Deliberately *not* a uuid — a uuid's version/variant nibbles
 * would let a reader tell how it was generated, and the shape carries an
 * expectation of durability this value must never have.
 */
export const sessionHashSchema = z
  .string()
  .regex(/^[0-9a-f]{32,64}$/, "sessionHash must be 32-64 lowercase hex characters");

/**
 * One anonymous client report, sent once at the end of a match (offline or
 * online). Strict: an unknown key is a rejected body, so a future client that
 * starts attaching a user id cannot quietly begin storing one.
 */
export const clientMetricBodySchema = z.strictObject({
  sessionHash: sessionHashSchema,
  fpsBucket: z.enum(FPS_BUCKETS),
  deviceClass: z.enum(DEVICE_CLASSES),
  qualityTier: z.enum(QUALITY_TIERS),
});

export type ClientMetricBody = z.infer<typeof clientMetricBodySchema>;

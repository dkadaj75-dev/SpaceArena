import type { TuningConfig } from "../schemas/index.js";

/** Fallback for `tuning.pitchRateMult` (BUBBLE.md §A). */
export const DEFAULT_PITCH_RATE_MULT = 0.8;
/**
 * Defensive runtime ceiling for pitch tuning. Schemas reject values at or
 * beyond vertical, but callers may construct typed configs without parsing.
 */
export const MAX_SAFE_PITCH_RAD = Math.PI / 2 - 1e-6;

/** Fallback for `tuning.matchCountdownSec` (the 3-2-1 start). */
export const DEFAULT_MATCH_COUNTDOWN_SEC = 3;

/**
 * Whether the per-module weapon heat system is active. This is deliberately
 * opt-in: packs that predate the kill switch, and the shipped pack, run with
 * heat disabled unless they explicitly set `featureFlags.heatSystem` to true.
 */
export function heatSystemEnabled(tuning: TuningConfig): boolean {
  return tuning.featureFlags?.heatSystem === true;
}

/**
 * `tuning.matchCountdownSec`, defaulted and made safe. A non-finite or negative
 * authored value degrades to "no countdown" rather than to a match that can
 * never start — the sim would otherwise sit frozen forever on a NaN comparison.
 */
export function matchCountdownSecOf(tuning: TuningConfig): number {
  const authored = tuning.matchCountdownSec;
  if (authored === undefined || !Number.isFinite(authored) || authored < 0) {
    return authored === undefined ? DEFAULT_MATCH_COUNTDOWN_SEC : 0;
  }
  return authored;
}

/**
 * The two pitch knobs, defaulted once. Both the sim (NavigationSystem) and the
 * client predictor build their {@link import("./steering.js").FlightParams} from
 * here, so a tuning pack that omits either cannot make the mirrors disagree.
 *
 * `maxPitchRad` is `null` when the pack does not author it, and null means FREE
 * PITCH: the nose runs the full circle and the ship loops (BUBBLE.md §A as
 * amended). That is the shipped behaviour — the owner asked for vertical
 * steering that continues the way left/right does — so "absent" has to be the
 * free case, not a substituted 1.4. Authored, the value is the old hard clamp,
 * kept as a legacy knob for content packs that want a flier which cannot invert;
 * it is still floored above zero and held short of vertical, because a clamp AT
 * vertical is the one value that would let a "clamped" hull sit exactly on the
 * pole where its heading stops meaning anything.
 */
export function pitchTuningOf(tuning: TuningConfig): { pitchRateMult: number; maxPitchRad: number | null } {
  const authored = tuning.maxPitchRad;
  const clamp =
    authored === undefined || Number.isNaN(authored)
      ? null
      : Math.min(Math.max(authored, Number.EPSILON), MAX_SAFE_PITCH_RAD);
  return {
    pitchRateMult: tuning.pitchRateMult ?? DEFAULT_PITCH_RATE_MULT,
    maxPitchRad: clamp,
  };
}

import type { TuningConfig } from "../schemas/index.js";

/** Fallback for `tuning.pitchRateMult` (BUBBLE.md §A). */
export const DEFAULT_PITCH_RATE_MULT = 0.8;
/** Fallback for `tuning.maxPitchRad` (~80°, BUBBLE.md §A). */
export const DEFAULT_MAX_PITCH_RAD = 1.4;
/**
 * Defensive runtime ceiling for pitch tuning. Schemas reject values at or
 * beyond vertical, but callers may construct typed configs without parsing.
 */
export const MAX_SAFE_PITCH_RAD = Math.PI / 2 - 1e-6;

/**
 * The two pitch knobs, defaulted once. Both the sim (NavigationSystem) and the
 * client predictor build their {@link import("./steering.js").FlightParams} from
 * here, so a tuning pack that omits either cannot make the mirrors disagree.
 */
export function pitchTuningOf(tuning: TuningConfig): { pitchRateMult: number; maxPitchRad: number } {
  const authoredMaxPitch =
    tuning.maxPitchRad === undefined || Number.isNaN(tuning.maxPitchRad)
      ? DEFAULT_MAX_PITCH_RAD
      : tuning.maxPitchRad;
  return {
    pitchRateMult: tuning.pitchRateMult ?? DEFAULT_PITCH_RATE_MULT,
    maxPitchRad: Math.min(Math.max(authoredMaxPitch, Number.EPSILON), MAX_SAFE_PITCH_RAD),
  };
}

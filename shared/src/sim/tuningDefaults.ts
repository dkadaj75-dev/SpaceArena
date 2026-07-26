import type { TuningConfig } from "../schemas/index.js";

/** Fallback for `tuning.pitchRateMult` (BUBBLE.md §A). */
export const DEFAULT_PITCH_RATE_MULT = 0.8;
/** Fallback for `tuning.maxPitchRad` (~80°, BUBBLE.md §A). */
export const DEFAULT_MAX_PITCH_RAD = 1.4;

/**
 * The two pitch knobs, defaulted once. Both the sim (NavigationSystem) and the
 * client predictor build their {@link import("./steering.js").FlightParams} from
 * here, so a tuning pack that omits either cannot make the mirrors disagree.
 */
export function pitchTuningOf(tuning: TuningConfig): { pitchRateMult: number; maxPitchRad: number } {
  return {
    pitchRateMult: tuning.pitchRateMult ?? DEFAULT_PITCH_RATE_MULT,
    maxPitchRad: tuning.maxPitchRad ?? DEFAULT_MAX_PITCH_RAD,
  };
}

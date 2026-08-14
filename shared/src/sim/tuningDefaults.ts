import type { DamageType } from "../schemas/common.js";
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

/**
 * A damage type's shield/hull behaviour, fully resolved — no optionals left for
 * the damage pipeline to think about.
 */
export interface ResolvedDamageTypeProfile {
  /**
   * Share of the hit a working shield tries to soak, or `null` for "no
   * type rule" — which means LEGACY behaviour: the shield module's own
   * `mitigation.damageReduction` decides, exactly as it did before the
   * damage-type triangle existed.
   */
  shieldAbsorb: number | null;
  /** Multiplier on everything that reaches hull, before the hull's own resist. */
  hullMult: number;
}

/**
 * The shipped damage-type triangle, and the reason it is shaped this way:
 * energy weapons are shield-breakers that barely scratch plating, kinetic
 * weapons sail through shields and hit hull for full. A hull with no shield up
 * therefore fears kinetic; a hull behind a healthy shield fears energy far less
 * than the raw DPS number suggests.
 *
 * These are FALLBACKS. The shipped pack authors the same numbers explicitly in
 * `content/tuning/default.json`; a pack that omits `damageTypes` lands here.
 */
export const DEFAULT_DAMAGE_TYPE_PROFILES: Readonly<Record<DamageType, ResolvedDamageTypeProfile>> = {
  energy: { shieldAbsorb: 0.8, hullMult: 0.5 },
  kinetic: { shieldAbsorb: 0.2, hullMult: 1.0 },
};

/**
 * A damage type with no shipped default and no authored entry — any type added
 * to the `damageType` enum later, before balance gets round to tuning it. The
 * neutral profile is exactly today's pre-triangle behaviour, so a new type
 * behaves like the old pipeline until someone authors it.
 */
const NEUTRAL_PROFILE: ResolvedDamageTypeProfile = { shieldAbsorb: null, hullMult: 1 };

/** A finite, in-range number, or `fallback` — authored packs are not trusted. */
function ratioOr(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return fallback;
  return Math.min(value, max);
}

/**
 * Resolve how `type` behaves against shields and hull for this tuning pack:
 * authored `tuning.damageTypes[type]` first, then the shipped triangle, then
 * the neutral legacy profile. Per-FIELD, so a pack may author only `hullMult`
 * for energy and still inherit the 0.8 shield share.
 */
export function damageTypeProfileOf(tuning: TuningConfig, type: DamageType): ResolvedDamageTypeProfile {
  const base = DEFAULT_DAMAGE_TYPE_PROFILES[type] ?? NEUTRAL_PROFILE;
  const authored = tuning.damageTypes?.[type];
  if (!authored) return base;
  return {
    shieldAbsorb:
      authored.shieldAbsorb === undefined
        ? base.shieldAbsorb
        : ratioOr(authored.shieldAbsorb, base.shieldAbsorb ?? 0, 1),
    hullMult: ratioOr(authored.hullMult, base.hullMult, Infinity),
  };
}

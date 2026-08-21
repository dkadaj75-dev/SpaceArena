import { damageType as damageTypeEnum, type DamageType } from "../schemas/common.js";
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
export function pitchTuningOf(tuning: TuningConfig | undefined): { pitchRateMult: number; maxPitchRad: number | null } {
  const authored = tuning?.maxPitchRad;
  const clamp =
    authored === undefined || Number.isNaN(authored)
      ? null
      : Math.min(Math.max(authored, Number.EPSILON), MAX_SAFE_PITCH_RAD);
  return {
    pitchRateMult: tuning?.pitchRateMult ?? DEFAULT_PITCH_RATE_MULT,
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
  // `hybrid` is composite: it normally resolves through {@link DEFAULT_DAMAGE_TYPE_MIXES}
  // and never uses these numbers. They are the collapse of the shipped 50/50
  // mix (the average of the two rows above), so a pack that deletes the mix
  // without replacing it lands on the same behaviour instead of on a legacy
  // full-nominal hit.
  hybrid: { shieldAbsorb: 0.5, hullMult: 0.75 },
};

/** Leaf-type weights a composite damage type is made of. Ratios, not fractions. */
export type DamageTypeMix = Readonly<Partial<Record<DamageType, number>>>;

/**
 * The shipped COMPOSITION of each composite damage type: which leaf types a hit
 * is split into, and in what ratio. `hybrid` is the missile warhead — half
 * kinetic, half energy (2026-08-14) — which is why a missile is soaked by a
 * shield for 0.5 of its hit rather than kinetic's 0.2, and lands on bare plating
 * at 0.75 rather than 1.0.
 *
 * A FALLBACK, like the profiles above: `content/tuning/default.json` authors the
 * same ratio explicitly, and that authored copy is the knob a designer turns.
 */
export const DEFAULT_DAMAGE_TYPE_MIXES: Readonly<Partial<Record<DamageType, DamageTypeMix>>> = {
  hybrid: { kinetic: 0.5, energy: 0.5 },
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

/**
 * One share of a hit, already resolved to the LEAF type it is dealt as. A plain
 * `kinetic` hit is one component with `share: 1`; the shipped `hybrid` warhead
 * is two, `0.5` each.
 */
export interface ResolvedDamageComponent {
  /** The leaf type this share behaves as — shield share, hull mult AND hull resist. */
  type: DamageType;
  /** Fraction of the incoming amount dealt as {@link type}. Shares sum to 1. */
  share: number;
  /** {@link type}'s resolved profile, so the caller never re-resolves it. */
  profile: ResolvedDamageTypeProfile;
}

/**
 * Split `type` into the leaf components a hit is actually dealt as.
 *
 * A COMPOSITE type (one with a `mix`, shipped: `hybrid`) is the reason this
 * exists: rather than giving missiles their own averaged shield/hull numbers —
 * which would freeze at whatever energy and kinetic happened to be on the day
 * they were written — a hybrid hit is dealt as HALF AN ENERGY HIT AND HALF A
 * KINETIC ONE, each through its own live profile. Re-tune energy and every
 * hybrid weapon moves by its energy share, automatically. For the shield-share /
 * hull-mult model the arithmetic is identical to the averaged profile; what
 * differs is that the two halves stay independently tunable, and that a shield's
 * `coversFamilies` is asked about `kinetic`/`energy` — types shields actually
 * list — rather than about a composite name no shield in the catalogue covers.
 *
 * Rules, all of them defensive because packs are authored:
 *  - No mix (the common case) ⇒ ONE component, the type itself, share 1.
 *  - Components are LEAVES: a component's own mix is never expanded, so a chain
 *    or a cycle in content cannot recurse. Naming the composite inside its own
 *    mix is ignored for the same reason.
 *  - Weights are ratios, normalised by their sum; non-finite, negative and zero
 *    weights drop out. A mix that empties out degrades to the single-component
 *    case, i.e. the type's own profile.
 *  - Order is the ENUM's declaration order, never the JSON key order, so two
 *    packs that author the same ratio produce the same sequence of shield draws
 *    against a reserve too small to pay for both. Determinism is the sim's
 *    whole contract.
 */
export function damageComponentsOf(tuning: TuningConfig, type: DamageType): ResolvedDamageComponent[] {
  const whole = (): ResolvedDamageComponent[] => [{ type, share: 1, profile: damageTypeProfileOf(tuning, type) }];
  const mix = tuning.damageTypes?.[type]?.mix ?? DEFAULT_DAMAGE_TYPE_MIXES[type];
  if (!mix) return whole();

  const weights: Array<{ type: DamageType; weight: number }> = [];
  let total = 0;
  for (const leaf of damageTypeEnum.options) {
    if (leaf === type) continue; // self-reference: a type cannot be a share of itself
    const weight = mix[leaf];
    if (weight === undefined || !Number.isFinite(weight) || weight <= 0) continue;
    weights.push({ type: leaf, weight });
    total += weight;
  }
  if (total <= 0) return whole();

  return weights.map(({ type: leaf, weight }) => ({
    type: leaf,
    share: weight / total,
    profile: damageTypeProfileOf(tuning, leaf),
  }));
}

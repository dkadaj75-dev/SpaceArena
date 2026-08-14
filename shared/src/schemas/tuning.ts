import { z } from "zod";
import { baseShape } from "./base.js";
import { damageType } from "./common.js";

export const targetingPolicy = z.enum(["nearest", "lowestHp", "attacker"]);
export type TargetingPolicy = z.infer<typeof targetingPolicy>;

/**
 * How ONE damage type behaves against shields and hull (the damage-type
 * triangle). Every knob is optional so a pack can author half a profile and
 * inherit the rest; the sim resolves them through
 * {@link import("../sim/tuningDefaults.js").damageTypeProfileOf}.
 */
export const damageTypeProfileSchema = z.object({
  /**
   * Fraction of an incoming hit a WORKING shield tries to soak — the rest
   * penetrates straight to hull. Energy is soft against shields (0.8), kinetic
   * punches through them (0.2). When the shield's reserve cannot cover the
   * share it wants, the un-soaked excess continues to hull rather than
   * evaporating, so a collapsing shield never eats damage it did not stop.
   *
   * This REPLACES the shield module's own `mitigation.damageReduction` for the
   * types authored here: what distinguishes one shield from another is the size
   * and recharge of its reserve tank, not the share it takes off the top.
   */
  shieldAbsorb: z.number().min(0).max(1).optional(),
  /**
   * Effectiveness against HULL, applied to every point that reaches hull —
   * both the share that penetrated a live shield and the whole hit when the
   * target has no working shield at all. Energy scorches plating for half
   * effect (0.5); kinetic lands full (1.0). Applied before the hull's own
   * per-type `resists`.
   */
  hullMult: z.number().nonnegative().optional(),
  /**
   * Makes this type COMPOSITE: instead of soaking and landing on its own
   * `shieldAbsorb`/`hullMult`, a hit is split by these WEIGHTS and each share is
   * dealt as the named leaf type, through that leaf's own profile and the hull's
   * own resist column. `{ "kinetic": 0.5, "energy": 0.5 }` is the shipped
   * missile warhead: half punches through shields and lands full on plating,
   * half is soaked by shields and scorches plating for half.
   *
   * Weights are RATIOS, not fractions — they are normalised by their sum, so
   * `{kinetic: 3, energy: 1}` is a 75/25 warhead. This is the authored knob for
   * "how hybrid is this weapon", and because the shares resolve through the LEAF
   * profiles, re-tuning `energy` moves every hybrid weapon by its energy share
   * rather than leaving it frozen at a stale average.
   *
   * Components are always taken as leaves: a mix listed here is not expanded
   * again (no chains, no cycles), and naming the type itself is ignored. A mix
   * that ends up empty degrades to the type's own `shieldAbsorb`/`hullMult`.
   */
  mix: z.partialRecord(damageType, z.number().nonnegative()).optional(),
});
export type DamageTypeProfile = z.infer<typeof damageTypeProfileSchema>;

export const tuningSchema = z.object({
  ...baseShape("tuning"),
  /**
   * How TargetingSystem ranks fresh lock candidates inside the sensor cone. Only
   * consulted when a ship has no lockable incumbent — the sticky-candidate rule
   * (FLIGHT.md §2) holds the current target regardless of policy.
   */
  targetingPolicy,
  /**
   * TargetingSystem: how fast lock progress drains while the candidate is out of
   * the sensor cone/range, as a multiple of real time (FLIGHT.md §2). The drain
   * window IS the lock-break grace: at 1.5 a full lock survives ~2/3 of
   * `lockTimeSec` outside the cone before the target is dropped. Default 1.5.
   */
  lockDecayMult: z.number().positive().optional(),
  /**
   * NavigationSystem/flightStep: pitch rate as a fraction of the ship's own
   * `engine.turnRate` (BUBBLE.md §A) — `pitchStick * turnRate * pitchRateMult`.
   * A config knob rather than a new ship stat, so no ship JSON carries a pitch
   * number until balance actually asks for one. Default 0.8.
   */
  pitchRateMult: z.number().nonnegative().optional(),
  /**
   * LEGACY hard clamp on |pitch| in radians (BUBBLE.md §A). **Omit it — and the
   * shipped pack does — to get free pitch**: the nose runs the full circle, so
   * holding the stick up flies a loop exactly the way holding it left yaws
   * forever. Authored, the nose stops at ±this value and the flier can never
   * invert, which is the pre-loop behaviour kept as a knob for content packs
   * that want it. There is deliberately no default: "absent" is a behaviour
   * (free), not a missing number, so nothing substitutes one.
   *
   * Still capped short of vertical when authored — a clamp AT PI/2 would park a
   * "clamped" hull exactly on the pole, where its heading names no direction at
   * all, which is the one attitude the clamp exists to avoid.
   */
  maxPitchRad: z.number().positive().lt(Math.PI / 2).optional(),
  /**
   * ArenaSimulation: seconds of frozen "3-2-1-GO" countdown before a match goes
   * live, so both players start at the same instant. Counted in SIM time by the
   * authoritative sim itself (never a wall clock), which is what makes the two
   * clients of an online match agree on the numbers. `0` is legal and means "go
   * live on the first tick" — the test fixtures use it to keep their budgets.
   * Default 3.
   */
  matchCountdownSec: z.number().nonnegative().optional(),
  /** Global damage multiplier (balance knob). */
  globalDamageMult: z.number().positive(),
  /**
   * Per-damage-type shield/hull behaviour. Optional and per-type optional: a
   * pack that omits the block entirely gets the shipped triangle (energy
   * 0.8 shield / 0.5 hull, kinetic 0.2 shield / 1.0 hull, hybrid = half of
   * each), and a damage type with no entry keeps the LEGACY behaviour — shields
   * soak their own `mitigation.damageReduction` and hull takes the hit at full
   * nominal.
   */
  damageTypes: z.partialRecord(damageType, damageTypeProfileSchema).optional(),
  /** Planar linear drag coefficient. */
  dragCoefficient: z.number().nonnegative().optional(),
  /** CollisionSystem: spatial-hash cell size (world units). */
  spatialCellSize: z.number().positive().optional(),
  /** CollisionSystem: min closing speed (along the contact normal) for impact damage. */
  impactSpeedThreshold: z.number().nonnegative().optional(),
  /** CollisionSystem: seconds a ship/asteroid pair is immune to further impact damage. */
  impactDamageCooldown: z.number().nonnegative().optional(),
  /**
   * ProjectileSystem: how far past the arena bounds a projectile may travel
   * before it is culled (world units). A missile that outlives its target flies
   * straight until its lifetime expires, which on a radius-300 field can carry
   * it hundreds of units past the rim — beyond the ±327.67 int16 centi wire
   * range, where the replicated position silently clamps and the client renders
   * a missile frozen on a wall while the authoritative one flies on. Default 20.
   */
  projectileBoundsMargin: z.number().nonnegative().optional(),
  /** Max simulation ticks processed per frame (spiral-of-death clamp). */
  maxTicksPerFrame: z.number().int().positive().optional(),
  /** Client render: beam (laser) fade-out duration in ms. */
  beamFadeMs: z.number().positive().optional(),
  /** Client render: per-kind projectile mesh pool size (no per-shot allocations). */
  projectilePoolSize: z.number().int().positive().optional(),
  /** Client netcode: milliseconds rendered behind the newest server patch. */
  netRenderDelayMs: z.number().nonnegative().optional(),
  /** Client netcode: exponential local correction rate, per second. */
  netCorrectionRate: z.number().positive().optional(),
  /** Server: max client orders/sec accepted per player before drop + abuse count. */
  maxOrdersPerSec: z.number().int().positive().optional(),
  /** Arbitrary feature flags. */
  featureFlags: z.record(z.string(), z.boolean()).optional(),
});

export type TuningConfig = z.infer<typeof tuningSchema>;

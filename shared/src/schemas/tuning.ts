import { z } from "zod";
import { baseShape } from "./base.js";

export const targetingPolicy = z.enum(["nearest", "lowestHp", "attacker"]);
export type TargetingPolicy = z.infer<typeof targetingPolicy>;

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
   * Hard clamp on |pitch| in radians (BUBBLE.md §A). Keeps world-up unambiguous:
   * the nose can never pass vertical, so the chase cam never crosses a pole and
   * the sim needs no roll/quaternion surface. Default 1.4 (~80°).
   */
  maxPitchRad: z.number().positive().optional(),
  /** Global damage multiplier (balance knob). */
  globalDamageMult: z.number().positive(),
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

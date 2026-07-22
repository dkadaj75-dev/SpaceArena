import { z } from "zod";
import { baseShape } from "./base.js";

export const targetingPolicy = z.enum(["nearest", "lowestHp", "attacker"]);
export type TargetingPolicy = z.infer<typeof targetingPolicy>;

export const tuningSchema = z.object({
  ...baseShape("tuning"),
  /** Max ms between taps to register a double-tap (boost order). */
  doubleTapWindowMs: z.number().positive(),
  /** Max pixel movement still treated as a tap (not a drag). */
  tapSlopPx: z.number().nonnegative(),
  /** Auto-target selection policy when no focused target. */
  targetingPolicy,
  /** Global damage multiplier (balance knob). */
  globalDamageMult: z.number().positive(),
  /** Planar linear drag coefficient. */
  dragCoefficient: z.number().nonnegative().optional(),
  /** NavigationSystem: distance ahead of a ship scanned for asteroid avoidance. */
  avoidLookahead: z.number().nonnegative().optional(),
  /** NavigationSystem: strength of the asteroid-avoidance steering push. */
  avoidWeight: z.number().nonnegative().optional(),
  /** NavigationSystem: distance from target at which arrival deceleration begins. */
  arrivalRadius: z.number().positive().optional(),
  /** CollisionSystem: spatial-hash cell size (world units). */
  spatialCellSize: z.number().positive().optional(),
  /** CollisionSystem: min closing speed (along the contact normal) for impact damage. */
  impactSpeedThreshold: z.number().nonnegative().optional(),
  /** CollisionSystem: seconds a ship/asteroid pair is immune to further impact damage. */
  impactDamageCooldown: z.number().nonnegative().optional(),
  /** Max simulation ticks processed per frame (spiral-of-death clamp). */
  maxTicksPerFrame: z.number().int().positive().optional(),
  /** Client render: beam (laser) fade-out duration in ms. */
  beamFadeMs: z.number().positive().optional(),
  /** Client render: per-kind projectile mesh pool size (no per-shot allocations). */
  projectilePoolSize: z.number().int().positive().optional(),
  /** Client render: move-order path dash segment length (world units). */
  orderMarkerDashLength: z.number().positive().optional(),
  /** Arbitrary feature flags. */
  featureFlags: z.record(z.string(), z.boolean()).optional(),
});

export type TuningConfig = z.infer<typeof tuningSchema>;

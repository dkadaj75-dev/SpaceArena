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
  /**
   * Palm rejection (5.4): touch contacts landing within this many px of any
   * canvas edge are ignored by the order state machine unless they hit a HUD
   * control. 0 disables rejection. Lives here rather than in `theme.json`
   * because it is an input-feel knob measured on the *input surface*, right
   * next to `tapSlopPx`/`doubleTapWindowMs` — not a HUD look/layout dimension.
   */
  edgeRejectMarginPx: z.number().nonnegative().optional(),
  /** Auto-target selection policy when no focused target. */
  targetingPolicy,
  /**
   * TargetingSystem: how fast lock progress drains while the candidate is out of
   * the sensor cone/range, as a multiple of real time (FLIGHT.md §2). The drain
   * window IS the lock-break grace: at 1.5 a full lock survives ~2/3 of
   * `lockTimeSec` outside the cone before the target is dropped. Default 1.5.
   */
  lockDecayMult: z.number().positive().optional(),
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

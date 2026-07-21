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
  /** Max simulation ticks processed per frame (spiral-of-death clamp). */
  maxTicksPerFrame: z.number().int().positive().optional(),
  /** Arbitrary feature flags. */
  featureFlags: z.record(z.string(), z.boolean()).optional(),
});

export type TuningConfig = z.infer<typeof tuningSchema>;

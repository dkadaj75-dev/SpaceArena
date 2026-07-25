import { z } from "zod";
import { baseShape } from "./base.js";

const clamped = z.object({
  min: z.number(),
  max: z.number(),
  default: z.number(),
});

export const cameraSchema = z.object({
  ...baseShape("camera"),
  /** Orbit angle default (radians); freely adjustable in-game. */
  alpha: z.object({ default: z.number() }),
  /** Tilt clamp (radians). */
  beta: clamped,
  /** Zoom clamp (world units). */
  radius: clamped,
  /** Follow smoothing 0..1 (higher = snappier). */
  followLag: z.number().min(0).max(1),
  /** Look-ahead toward current move order (world units). */
  lookAhead: z.number().nonnegative(),
  /**
   * Camera micro-shake (5.7). A purely ADDITIVE world-space offset on the orbit
   * target: it rides on top of the follow point and the player's pan, never
   * mutates either, and decays to exactly zero. Amplitudes are world units —
   * at the tactical zoom band (radius 30-90) a few tenths of a unit is the
   * difference between "felt" and "distracting".
   */
  shake: z
    .object({
      /** Master switch — false means the rig never offsets the target. */
      enabled: z.boolean().optional(),
      /** Amplitude for a hit on the player's own ship (scaled by damage, see `damageReference`). */
      hitAmplitude: z.number().nonnegative(),
      /** Amplitude for the player scoring a kill, or their own ship dying. */
      killAmplitude: z.number().nonnegative(),
      /** How long one shake takes to decay to zero. */
      durationMs: z.number().positive(),
      /** Wobble rate. Higher reads as a sharper rattle, lower as a heavier lurch. */
      frequencyHz: z.number().positive(),
      /** Ceiling on the amplitude when shakes stack within one decay window. */
      maxAmplitude: z.number().nonnegative(),
      /** Damage amount that produces a full-strength `hitAmplitude` hit shake. */
      damageReference: z.number().positive().optional(),
      /** Floor on the damage scaling so a graze still registers. */
      minDamageScale: z.number().min(0).max(1).optional(),
    })
    .optional(),
  /** View panning (right-drag / two-finger drag). Client falls back to defaults when absent. */
  pan: z
    .object({
      /** Multiplier on drag distance → world pan (1 = ground tracks the pointer 1:1). */
      sensitivity: z.number().positive(),
      /** How far past the arena bounds radius the view may travel (world units). */
      boundsMargin: z.number().nonnegative(),
    })
    .optional(),
});

export type CameraConfig = z.infer<typeof cameraSchema>;

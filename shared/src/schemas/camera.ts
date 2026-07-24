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

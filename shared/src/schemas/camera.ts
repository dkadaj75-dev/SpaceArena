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
});

export type CameraConfig = z.infer<typeof cameraSchema>;

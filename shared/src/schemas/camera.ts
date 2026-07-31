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
  /**
   * Chase camera (FLIGHT.md §3) — the in-match rig for the continuous-flight
   * model. The orbit angle is driven by the ship's own heading instead of the
   * player's drag, so these are pure feel knobs: they replace `alpha`/`beta`/
   * `radius` while a match is running and change nothing about the menu,
   * hangar or editor modes.
   *
   * Absent block ⇒ the client falls back to its built-in chase defaults, so a
   * pre-flight content pack still gets a working chase view.
   */
  chase: z
    .object({
      /** Orbit distance behind the ship (world units). Also the zoom clamp while chasing. */
      radius: z.number().positive(),
      /** Follow-point Y offset above the ship, i.e. how far the rig looks over its shoulder. */
      height: z.number(),
      /**
       * Tilt (radians, polar from +Y like `beta`): π/2 looks straight down the
       * ship's tail, smaller lifts the camera above it. A low angle is the whole
       * point of the chase view — it is what makes speed read.
       *
       * Measured in the SHIP's frame, not the world's: the rig rolls with the
       * ship so it can follow a loop (BUBBLE.md §A), which means this one tilt is
       * the over-the-shoulder angle at every attitude, not just in level flight.
       */
      beta: z.number().positive(),
      /**
       * Heading smoothing 0..1 (higher = snappier), applied exactly like
       * `followLag` but to the orbit yaw. Low values let the ship visibly lead
       * its own camera through a turn; 1 pins the yaw to the heading.
       */
      yawLag: z.number().min(0).max(1),
      /**
       * Pitch smoothing 0..1, exactly like `yawLag` but on the tilt axis.
       * OMITTED ⇒ the rig reuses `yawLag`, which is what keeps a pack that
       * never asked for a separate pitch feel consistent on both axes.
       */
      pitchLag: z.number().min(0).max(1).optional(),
      /** Vertical field of view (radians) while chasing. Omitted keeps the engine default. */
      fov: z.number().positive().optional(),
      /**
       * Multiplier on `radius` while the viewport is LANDSCAPE (omitted = 1).
       * A wide screen already shows more of the arena, so the shipped pack
       * pulls the default chase distance in to 0.7× there; the player's local
       * camera-distance setting still multiplies on top of this baseline.
       */
      landscapeRadiusScale: z.number().positive().optional(),
    })
    .optional(),
  /**
   * Editor-stage panning (right-drag / two-finger drag). The in-match pan
   * retired with move orders (FLIGHT.md §7): the chase rig owns the view, so
   * there is no arena-bounds clamp left to configure either.
   */
  pan: z
    .object({
      /** Multiplier on drag distance → world pan (1 = ground tracks the pointer 1:1). */
      sensitivity: z.number().positive(),
    })
    .optional(),
});

export type CameraConfig = z.infer<typeof cameraSchema>;

import { z } from "zod";
import { baseShape } from "./base.js";

const behavior = z
  .object({
    baseWeight: z.number().nonnegative(),
  })
  .catchall(z.unknown()); // per-behavior tunables (doubleTapBoostChance, triggers, ...)

export const botprofileSchema = z.object({
  ...baseShape("botprofile"),
  decisionIntervalMs: z.number().positive(),
  orderJitterMs: z.number().nonnegative(),
  /** [min, max] preferred engagement range. */
  preferredRange: z.tuple([z.number().nonnegative(), z.number().nonnegative()]),
  /**
   * Stick feel for the flight model (FLIGHT.md §1/§7, BUBBLE.md §D) — how the
   * driver converts a behaviour's aim point into the `turn` and `pitchStick` axes
   * of a `flight` order. Deliberately ship-*independent*: the per-ship numbers
   * (turnRate, sensors) come from `resolveShipStats`/the sim, never from a bot
   * profile, and the pitch clamp/rate come from `tuning`. Absent ⇒ the driver's
   * documented fallbacks (horizon = one decision interval, 0.02 rad tolerance).
   */
  flight: z
    .object({
      /**
       * Rotation budget for one stick command, as a multiple of
       * `decisionIntervalMs`. Shared by both axes: it describes the control loop's
       * horizon, not a hull, and the sim integrates yaw and pitch on the same tick.
       */
      turnHorizonMult: z.number().positive().optional(),
      /**
       * Attitude error treated as "nose on": inside it the stick centres
       * (radians). Applied per axis, so a bot lined up in yaw stops sending yaw
       * even while it is still pitching onto the target.
       */
      aimToleranceRad: z.number().nonnegative().optional(),
      /** Re-send a flight order once the turn axis moves by more than this. */
      turnEpsilon: z.number().nonnegative().optional(),
      /**
       * Re-send a flight order once the pitch axis moves by more than this
       * (BUBBLE.md §D). Its own knob rather than a reuse of `turnEpsilon`: pitch is
       * the axis a bot holds still through a level fight, so the two axes have
       * genuinely different traffic profiles. Absent ⇒ the driver's 0.05 default.
       */
      pitchEpsilon: z.number().nonnegative().optional(),
      /** Re-send a flight order once the throttle moves by more than this. */
      throttleEpsilon: z.number().nonnegative().optional(),
    })
    .optional(),
  behaviors: z.record(z.string(), behavior),
  moduleDiscipline: z.object({
    heatShutdownAt: z.number().min(0).max(1),
    reactivateBelow: z.number().min(0).max(1),
    energyReserve: z.number().min(0).max(1),
    shieldOnlyWhenEngaged: z.boolean(),
  }),
});

export type BotprofileConfig = z.infer<typeof botprofileSchema>;

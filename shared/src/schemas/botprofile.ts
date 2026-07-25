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
   * Stick feel for the flight model (FLIGHT.md §1/§7) — how the driver converts a
   * behaviour's aim point into the `turn` axis of a `flight` order. Deliberately
   * ship-*independent*: the per-ship numbers (turnRate, sensors) come from
   * `resolveShipStats`/the sim, never from a bot profile. Absent ⇒ the driver's
   * documented fallbacks (horizon = one decision interval, 0.02 rad tolerance).
   */
  flight: z
    .object({
      /** Rotation budget for one turn command, as a multiple of `decisionIntervalMs`. */
      turnHorizonMult: z.number().positive().optional(),
      /** Heading error treated as "nose on": inside it the stick centres (radians). */
      aimToleranceRad: z.number().nonnegative().optional(),
      /** Re-send a flight order once the turn axis moves by more than this. */
      turnEpsilon: z.number().nonnegative().optional(),
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

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
  behaviors: z.record(z.string(), behavior),
  moduleDiscipline: z.object({
    heatShutdownAt: z.number().min(0).max(1),
    reactivateBelow: z.number().min(0).max(1),
    energyReserve: z.number().min(0).max(1),
    shieldOnlyWhenEngaged: z.boolean(),
  }),
});

export type BotprofileConfig = z.infer<typeof botprofileSchema>;

import { z } from "zod";
import { baseShape } from "./base.js";

export const progressionSchema = z.object({
  ...baseShape("progression"),
  /** XP required to reach each level index (index 0 = level 1). */
  xpCurve: z.array(z.number().nonnegative()).min(1),
  /** Credit reward defaults, overridable per gamemode. */
  rewards: z.object({
    perKill: z.number().int().nonnegative(),
    win: z.number().int().nonnegative(),
    loss: z.number().int().nonnegative(),
  }),
  /** Level -> unlocked config ids (ships/modules). */
  unlocks: z.record(z.string(), z.array(z.string())).optional(),
});

export type ProgressionConfig = z.infer<typeof progressionSchema>;

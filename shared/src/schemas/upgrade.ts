import { z } from "zod";
import { baseShape } from "./base.js";

/** One purchasable level: additive/multiplicative deltas on core stats + price. */
const upgradeLevel = z.object({
  level: z.number().int().positive(),
  price: z.number().int().nonnegative(),
  /** Additive deltas keyed by stat path, e.g. `hull.base`. */
  add: z.record(z.string(), z.number()).optional(),
  /** Multiplicative deltas keyed by stat path. */
  mul: z.record(z.string(), z.number()).optional(),
});

export const upgradeSchema = z.object({
  ...baseShape("upgrade"),
  /** Which core track this upgrade line governs. */
  track: z.enum(["hull", "engine", "energy", "heat"]),
  levels: z.array(upgradeLevel).min(1),
});

export type UpgradeConfig = z.infer<typeof upgradeSchema>;

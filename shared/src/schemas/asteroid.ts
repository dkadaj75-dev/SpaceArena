import { z } from "zod";
import { baseShape } from "./base.js";
import { renderRecipe } from "./common.js";

/** Per-asset visual state stub (e.g. intact / cracked / destroyed). */
const assetState = z.object({
  id: z.string(),
  render: renderRecipe.optional(),
  onEnter: z.array(z.string()).optional(), // action ids
});

export const asteroidSchema = z.object({
  ...baseShape("asteroid"),
  radius: z.number().positive(),
  hp: z.number().positive().optional(),
  destructible: z.boolean(),
  impactDamage: z.number().nonnegative(),
  render: renderRecipe,
  states: z.array(assetState).optional(),
});

export type AsteroidConfig = z.infer<typeof asteroidSchema>;

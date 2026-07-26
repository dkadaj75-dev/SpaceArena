import { z } from "zod";
import { baseShape } from "./base.js";
import { renderRecipe } from "./common.js";

export const asteroidSpinSchema = z
  .object({
    minDegPerSec: z.number().nonnegative(),
    maxDegPerSec: z.number().nonnegative(),
  })
  .refine((spin) => spin.maxDegPerSec >= spin.minDegPerSec, {
    message: "maxDegPerSec must be greater than or equal to minDegPerSec",
    path: ["maxDegPerSec"],
  });

/** Asteroid-only visual knobs layered onto the shared render recipe. */
export const asteroidRenderRecipe = renderRecipe.extend({
  spin: asteroidSpinSchema.optional(),
});

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
  render: asteroidRenderRecipe,
  states: z.array(assetState).optional(),
});

export type AsteroidConfig = z.infer<typeof asteroidSchema>;
export type AsteroidSpinConfig = z.infer<typeof asteroidSpinSchema>;

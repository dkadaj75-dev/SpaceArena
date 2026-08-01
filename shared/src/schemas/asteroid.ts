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
  /**
   * The rock's VISUAL radius: how big it is drawn, and the scale its model is
   * baked to. See {@link asteroidSchema.shape.colliderScale} for why the thing
   * you can crash into is smaller than this.
   */
  radius: z.number().positive(),
  /**
   * Collision sphere as a fraction of {@link radius} (owner report 2026-07-31:
   * "the collision box kills you before you touch the asteroid").
   *
   * A rock model is IRREGULAR — these are roughly 0.95 x 0.60 x 0.76 of their
   * nominal radius on the three axes — but the sim collides against a SPHERE.
   * Sized to the widest axis, that sphere sticks out into empty space along
   * every other one, and a pilot dies visibly short of the surface. Sized to
   * a fraction instead, the sphere sits inside the silhouette: the worst case
   * becomes clipping slightly into rock, which is far better than exploding in
   * clear space.
   *
   * Defaults to 1 so an authored perfectly-spherical asset needs nothing.
   */
  colliderScale: z.number().positive().max(1).default(1),
  hp: z.number().positive().optional(),
  destructible: z.boolean(),
  impactDamage: z.number().nonnegative(),
  render: asteroidRenderRecipe,
  states: z.array(assetState).optional(),
});

export type AsteroidConfig = z.infer<typeof asteroidSchema>;
export type AsteroidSpinConfig = z.infer<typeof asteroidSpinSchema>;

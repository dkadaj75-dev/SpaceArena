import { z } from "zod";
import { baseShape } from "./base.js";
import { palette, vec2, vec3 } from "./common.js";

/**
 * Arena bounds. The planar `circle` is RETIRED (BUBBLE.md): ships fly in 3D, so
 * the play space is a **sphere** — a bubble of the same radius the circle had —
 * and every boundary/cull check works on 3D radial distance. `rect` survives for
 * non-spherical fields and is still evaluated planar (its walls are infinite in y).
 */
export const arenaBounds = z.discriminatedUnion("shape", [
  z.object({ shape: z.literal("sphere"), radius: z.number().positive() }),
  z.object({
    shape: z.literal("rect"),
    width: z.number().positive(),
    height: z.number().positive(),
  }),
]);
export type ArenaBounds = z.infer<typeof arenaBounds>;

const asteroidPlacement = z.object({
  /** References an `asteroid.*` config id. */
  asteroidId: z.string(),
  /** Bubble position; `y` omitted ⇒ 0 (the old ground plane). */
  position: vec3,
  rotation: z.number().optional(),
  scale: z.number().positive().optional(),
});

const spawnPoint = z.object({
  id: z.string(),
  team: z.number().int().nonnegative(),
  /** Bubble position; `y` omitted ⇒ 0. */
  position: vec3,
  heading: z.number(),
  /** Initial nose elevation in radians; omitted ⇒ 0 (level). */
  pitch: z.number().optional(),
});

/** Trigger-zone stub (fleshed out by Map Editor + Event Editor later). */
const zone = z.object({
  id: z.string(),
  shape: z.enum(["circle", "rect"]),
  position: vec2,
  radius: z.number().positive().optional(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
});

export const arenaSchema = z.object({
  ...baseShape("arena"),
  bounds: arenaBounds,
  asteroidPlacements: z.array(asteroidPlacement),
  spawnPoints: z.array(spawnPoint).min(1),
  lighting: z
    .object({
      ambientColor: z.string().optional(),
      ambientIntensity: z.number().nonnegative().optional(),
      directionalIntensity: z.number().nonnegative().optional(),
    })
    .optional(),
  skybox: z
    .object({
      recipe: z.string(),
      palette: palette.optional(),
    })
    .optional(),
  zones: z.array(zone).optional(),
});

export type ArenaConfig = z.infer<typeof arenaSchema>;

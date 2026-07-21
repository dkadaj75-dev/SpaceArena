import { z } from "zod";
import { baseShape } from "./base.js";
import { palette, vec2 } from "./common.js";

export const arenaBounds = z.discriminatedUnion("shape", [
  z.object({ shape: z.literal("circle"), radius: z.number().positive() }),
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
  position: vec2,
  rotation: z.number().optional(),
  scale: z.number().positive().optional(),
});

const spawnPoint = z.object({
  id: z.string(),
  team: z.number().int().nonnegative(),
  position: vec2,
  heading: z.number(),
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

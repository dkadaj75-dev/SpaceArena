import { z } from "zod";
import { baseShape } from "./base.js";
import { palette, vec2, vec3 } from "./common.js";

/** Largest positive coordinate representable by the signed int16 centi wire. */
export const WIRE_POSITION_LIMIT = 327.67;
/** Projectile cull overshoot used when tuning omits `projectileBoundsMargin`. */
export const DEFAULT_PROJECTILE_BOUNDS_MARGIN = 20;

export interface ArenaWireIssue {
  path: readonly (string | number)[];
  message: string;
}

/**
 * Check every arena extent that replicated projectiles can reach. Kept separate
 * from the schema so pack validation can repeat it with an authored tuning
 * margin instead of the schema's documented default.
 */
export function arenaWireEnvelopeIssues(
  bounds:
    | { shape: "sphere"; radius: number }
    | { shape: "rect"; width: number; height: number; verticalExtent: number },
  margin: number,
): ArenaWireIssue[] {
  const issues: ArenaWireIssue[] = [];
  if (bounds.shape === "sphere") {
    if (bounds.radius + margin > WIRE_POSITION_LIMIT) {
      issues.push({
        path: ["bounds", "radius"],
        message: `radius plus projectile margin (${margin}) must not exceed the wire limit ${WIRE_POSITION_LIMIT}`,
      });
    }
  } else {
    for (const [key, extent] of [
      ["width", bounds.width],
      ["height", bounds.height],
      ["verticalExtent", bounds.verticalExtent],
    ] as const) {
      if (extent / 2 + margin > WIRE_POSITION_LIMIT) {
        issues.push({
          path: ["bounds", key],
          message: `half extent plus projectile margin (${margin}) must not exceed the wire limit ${WIRE_POSITION_LIMIT}`,
        });
      }
    }
  }
  return issues;
}

/**
 * Arena bounds. The planar `circle` is RETIRED (BUBBLE.md): ships fly in 3D, so
 * the play space is a **sphere** — a bubble of the same radius the circle had —
 * and every boundary/cull check works on 3D radial distance. `rect` survives for
 * non-spherical fields as a bounded 3D box. `height` is its z extent and
 * `verticalExtent` is its y extent.
 */
export const arenaBounds = z.discriminatedUnion("shape", [
  z.object({ shape: z.literal("sphere"), radius: z.number().positive() }),
  z.object({
    shape: z.literal("rect"),
    width: z.number().positive(),
    height: z.number().positive(),
    verticalExtent: z.number().positive(),
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
  pitch: z.number().gt(-Math.PI / 2).lt(Math.PI / 2).optional(),
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

export const arenaSchema = z
  .object({
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
  })
  .superRefine((arena, ctx) => {
    for (const issue of arenaWireEnvelopeIssues(arena.bounds, DEFAULT_PROJECTILE_BOUNDS_MARGIN)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...issue.path],
        message: issue.message,
      });
    }

    arena.spawnPoints.forEach((spawn, index) => {
      const y = spawn.position.y ?? 0;
      const inside =
        arena.bounds.shape === "sphere"
          ? Math.hypot(spawn.position.x, y, spawn.position.z) <= arena.bounds.radius
          : Math.abs(spawn.position.x) <= arena.bounds.width / 2 &&
            Math.abs(spawn.position.z) <= arena.bounds.height / 2 &&
            Math.abs(y) <= arena.bounds.verticalExtent / 2;
      if (!inside) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["spawnPoints", index, "position"],
          message: "spawn position must be inside arena bounds",
        });
      }
    });
  });

export type ArenaConfig = z.infer<typeof arenaSchema>;

import { z } from "zod";
import { baseShape } from "./base.js";
import { vec2, vec3 } from "./common.js";

/** Largest positive coordinate representable by the signed int16 centi wire. */
export const WIRE_POSITION_LIMIT = 327.67;
/** Projectile cull overshoot used when tuning omits `projectileBoundsMargin`. */
export const DEFAULT_PROJECTILE_BOUNDS_MARGIN = 20;

export interface ArenaWireIssue {
  path: readonly (string | number)[];
  message: string;
}

/** Schema-local check: authored arena geometry itself must fit on the wire. */
export function arenaWireBoundsIssues(
  bounds:
    | { shape: "sphere"; radius: number }
    | { shape: "rect"; width: number; height: number; verticalExtent: number },
): ArenaWireIssue[] {
  if (bounds.shape === "sphere") {
    return bounds.radius > WIRE_POSITION_LIMIT
      ? [{
          path: ["bounds", "radius"],
          message: `radius must not exceed the wire limit ${WIRE_POSITION_LIMIT}`,
        }]
      : [];
  }
  const issues: ArenaWireIssue[] = [];
  for (const [key, extent] of [
    ["width", bounds.width],
    ["height", bounds.height],
    ["verticalExtent", bounds.verticalExtent],
  ] as const) {
    if (extent / 2 > WIRE_POSITION_LIMIT) {
      issues.push({
        path: ["bounds", key],
        message: `half extent must not exceed the wire limit ${WIRE_POSITION_LIMIT}`,
      });
    }
  }
  return issues;
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

/**
 * Arena-owned presentation. Sky imagery and the boundary shield both describe
 * this particular play space (including its physical radius), so they live
 * beside `bounds` rather than in the global theme or gameplay tuning.
 */
export const arenaRender = z.object({
  skybox: z.object({
    /** Content-relative equirectangular panorama, served from `/content/*`. */
    texture: z.string().min(1),
    /** Emissive multiplier applied to the panorama. */
    intensity: z.number().nonnegative(),
    /** RGB tint multiplied into the panorama. */
    tint: z.string().min(1),
  }),
  boundaryShield: z.object({
    /** Opacity while the player is farther away than `glowStartDistance`. */
    baseOpacity: z.number().min(0).max(1),
    /** Distance inside the boundary where the shield begins brightening. */
    glowStartDistance: z.number().positive(),
    /** Distance inside the boundary where blue begins blending toward red. */
    redTransitionDistance: z.number().positive(),
    /** Distance inside the boundary that triggers the HUD warning. */
    warnDistance: z.number().positive(),
    blueColor: z.string().min(1),
    redColor: z.string().min(1),
    /** Number of procedural hex cells around the shield. */
    hexDensity: z.number().positive(),
    /** Existing notification-pipeline config shown on first warning-zone entry. */
    warningNotification: z.string().min(1),
  }),
});
export type ArenaRender = z.infer<typeof arenaRender>;

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
    render: arenaRender.optional(),
    zones: z.array(zone).optional(),
  })
  .superRefine((arena, ctx) => {
    // The standalone schema owns only the intrinsic arena-coordinate limit.
    // Projectile headroom depends on the pack's authored tuning margin and is
    // therefore enforced by ConfigService's cross-config validation.
    for (const issue of arenaWireBoundsIssues(arena.bounds)) {
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

    const shield = arena.render?.boundaryShield;
    if (shield) {
      if (shield.redTransitionDistance > shield.glowStartDistance) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["render", "boundaryShield", "redTransitionDistance"],
          message: "red transition distance must not exceed glow start distance",
        });
      }
      if (shield.warnDistance > shield.glowStartDistance) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["render", "boundaryShield", "warnDistance"],
          message: "warning distance must not exceed glow start distance",
        });
      }
    }
  });

export type ArenaConfig = z.infer<typeof arenaSchema>;

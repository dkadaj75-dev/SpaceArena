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

/**
 * One ellipsoidal lobe of a rock body, in units of the asteroid's nominal
 * radius. A single lobe at the origin is a potato; a stretched one is a
 * splinter; two or three overlapping ones make a contact binary or a rubble
 * knot.
 */
export const rockLobeSchema = z.object({
  /** Lobe centre offset from the body origin. Omitted ⇒ centred. */
  offset: z.tuple([z.number(), z.number(), z.number()]).optional(),
  /** Semi-axes along local x/y/z. */
  radii: z.tuple([z.number().positive(), z.number().positive(), z.number().positive()]),
});

/**
 * The authored SHAPE of a rock — the single description the sim collides
 * against and the renderer tessellates (see
 * `shared/src/collision/rockShape.ts`). Everything is expressed in units of the
 * config's `radius`, so one shape can be reused at any size.
 */
export const rockShapeSchema = z
  .object({
    /** Integer seed for the deterministic noise/crater/facet placement. */
    seed: z.number().int(),
    lobes: z.array(rockLobeSchema).min(1).max(4),
    noise: z.object({
      /** Peak radial wobble as a fraction of the lobe radius. */
      amplitude: z.number().min(0).max(0.4),
      /** Base angular frequency of the surface waves. */
      frequency: z.number().positive().max(24),
      octaves: z.number().int().min(1).max(4),
    }),
    /** Impact bowls with raised rims, spread evenly over the body. */
    craters: z
      .object({
        count: z.number().int().min(0).max(16),
        radiusDeg: z.number().min(4).max(70),
        /** Bowl depth as a fraction of the local lobe radius. */
        depth: z.number().min(0).max(0.4),
        /** Rim height as a fraction of `depth`. */
        rim: z.number().min(0).max(1).default(0.35),
      })
      .optional(),
    /** Plane cuts, for shattered/angular shards. */
    facets: z
      .object({
        count: z.number().int().min(0).max(24),
        /** How far each plane cuts in, as a fraction of the lobe radius. */
        depth: z.number().min(0).max(0.45),
      })
      .optional(),
  })
  .superRefine((shape, ctx) => {
    shape.lobes.forEach((lobe, index) => {
      const offset = lobe.offset ?? [0, 0, 0];
      // Every lobe must CONTAIN the body origin. That is exactly the condition
      // that keeps the union of lobes star-shaped about the centre, which is
      // what makes the radial field single-valued — and therefore what makes
      // collision agree with the drawn mesh. A lobe floating free of the body
      // would also render as a detached island, so this is a content bug either
      // way.
      const normalized = Math.hypot(
        offset[0] / lobe.radii[0],
        offset[1] / lobe.radii[1],
        offset[2] / lobe.radii[2],
      );
      if (normalized > 0.85) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["lobes", index, "offset"],
          message: `lobe offset must stay inside its own radii (normalized ${normalized.toFixed(3)}, max 0.85)`,
        });
      }
    });
  });

export type RockShapeConfig = z.infer<typeof rockShapeSchema>;
export type RockLobeConfig = z.infer<typeof rockLobeSchema>;

/**
 * Named PBR texture set for a rock surface, resolved by the client against
 * `content/props/textures/game/<set>_{diff,nor,rough,ao}_1k.jpg`. Kept as an
 * enum rather than free paths so a content pack cannot point an asteroid at an
 * asset that is not in the pack.
 */
export const rockTextureSet = z.enum(["aerial_ground_rock", "cliff_side", "gray_rocks", "moon_dusted_01"]);
export type RockTextureSet = z.infer<typeof rockTextureSet>;

/**
 * How a rock's surface is shaded. The renderer builds a triplanar-style box UV
 * from the mesh's own local coordinates, so `tileMeters` is a real world-space
 * tile size: a colossal rock and a pebble share a texture set without the big
 * one looking smeared.
 */
export const rockSurfaceSchema = z.object({
  textureSet: rockTextureSet,
  /** World size of one texture tile, in metres. */
  tileMeters: z.number().positive().max(200),
  /** Multiplier on the roughness map (1 = as authored). */
  roughness: z.number().min(0).max(2).default(1),
  /** Dielectric rock is never metallic; exposed only for icy/metallic variants. */
  metallic: z.number().min(0).max(1).default(0),
  /**
   * Normal-map strength; >1 exaggerates the micro relief.
   *
   * It belongs to the SCAN, not to the rock: the four sets differ by a factor of
   * five in how much slope they actually encode (`gray_rocks` has a standard
   * deviation of 33/255 in red, `aerial_ground_rock` 7/255), so this is the
   * per-set correction that makes them read alike. It is also enforced per set,
   * because the renderer carries the value on the shared `Texture.level` — two
   * configs on one scan set CANNOT hold different strengths, and authoring them
   * differently would silently give both whichever loaded last. See
   * `shippedAsteroids.test.ts`.
   */
  normalStrength: z.number().min(0).max(4).default(1),
});
export type RockSurfaceConfig = z.infer<typeof rockSurfaceSchema>;

/** Asteroid-only visual knobs layered onto the shared render recipe. */
export const asteroidRenderRecipe = renderRecipe.extend({
  spin: asteroidSpinSchema.optional(),
  /** PBR surface treatment; omitted ⇒ the flat palette look. */
  surface: rockSurfaceSchema.optional(),
  /** Tessellation detail of the shape mesh (icosphere subdivisions). */
  detail: z.number().int().min(1).max(6).optional(),
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
   * The rock's NOMINAL radius: the unit its {@link asteroidSchema.shape.shape}
   * field is expressed in, and the size it is drawn and collided at.
   */
  radius: z.number().positive(),
  /**
   * Collision sphere as a fraction of {@link radius}, for a rock that authors
   * NO `shape` (owner report 2026-07-31: "the collision box kills you before you
   * touch the asteroid").
   *
   * This is the legacy fallback and the compromise it encodes is why `shape`
   * exists. A rock model is IRREGULAR, but without a shape the sim can only
   * collide a SPHERE: sized to the widest axis it sticks out into empty space
   * everywhere else and a pilot dies short of the surface; sized to a fraction
   * it sits inside the silhouette and shots pass through visible rock instead.
   *
   * A config that authors `shape` collides against the real surface and ignores
   * this entirely.
   */
  colliderScale: z.number().positive().max(1).default(1),
  /**
   * The rock's body shape. Present ⇒ the sim collides against this surface and
   * the client tessellates the same field, so the thing you hit is the thing you
   * see. Absent ⇒ the legacy `colliderScale` sphere.
   */
  shape: rockShapeSchema.optional(),
  hp: z.number().positive().optional(),
  destructible: z.boolean(),
  impactDamage: z.number().nonnegative(),
  render: asteroidRenderRecipe,
  states: z.array(assetState).optional(),
});

export type AsteroidConfig = z.infer<typeof asteroidSchema>;
export type AsteroidSpinConfig = z.infer<typeof asteroidSpinSchema>;

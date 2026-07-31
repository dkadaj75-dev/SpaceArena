import { z } from "zod";

/** Damage / resist channels (matrix keys). Extensible. */
export const damageType = z.enum(["kinetic", "energy"]);
export type DamageType = z.infer<typeof damageType>;

/** Module families (MVP). New family = new optional block, not a new schema. */
export const moduleFamily = z.enum([
  // --- Hardpoint families: what bolts on the OUTSIDE of a hull ---
  "laser",
  "kinetic",
  "missile",
  "shield",
  "boost",
  "utility",
  // --- Internal families (owner 2026-07-31): the ship's systems bay. One
  // socket each on every hull; they are always on and shape the hull's stats
  // rather than being fired. See `internalFamily` below. ---
  "engine",
  "generator",
  "transformer",
  "heatsink",
  "sensors",
]);
export type ModuleFamily = z.infer<typeof moduleFamily>;

/**
 * The families that live in a hull's INTERNAL bay rather than on a hardpoint
 * (owner 2026-07-31). Hardpoints carry what shoots or shields; internals are the
 * ship's systems — they never activate, they change what the hull IS:
 *
 *  - `engine`      — speed / acceleration / turn rate, and whether the hull has
 *                    a boost at all (the base engine does not)
 *  - `generator`   — capacitor size and regen, at the cost of top speed: a
 *                    bigger plant is heavier and steals thrust
 *  - `transformer` — how efficiently power is delivered: scales BOTH energy
 *                    draw and heat generation across the whole ship
 *  - `heatsink`    — dissipation and heat capacity; the good ones can be
 *                    JETTISONED as a decoy (see `moduleSchema.jettison`)
 *  - `sensors`     — lock range, lock time and cone width
 *
 * Exported as a runtime set so UI and validation share one source of truth.
 */
export const INTERNAL_FAMILIES = ["engine", "generator", "transformer", "heatsink", "sensors"] as const;
export type InternalFamily = (typeof INTERNAL_FAMILIES)[number];

/** Whether a family belongs in the internal bay rather than on a hardpoint. */
export function isInternalFamily(family: ModuleFamily): family is InternalFamily {
  return (INTERNAL_FAMILIES as readonly string[]).includes(family);
}

/** Planar coordinate on the arena ground plane (trigger zones, minimap projection). */
export const vec2 = z.object({
  x: z.number(),
  z: z.number(),
});
export type Vec2 = z.infer<typeof vec2>;

/**
 * Arena-space coordinate inside the bubble (BUBBLE.md). `y` is the vertical axis
 * and is OPTIONAL in content: an arena authored flat omits it everywhere and
 * every consumer reads `y ?? 0`. It is deliberately not a zod `.default(0)` —
 * fixtures that build configs without going through the parser would then be
 * typed `number` while holding `undefined`.
 */
export const vec3 = vec2.extend({ y: z.number().optional() });
export type Vec3 = z.infer<typeof vec3>;

/** Named color palette: role -> hex-ish color string. Kept loose on purpose. */
export const palette = z.record(z.string(), z.string());
export type Palette = z.infer<typeof palette>;

/** Procedural / glTF visual recipe reference plus optional palette. */
export const renderRecipe = z.object({
  recipe: z.string(),
  palette: palette.optional(),
  /**
   * Optional GLB/GLTF hull replacing the procedural recipe, as a content-relative
   * path (e.g. "ships/LShip01.glb"). The recipe stays the fallback while the
   * model loads or if loading fails. Convention: ship noses point +Z at yaw 0 —
   * use `modelRotationY` (radians) to correct models authored facing elsewhere.
   */
  model: z.string().optional(),
  modelScale: z.number().positive().optional(),
  modelRotationY: z.number().optional(),
});
export type RenderRecipe = z.infer<typeof renderRecipe>;

/** Radius-only collider config; sim narrow phases treat it as a sphere in the bubble. */
export const collider = z.object({
  shape: z.literal("circle"),
  radius: z.number().positive(),
});
export type Collider = z.infer<typeof collider>;

/** Resist matrix: fraction of incoming damage removed, per channel. */
export const resists = z.object({
  kinetic: z.number().min(0).max(0.95),
  energy: z.number().min(0).max(0.95),
});
export type Resists = z.infer<typeof resists>;

/**
 * A single op-based stat effect used by the deterministic stat resolver
 * (see `shared/src/sim/resolveStats.ts`). `target` is a core stat path such as
 * `engine.nominalSpeed` (an optional leading `core.` is accepted and stripped);
 * `op` is `add` (summed) or `mul` (multiplied); resolution order is
 * add-then-mul-then-clamp.
 */
export const statOp = z.object({
  target: z.string().min(1),
  op: z.enum(["add", "mul"]),
  value: z.number(),
});
export type StatOp = z.infer<typeof statOp>;

import { z } from "zod";

/** Damage / resist channels (matrix keys). Extensible. */
export const damageType = z.enum(["kinetic", "energy"]);
export type DamageType = z.infer<typeof damageType>;

/** Module families (MVP). New family = new optional block, not a new schema. */
export const moduleFamily = z.enum([
  "laser",
  "kinetic",
  "missile",
  "shield",
  "boost",
  "utility",
]);
export type ModuleFamily = z.infer<typeof moduleFamily>;

/** Planar coordinate on the arena ground plane (2.5D sim). */
export const vec2 = z.object({
  x: z.number(),
  z: z.number(),
});
export type Vec2 = z.infer<typeof vec2>;

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

/** Circle collider on the arena plane. Only shape supported in MVP. */
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

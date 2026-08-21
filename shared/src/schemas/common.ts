import { z } from "zod";

/**
 * Damage / resist channels (matrix keys). Extensible.
 *
 * `kinetic` and `energy` are LEAF types: each carries its own shield share and
 * hull multiplier (`tuning.damageTypes`), and the hull's `resists` matrix has a
 * column for each.
 *
 * `hybrid` is a COMPOSITE type (missiles, 2026-08-14): it owns no split of its
 * own, it is a MIX of leaf types authored in `tuning.damageTypes.hybrid.mix`
 * (shipped: half kinetic, half energy). The damage pipeline resolves the mix at
 * hit time and applies each share as its leaf type — through that leaf's shield
 * share, hull multiplier and hull resist — so retuning `energy` moves every
 * hybrid weapon by half as much, exactly as a designer would expect. See
 * {@link import("../sim/tuningDefaults.js").damageComponentsOf}.
 */
export const damageType = z.enum(["kinetic", "energy", "hybrid"]);
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
  "countermeasure",
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
 *  - `generator`   — how fast every module tank refills, at the cost of top speed: a
 *                    bigger plant is heavier and steals thrust
 *  - `transformer` — how efficiently power is delivered: scales BOTH energy
 *                    draw across the whole ship
 *  - `countermeasure` — decoy pods; the fitted one can be
 *                    JETTISONED as a decoy (see `moduleSchema.jettison`)
 *  - `sensors`     — lock range, lock time and cone width
 *
 * Exported as a runtime set so UI and validation share one source of truth.
 */
export const INTERNAL_FAMILIES = ["engine", "generator", "transformer", "countermeasure", "sensors"] as const;
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

/**
 * Runtime signal ids an emitter socket or emissive-glow block can bind to. Each
 * id names a scalar that {@link import("../sim/signals.js").SIGNAL_REGISTRY}
 * computes as a pure function of a ship snapshot (and optionally the previous
 * snapshot). Lives here (not socket.ts) so `renderRecipe` below can reference it
 * without a common → socket cycle; socket.ts re-exports it unchanged.
 * **Adding a signal = one entry here plus one registry entry there.**
 */
export const signalId = z.enum([
  "throttle",
  "boostActive",
  "hullFraction",
  "shieldActive",
  "firing",
  "speedFraction",
]);
export type SignalId = z.infer<typeof signalId>;

/**
 * Designer-selected emissive light on a GLB hull (F10 ship tool): the named
 * material slot emits its own albedo texture as light, scaled live by `source`
 * (default `throttle`) from 10% at signal 0 up to 100% at signal 1. Absent =
 * no signal-driven emissive light; any emissive the GLB authors is untouched.
 */
export const emissiveGlow = z.object({
  /** GLB material (sub-material) name acting as the emissive light. */
  material: z.string().min(1),
  /** Driving signal; defaults to `throttle`. */
  source: signalId.optional(),
});
export type EmissiveGlow = z.infer<typeof emissiveGlow>;

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
  /** Authored lower-detail models, selected at monotonically increasing world distances. */
  lods: z.array(z.object({ model: z.string().min(1), distance: z.number().positive() })).optional(),
  /** Signal-driven emissive light on one of the model's material slots. */
  emissiveGlow: emissiveGlow.optional(),
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

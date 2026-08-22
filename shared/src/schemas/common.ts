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
  // --- Support hardpoint families (owner 2026-08-22): the two ways a hardpoint
  // can act on a ship OTHER than by shooting it or by soaking a hit. Both are
  // cooldown-gated pulses rather than held tools (see `slow` / `repairField` in
  // module.ts), and they are separate families rather than one "support" family
  // because a hull decides per socket which of the two it will carry, and the
  // HUD colours and glyphs them differently. ---
  "disruptor",
  "repair",
  "boost",
  // `utility` is the PASSIVE stat block (armour plating, capacitor battery, flux
  // capacitor). Since 2026-08-22 no hardpoint accepts it — the owner's rule for
  // the new hardpoint layout is "a weapon or a shield, nothing dead weight" — so
  // it is fitted through a hull's `in-auxiliary` internal bay instead. It is
  // still not an INTERNAL family: it has no always-on systems behaviour, it just
  // sits there changing the resolved stats.
  "utility",
  // --- Internal families (owner 2026-07-31): the ship's systems bay. One
  // socket each on every hull; they are always on and shape the hull's stats
  // rather than being fired. See `internalFamily` below. ---
  "engine",
  "generator",
  // `hull` is the ALLOY bay (owner 2026-08-22). It took the socket the retired
  // `transformer` family held, and it is the same KIND of thing every other
  // internal is — an always-on module that changes what the hull is — except
  // that what it changes is the airframe itself: how much structure it carries,
  // how fast it moves, and what it shrugs off. See `content/modules/alloy-*`.
  "hull",
  "countermeasure",
  "sensors",
]);
export type ModuleFamily = z.infer<typeof moduleFamily>;

/**
 * The families that live in a hull's INTERNAL bay rather than on a hardpoint
 * (owner 2026-07-31). Hardpoints carry what shoots or shields; internals are the
 * ship's systems — they never activate, they change what the hull IS:
 *
 *  - `engine`      — how fast the hull moves, and what that speed costs it in
 *                    energy draw (the Earth Engine line, owner 2026-08-22)
 *  - `generator`   — how big every module tank on the hull is (`energyStore`)
 *  - `hull`        — the ALLOY the airframe is built from: structure, speed and
 *                    the two damage resists, traded against each other
 *  - `countermeasure` — decoy pods; the fitted one can be
 *                    JETTISONED as a decoy (see `moduleSchema.jettison`)
 *  - `sensors`     — lock range, lock time and cone width
 *
 * The `transformer` family was RETIRED on 2026-08-22 (owner). Its one live stat
 * hook — `efficiency.energyDraw`, the ship-wide multiplier on what every module
 * spends — did not die with it: the Earth Engine line took it over, so a faster
 * drive is paid for in a thirstier ship rather than in a separate bay.
 *
 * Exported as a runtime set so UI and validation share one source of truth.
 */
export const INTERNAL_FAMILIES = ["engine", "generator", "hull", "countermeasure", "sensors"] as const;
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
  // Owner 2026-08-22: how hard a slowing ray is holding this hull, 0..1. A
  // designer binds an emitter to THIS to say what being slowed looks like —
  // arcing tether particles, a stuttering engine trail — with no client code.
  "slowed",
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

/**
 * Legal band for {@link renderRecipe}'s `pursuitZoom`, shared by the schema, the
 * F10 ship tool's slider and the chase rig itself so all three agree on what a
 * designer is allowed to author. Kept here (not in the client rig) because the
 * schema is the thing that has to reject an out-of-band file.
 */
export const PURSUIT_ZOOM_MIN = 0.25;
export const PURSUIT_ZOOM_MAX = 3;
/** Absent `pursuitZoom` ⇒ exactly the camera pack's authored chase distance. */
export const DEFAULT_PURSUIT_ZOOM = 1;

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
  /**
   * SHIPS ONLY (other config types share this recipe and ignore it): per-hull
   * multiplier on the in-match pursuit camera's follow distance, on top of
   * `camera.chase.radius` and the player's own distance setting. 1 = the
   * camera pack's authored distance, below pulls the rig in, above pushes it
   * out. Absent means 1, so a hull that never authored one keeps exactly the
   * framing it had before this field existed.
   */
  pursuitZoom: z.number().min(PURSUIT_ZOOM_MIN).max(PURSUIT_ZOOM_MAX).optional(),
});
export type RenderRecipe = z.infer<typeof renderRecipe>;

/** Radius-only collider config; sim narrow phases treat it as a sphere in the bubble. */
export const collider = z.object({
  shape: z.literal("circle"),
  radius: z.number().positive(),
});
export type Collider = z.infer<typeof collider>;

/**
 * Legal band for a resist, shared by the schema below and by the stat resolver
 * that clamps the post-passive value. One constant for both because they bound
 * the same quantity from two directions: the schema bounds what an AUTHOR may
 * write on a hull, the resolver bounds what a stack of alloys and upgrades may
 * add on top. 0.95 rather than 1 so no legal combination of content produces a
 * hull that is immune to a damage channel.
 */
export const RESIST_MIN = 0;
export const RESIST_MAX = 0.95;

/** Resist matrix: fraction of incoming damage removed, per channel. */
export const resists = z.object({
  kinetic: z.number().min(RESIST_MIN).max(RESIST_MAX),
  energy: z.number().min(RESIST_MIN).max(RESIST_MAX),
});
export type Resists = z.infer<typeof resists>;

/**
 * Legal band for every hull COMBAT multiplier ({@link shipCombat}), shared by
 * the schema, the F10 ship tool's sliders and the resolver that clamps the
 * post-upgrade value. One band for all of them on purpose: they are the same
 * kind of knob and a designer should not have to remember three ranges.
 *
 * 4× is where a "specialist" stops being a specialist and starts being a
 * different game; 0.25× is where a hull has effectively given the role up.
 */
export const COMBAT_MULT_MIN = 0.25;
export const COMBAT_MULT_MAX = 4;
/** Absent multiplier ⇒ the hull as authored before these knobs existed. */
export const DEFAULT_COMBAT_MULT = 1;

const combatMultiplier = z.number().min(COMBAT_MULT_MIN).max(COMBAT_MULT_MAX);

/**
 * ROLE PROFILE — the hull-level combat multipliers that let two ships with the
 * same modules fly as a kinetic brawler and an energy sniper (owner request
 * 2026-08-21). The counterpart to `hull.resists`: resists say what a hull
 * SURVIVES, this says what it DELIVERS.
 *
 * Every field is optional and every absent field is exactly 1, so a hull that
 * authors none of this is bit-identical to the pre-feature sim. All of them
 * feed the stat resolver as ordinary core stats, which means upgrade tracks and
 * module passives can move them too (`combat.damageOutput.kinetic`, …).
 */
export const shipCombat = z.object({
  /**
   * Multiplier on damage this hull DEALS, per LEAF damage type. A `hybrid`
   * weapon is not listed because it has no damage of its own: the pipeline
   * splits it into its kinetic and energy shares and each share is scaled by
   * the entry for its own leaf, so a kinetic-specialist hull gets its bonus on
   * exactly the kinetic half of a missile.
   */
  damageOutput: z.object({
    kinetic: combatMultiplier.optional(),
    energy: combatMultiplier.optional(),
  }).strict().optional(),
  /**
   * Multiplier on how FAST this hull's weapons cycle, keyed by the weapon's
   * authored `fire.damageType` — so `hybrid` is the missile/dual-type bucket.
   * Above 1 = faster: the weapon's `fire.cycleTime` is DIVIDED by it. A
   * `continuous` channel has no shot cadence, so the same multiplier scales its
   * damage-per-second instead — the equivalent of firing more often.
   */
  rateOfFire: z.object({
    kinetic: combatMultiplier.optional(),
    energy: combatMultiplier.optional(),
    hybrid: combatMultiplier.optional(),
  }).strict().optional(),
  /**
   * Multiplier on this hull's SHIELD RESERVE — every fitted shield module's own
   * energy tank, both its capacity and the rate it refills at. That is the
   * whole of a shield's staying power in this engine ("a shield holds exactly
   * as long as its tank and comes back exactly as fast as its tank
   * recharges"), and it is deliberately NOT the absorb ratio: the share a
   * shield takes out of a hit belongs to the damage type, not to the hull.
   */
  shieldEfficiency: combatMultiplier.optional(),
}).strict();
export type ShipCombat = z.infer<typeof shipCombat>;

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

import { z } from "zod";
import { baseShape } from "./base.js";
import { damageType, isInternalFamily, moduleFamily, renderRecipe, statOp } from "./common.js";

/** Projectile params. `null` = hitscan/beam; object = travelling ordnance. */
const projectile = z.union([
  z.null(),
  z.object({
    speed: z.number().positive(),
    turnRate: z.number().nonnegative().optional(), // homing (missiles)
    lifetime: z.number().positive(),
  }),
]);

/** Weapon block (laser / kinetic / missile families). */
const fireBlock = z.object({
  /**
   * `held` and legacy `semi` both fire each cycle while the trigger is down;
   * `continuous` CHANNELS — no discrete shots at all, damage is
   * applied every tick for as long as the trigger is held and the lock / range /
   * LoS gates pass (COMBAT-REWORK.md §3.3-§3.4 apply unchanged).
   */
  mode: z.enum(["held", "semi", "continuous"]),
  range: z.number().positive(),
  /**
   * Seconds between shots. **Ignored for `continuous`** — a channel has no shot
   * cadence and never sets `cycleTimer` — but still REQUIRED so the field stays a
   * plain `z.number()` for SchemaFormGen and so every consumer that reads it
   * (`ModuleButtons`' cooldown ring, bot discipline, the Module editor) keeps a
   * defined number. Author a small positive placeholder on continuous modules.
   */
  cycleTime: z.number().positive(),
  /**
   * Damage per shot for `held`/`semi`. For `continuous` this is **damage per
   * SECOND** (DPS): the sim applies `damage * dt` on every tick the module
   * channels, so a 30 Hz and a 60 Hz tick deal identical damage over the same
   * wall time.
   */
  damage: z.number().nonnegative(),
  damageType,
  requiresLineOfSight: z.boolean(),
  projectile,
  /** Optional magazine for discrete weapons. Omit to preserve unlimited ammunition. */
  clip: z.object({
    size: z.number().int().min(20).max(50),
    reloadSec: z.number().min(1).max(3),
  }).optional(),
});

/**
 * Active mitigation block (shield family). The shield's RESERVE is its own
 * {@link energyBlock} (energy overhaul 2026-08-07): every point of damage
 * it soaks costs a point of module energy, so a shield holds exactly as long as
 * its tank does and comes back exactly as fast as its tank recharges.
 */
const mitigationBlock = z.object({
  damageReduction: z.number().min(0).max(1),
  coversFamilies: z.array(damageType).optional(),
  /**
   * Seconds a COLLAPSED shield stays down before it can be raised again. A
   * shield collapses when its reserve empties — whether fire drained it (stage 2
   * of the damage pipeline) or its own upkeep did — and both routes are the same
   * flameout in EnergySystem, so both pay this.
   *
   * The range is enforced rather than advisory. Below ~5 s a collapse is a
   * stutter the pilot rides out with a second tap and the shield stops being a
   * resource; above ~15 s one bad trade removes the module for the rest of a
   * typical engagement. 8 s is the shipped default: long enough that dropping a
   * bubble is a decision, short enough to come back inside one fight.
   *
   * Note this is a floor on top of `energy.rearmAbove`, not a replacement — a
   * shield off cooldown still needs its tank back over the rearm fraction.
   */
  collapseCooldownSec: z.number().min(5).max(15).default(8),
});

/**
 * Afterburner block. Since 2026-07-31 this rides on an ENGINE internal rather
 * than its own hardpoint: whether a hull can boost at all is a property of the
 * engine fitted to it, and the base engine deliberately omits this block.
 *
 * Boost's binding resource is its own ENERGY tank (the BOOST button's ring), so
 * a boost-carrying module must author an {@link energyBlock}; it generates no
 * energy at all.
 */
const boostBlock = z.object({
  speedMult: z.number().min(1),
});

/**
 * Per-module ENERGY store (energy overhaul 2026-08-07). There is no shared
 * capacitor: a boost tank, a shield reserve and an active utility each own their
 * own charge, drain it only while they WORK, and refill only while they rest.
 *
 * Weapons deliberately have no energy block at all — `fire.cycleTime` is their
 * only limiter (heat deleted 2026-08-20).
 */
const energyBlock = z.object({
  /** Full charge of this module's own tank. */
  capacity: z.number().positive(),
  /** Refill per second while the module is NOT working, before `recharge.multiplier`. */
  rechargePerSec: z.number().nonnegative(),
  /** Drain per second while the module IS working, before `efficiency.energyDraw`. */
  drawPerSec: z.number().nonnegative(),
  /**
   * Fraction of `capacity` the tank must hold before the module can be brought
   * UP again — the hysteresis that stops a module chattering on an empty tank. A
   * flameout therefore costs a real beat instead of stuttering one tick of boost
   * per three ticks of trickle-charge.
   */
  rearmAbove: z.number().min(0).max(1).default(0.25),
});

/**
 * A generator's ship-wide contribution: every fitted module's `rechargePerSec`
 * is multiplied by this (multiplicative across fitted generators).
 */
const rechargeBlock = z.object({ multiplier: z.number().positive() });

/**
 * Jettison block (countermeasure family). The pod is blown clear of the hull and
 * becomes a DECOY: enemy auto-lock prefers it, and homing missiles already in
 * flight re-seek it (see ProjectileSystem). It is the only counter to a missile
 * that has already left the rail.
 *
 * Costs `cooldownSec` before the launcher has reloaded. A pod without the block
 * can never do this.
 */
const jettisonBlock = z.object({
  /** Seconds before this sink can be jettisoned again. */
  cooldownSec: z.number().positive(),
  /** How long the dropped sink survives as a lure. */
  decoyLifetimeSec: z.number().positive(),
  /** Collider/lock radius of the dropped sink. */
  decoyRadius: z.number().positive().default(1.2),
});

const moduleObject = z.object({
  ...baseShape("module"),
  family: moduleFamily,
  level: z.number().int().positive(),
  /**
   * Optional module visual. Omitted preserves the automatic
   * `procedural.module.<family>` placeholder used by existing content.
   *
   * GLB convention matches ships: export forward as -Y in Blender (which
   * imports as +Z in engine space), normalize the asset to one unit of forward
   * extent, then use `modelScale` for its world size. `modelRotationY` is a
   * radians yaw correction. Fully metallic PBR materials are clamped by the
   * engine so they remain lit without an environment map.
   */
  render: renderRecipe.optional(),
  activation: z.object({
    deployTime: z.number().nonnegative(),
    retractTime: z.number().nonnegative(),
  }),
  /** This module's own energy tank; omitted ⇒ the module needs no energy. */
  energy: energyBlock.optional(),
  /**
   * POWER RAIL draw (owner 2026-07-31) — how much of the hull's instantaneous
   * current this module occupies WHILE ACTIVE, independent of the energy it
   * drains from the capacitor over time.
   *
   * This is what makes two big lasers mutually exclusive on a hull whose
   * transformer cannot feed both: you may fit them, but bringing one up takes
   * the other down. Distinct from the module's own {@link energyBlock} tank,
   * which is charge spent over time. Omitted ⇒ 0, i.e. the module is always
   * compatible with everything (internals and utilities).
   */
  power: z.object({ draw: z.number().nonnegative() }).optional(),
  /** Generator-only: ship-wide energy-recharge multiplier. */
  recharge: rechargeBlock.optional(),
  // Optional per-family behavior blocks, interpreted generically by ModuleSystem.
  fire: fireBlock.optional(),
  mitigation: mitigationBlock.optional(),
  boost: boostBlock.optional(),
  jettison: jettisonBlock.optional(),
  /**
   * Passive stat modifiers a fitted module applies to the ship's resolved core
   * (utility modules: battery, armour plating, …). Ops feed the stat
   * resolver after upgrade levels, in add→mul→clamp order. Purely additive to
   * the schema — weapons/shields simply omit it.
   */
  passives: z.array(statOp).optional(),
  // Action-id hooks dispatched by the module state machine.
  onFire: z.array(z.string()).optional(),
  onActivate: z.array(z.string()).optional(),
  onDeactivate: z.array(z.string()).optional(),
  ui: z.object({
    /**
     * Author-facing icon reference. Carries the tagged placeholder form
     * (`[ICON: laser]`) until a real glyph exists, exactly like `[SOUND: …]` —
     * the client strips the tag and looks the bare id up in its inline SVG set
     * (`client/src/game/hud/moduleIcons.ts`).
     */
    icon: z.string(),
    /**
     * Explicit icon-set id, overriding whatever `icon` and `family` would
     * resolve to. Set it when a module wants a sibling family's glyph (a
     * kinetic-family flak launcher drawn as a missile, say) without inventing a
     * new placeholder string. An id the client does not ship falls back to the
     * generic module glyph — never to an empty button.
     */
    iconId: z.string().optional(),
    /**
     * Short name shown on the HUD; falls back to the module's name truncated.
     */
    shortName: z.string().min(1).max(12).optional(),
    label: z.string(),
  }),
  price: z.number().int().nonnegative(),
  requiresLevel: z.number().int().positive(),
});

/**
 * Module config. Wrapped in a `superRefine` (same pattern as `shipSchema`, so
 * SchemaFormGen still renders every field — the effect adds no new shapes) to
 * reject the one authorable combination the sim cannot interpret: a
 * `continuous` weapon has no discrete shot to launch ordnance with, so it must
 * be hitscan (`projectile: null`).
 */
export const moduleSchema = moduleObject.superRefine((mod, ctx) => {
  if (mod.fire?.mode === "continuous" && mod.fire.projectile !== null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "fire.mode 'continuous' requires fire.projectile: null (a channel is hitscan, it launches nothing)",
      path: ["fire", "projectile"],
    });
  }
  if (mod.fire?.mode === "continuous" && mod.fire.clip) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "fire.mode 'continuous' cannot use a clip (a channel has no discrete rounds)",
      path: ["fire", "clip"],
    });
  }
  // A weapon's ONLY limiter is its cycle time. Energy belongs to the tanks
  // (boost, shields, active utilities), and a weapon that drained one would be
  // an upkeep cost under another name — which is the thing that was removed.
  if (mod.fire && mod.energy) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "weapons cost no energy — a weapon is limited by fire.cycleTime alone",
      path: ["energy"],
    });
  }
  if (mod.mitigation && !mod.energy) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "a shield's reserve IS its energy tank — author an energy block",
      path: ["energy"],
    });
  }
  if (mod.boost && !mod.energy) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "boost runs off its own tank — author an energy block",
      path: ["energy"],
    });
  }
  if (mod.recharge && mod.family !== "generator") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "only a generator sets the ship-wide recharge multiplier",
      path: ["recharge"],
    });
  }
  // Internals are always-on systems, not deployables: the sim spawns them
  // `active` and never runs their state machine, so an authored deploy time
  // would silently do nothing. Fail loudly instead of lying to the author.
  if (isInternalFamily(mod.family) && (mod.activation.deployTime > 0 || mod.activation.retractTime > 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `internal family '${mod.family}' is always on — activation.deployTime/retractTime must be 0`,
      path: ["activation"],
    });
  }
  // The rail is a HARDPOINT budget. Internals have no toggle, so a draw on one
  // could only ever mean a bay that shuts itself off — and the transformer that
  // *feeds* the rail is itself an internal.
  if (mod.power && isInternalFamily(mod.family)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `internal family '${mod.family}' does not draw on the power rail — the rail is a hardpoint budget`,
      path: ["power"],
    });
  }
  if (mod.jettison && mod.family !== "countermeasure") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "only a countermeasure pod can be jettisoned",
      path: ["jettison"],
    });
  }
  if (mod.boost && mod.family !== "engine" && mod.family !== "boost") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "a boost block belongs to the engine that provides it",
      path: ["boost"],
    });
  }
});

export type ModuleConfig = z.infer<typeof moduleSchema>;

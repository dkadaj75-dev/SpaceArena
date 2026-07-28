import { z } from "zod";
import { baseShape } from "./base.js";
import { damageType, moduleFamily, renderRecipe, statOp } from "./common.js";

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
   * `held` fires each cycle while the trigger is down; `semi` latches one shot
   * per press; `continuous` CHANNELS — no discrete shots at all, damage is
   * applied every tick for as long as the trigger is held and the lock / range /
   * LoS / energy gates pass (COMBAT-REWORK.md §3.3-§3.4 apply unchanged).
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
  /**
   * Extra heat applied on the tick a shot fires. Absent preserves existing heat
   * exactly. **Not applied by `continuous`**, which has no shot tick — a channel
   * pays `heat.perSecondActive * dt` every tick it works, which is the whole
   * per-second cost model already.
   */
  heatPerShot: z.number().nonnegative().optional(),
});

/** Active mitigation block (shield family). */
const mitigationBlock = z.object({
  damageReduction: z.number().min(0).max(1),
  absorbPerSecond: z.number().nonnegative().optional(),
  coversFamilies: z.array(damageType).optional(),
});

/** Afterburner block (boost family). */
const boostBlock = z.object({
  speedMult: z.number().min(1),
  heatPerSec: z.number().nonnegative(),
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
  energy: z.object({
    drawIdle: z.number().nonnegative(),
    drawActive: z.number().nonnegative(),
  }),
  heat: z.object({
    perSecondActive: z.number().nonnegative(),
    overheatThreshold: z.number().positive(),
    overheatCooldown: z.number().nonnegative(),
    overheatSelfDamage: z.number().nonnegative(),
  }),
  // Optional per-family behavior blocks, interpreted generically by ModuleSystem.
  fire: fireBlock.optional(),
  mitigation: mitigationBlock.optional(),
  boost: boostBlock.optional(),
  /**
   * Passive stat modifiers a fitted module applies to the ship's resolved core
   * (utility modules: capacitor battery, heat sink, …). Ops feed the stat
   * resolver after upgrade levels, in add→mul→clamp order. Purely additive to
   * the schema — weapons/shields simply omit it.
   */
  passives: z.array(statOp).optional(),
  // Action-id hooks dispatched by the module state machine.
  onFire: z.array(z.string()).optional(),
  onOverheat: z.array(z.string()).optional(),
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
});

export type ModuleConfig = z.infer<typeof moduleSchema>;

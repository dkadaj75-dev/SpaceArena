import { z } from "zod";
import { baseShape } from "./base.js";
import { damageType, moduleFamily, statOp } from "./common.js";

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
  mode: z.enum(["autoTarget"]),
  range: z.number().positive(),
  cycleTime: z.number().positive(),
  damage: z.number().nonnegative(),
  damageType,
  requiresLineOfSight: z.boolean(),
  projectile,
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

export const moduleSchema = z.object({
  ...baseShape("module"),
  family: moduleFamily,
  level: z.number().int().positive(),
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
    label: z.string(),
  }),
  price: z.number().int().nonnegative(),
  requiresLevel: z.number().int().positive(),
});

export type ModuleConfig = z.infer<typeof moduleSchema>;

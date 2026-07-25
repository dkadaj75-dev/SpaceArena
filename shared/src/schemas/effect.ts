import { z } from "zod";
import { baseShape } from "./base.js";

/**
 * Particle-effect config (`content/effects/*.json`, ids `fx.*`). A flat tunable
 * bag the client maps straight onto a Babylon `ParticleSystem`. Emitter sockets
 * reference an effect by id and drive its numeric fields at runtime through
 * signal bindings — every numeric field is bindable by name via `params`.
 */
const effectBase = z.object({
  /** Max simultaneous particles (Babylon capacity). */
  capacity: z.number().int().positive(),
  /** Particles emitted per second (baseline; often driven by `throttle`). */
  emitRate: z.number().nonnegative(),
  lifeMin: z.number().nonnegative(),
  lifeMax: z.number().nonnegative(),
  sizeMin: z.number().nonnegative(),
  sizeMax: z.number().nonnegative(),
  speedMin: z.number().nonnegative(),
  speedMax: z.number().nonnegative(),
  /** Hex colors for the particle gradient endpoints. */
  color1: z.string(),
  color2: z.string(),
  /** Optional emission direction (local space). */
  direction: z.tuple([z.number(), z.number(), z.number()]).optional(),
  /** Optional constant gravity along -Y. */
  gravity: z.number().optional(),
});
export type EffectBase = z.infer<typeof effectBase>;

export const effectSchema = z.object({
  ...baseShape("effect"),
  base: effectBase,
  /**
   * Optional sound id played with this effect (5.7) — `explosion_ship` or the
   * placeholder form `[SOUND: explosion_ship]`. One-shot effects (explosion
   * variants) own their audio here so a new variant is a content file, never a
   * code change; continuous emitter effects normally omit it.
   */
  sound: z.string().min(1).optional(),
  /**
   * Names of `base` fields an emitter binding may target. Authors declare the
   * bindable surface explicitly; validation of a binding's `param` against this
   * list is a renderer/editor concern (kept as data here).
   */
  params: z.array(z.string()),
});

export type EffectConfig = z.infer<typeof effectSchema>;

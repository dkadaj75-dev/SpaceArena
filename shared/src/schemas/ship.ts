import { z } from "zod";
import { baseShape } from "./base.js";
import { collider, moduleFamily, renderRecipe, resists } from "./common.js";

const shipCore = z.object({
  hull: z.object({
    base: z.number().positive(),
    resists,
  }),
  engine: z.object({
    nominalSpeed: z.number().positive(),
    accel: z.number().positive(),
    turnRate: z.number().positive(),
  }),
  energy: z.object({
    capacitor: z.number().positive(),
    regen: z.number().nonnegative(),
  }),
  heat: z.object({
    capacity: z.number().positive(),
    dissipation: z.number().nonnegative(),
    criticalDamagePerSec: z.number().nonnegative(),
  }),
});

const hardpoint = z.object({
  id: z.string(),
  /** Module families this hardpoint accepts. Plain family strings, not ids. */
  accepts: z.array(moduleFamily).min(1),
});

export const shipSchema = z.object({
  ...baseShape("ship"),
  class: z.string(),
  core: shipCore,
  /** Upgrade track ids (`upgrade.*`), one per core track. */
  upgradeTracks: z.object({
    hull: z.string(),
    engine: z.string(),
    energy: z.string(),
    heat: z.string(),
  }),
  hardpoints: z.array(hardpoint).min(1),
  /** Module ids fitted by default, in hardpoint order. */
  defaultFitting: z.array(z.string()),
  render: renderRecipe,
  collider,
});

export type ShipConfig = z.infer<typeof shipSchema>;

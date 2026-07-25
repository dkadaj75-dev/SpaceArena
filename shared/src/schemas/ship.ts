import { z } from "zod";
import { baseShape } from "./base.js";
import { collider, renderRecipe, resists } from "./common.js";
import { hardpointSocket, socketSchema, type HardpointSocket, type SocketConfig } from "./socket.js";

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
  /**
   * Sensor suite (FLIGHT.md §2). Drives the heading-relative lock cone every
   * weapon fires through, so it is a per-ship stat like engine or heat — and it
   * goes through the resolver, which is what lets modules/upgrades move it.
   * Keep `lockRange` at or above the longest weapon range the hull can fit, or
   * range (not lock) becomes the binding constraint on reach.
   */
  sensors: z.object({
    /** Max distance at which an enemy can be locked (world units). */
    lockRange: z.number().positive(),
    /** Seconds of continuous in-cone tracking needed for a full lock. */
    lockTimeSec: z.number().positive(),
    /** FULL cone width in degrees; the half-angle used by the sim is coneDeg/2. */
    coneDeg: z.number().positive(),
  }),
});

export const shipSchema = z
  .object({
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
    /**
     * Socket graph (replaces the old flat `hardpoints[]`). Hardpoint sockets are
     * module attachment points; emitter sockets bind particle effects to runtime
     * signals. Nothing about socket count/placement is hardcoded — the sim derives
     * the ordered hardpoint list via {@link hardpointsOf}.
     *
     * MIGRATION: the Nth `kind: "hardpoint"` socket (in array order) IS hardpoint
     * index N, so `defaultFitting` stays positional in hardpoint order and existing
     * DB fittings keep their indices.
     */
    sockets: z.array(socketSchema).min(1),
    /** Module ids fitted by default, in hardpoint order. */
    defaultFitting: z.array(z.string()),
    render: renderRecipe,
    collider,
  })
  .superRefine((ship, ctx) => {
    const ids = new Set<string>();
    for (const s of ship.sockets) {
      if (ids.has(s.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate socket id: ${s.id}`, path: ["sockets"] });
      }
      ids.add(s.id);
    }
    if (!ship.sockets.some((s) => s.kind === "hardpoint")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "ship must have at least one hardpoint socket", path: ["sockets"] });
    }
  });

export type ShipConfig = z.infer<typeof shipSchema>;

/**
 * The ship's hardpoint sockets in array order. **This ordered list defines
 * `hardpointIndex`**: element `i` is the module attachment point addressed by
 * hardpoint index `i` throughout the sim, fitting validation, seeding, and the
 * netcode. All code that used to read `ship.hardpoints` reads this instead.
 */
export function hardpointsOf(ship: ShipConfig): HardpointSocket[] {
  return ship.sockets.filter((s): s is HardpointSocket => s.kind === "hardpoint");
}

/** Every emitter socket on a ship, in array order. */
export function emittersOf(ship: ShipConfig): Extract<SocketConfig, { kind: "emitter" }>[] {
  return ship.sockets.filter((s): s is Extract<SocketConfig, { kind: "emitter" }> => s.kind === "emitter");
}

// Re-export the socket-kind schemas so consumers can `import { hardpointSocket }`
// from the ship module if they prefer; the canonical home is ./socket.ts.
export { hardpointSocket };

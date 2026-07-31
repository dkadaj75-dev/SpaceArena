import { z } from "zod";
import { baseShape } from "./base.js";
import { collider, renderRecipe, resists } from "./common.js";
import {
  hardpointSocket,
  socketSchema,
  type FittableSocket,
  type HardpointSocket,
  type InternalSocket,
  type SocketConfig,
} from "./socket.js";

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
   * POWER RAIL capacity (owner 2026-07-31) — the second energy axis, and the
   * one that decides what can be online AT ONCE.
   *
   * Think voltage vs amperage. `energy.capacitor` is the reservoir a module
   * drains over time; this is the instantaneous current the hull can deliver.
   * Every active hardpoint module occupies its `power.draw` while it is up, and
   * the total may never exceed this. Most of it comes from the fitted
   * TRANSFORMER, so choosing one is choosing how much you can run together.
   *
   * A fitting whose modules sum past this is still legal to build — the Hangar
   * warns — it simply cannot have them all online simultaneously.
   */
  power: z
    .object({ capacity: z.number().nonnegative().default(0) })
    .default({ capacity: 0 }),
  /**
   * Ship-wide efficiency multipliers (owner 2026-07-31), the TRANSFORMER's
   * lever: `energyDrawMult` scales every module's energy draw and `heatGenMult`
   * scales every module's heat generation. Both default to 1 (the hull as
   * authored) and are moved by the fitted transformer's passives, so a good one
   * makes the whole loadout cheaper to run while a cheap one taxes it.
   */
  efficiency: z
    .object({
      energyDraw: z.number().nonnegative().default(1),
      heatGen: z.number().nonnegative().default(1),
    })
    .default({ energyDraw: 1, heatGen: 1 }),
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
 * The ship's FITTABLE sockets — hardpoints and internals alike — in array
 * order. **This ordered list defines the module slot index**: element `i` is the
 * attachment point addressed by index `i` throughout the sim, fitting
 * validation, seeding and the netcode, and a fitting is one positional array
 * over it.
 *
 * Internals joined this list rather than getting an index space of their own
 * (owner 2026-07-31) precisely so none of that had to change: a ship's systems
 * bay is just more slots, distinguished by `kind` where the distinction matters
 * (the HUD shows buttons only for hardpoints).
 *
 * The runtime field is still called `hardpointIndex` — it is the wire name and
 * the DB's `hardpointMap` key, so renaming it would be a migration for no
 * behavioural gain.
 */
export function hardpointsOf(ship: ShipConfig): FittableSocket[] {
  return ship.sockets.filter((s): s is FittableSocket => s.kind === "hardpoint" || s.kind === "internal");
}

/** Only the weapon/shield sockets, in fitted-slot order. */
export function weaponHardpointsOf(ship: ShipConfig): HardpointSocket[] {
  return ship.sockets.filter((s): s is HardpointSocket => s.kind === "hardpoint");
}

/** Only the systems-bay sockets, in fitted-slot order. */
export function internalsOf(ship: ShipConfig): InternalSocket[] {
  return ship.sockets.filter((s): s is InternalSocket => s.kind === "internal");
}

/**
 * Fitted-slot index → whether that slot is an internal. Handy for the many
 * callers that hold an index (a `ModuleRuntime`, a HUD entry) rather than a
 * socket.
 */
export function isInternalSlot(ship: ShipConfig, slotIndex: number): boolean {
  return hardpointsOf(ship)[slotIndex]?.kind === "internal";
}

/** Every emitter socket on a ship, in array order. */
export function emittersOf(ship: ShipConfig): Extract<SocketConfig, { kind: "emitter" }>[] {
  return ship.sockets.filter((s): s is Extract<SocketConfig, { kind: "emitter" }> => s.kind === "emitter");
}

// Re-export the socket-kind schemas so consumers can `import { hardpointSocket }`
// from the ship module if they prefer; the canonical home is ./socket.ts.
export { hardpointSocket };

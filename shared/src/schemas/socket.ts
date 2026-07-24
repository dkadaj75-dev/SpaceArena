import { z } from "zod";
import { moduleFamily } from "./common.js";

/**
 * Runtime signal ids an emitter socket can bind to. Each id names a scalar that
 * {@link import("../sim/signals.js").SIGNAL_REGISTRY} computes as a pure function
 * of a ship snapshot (and optionally the previous snapshot).
 *
 * The zod enum lives here (schema layer) rather than in `shared/src/sim` so the
 * socket schema can reference it without a schemas → sim import cycle (sim
 * already imports schemas). `shared/src/sim/signals.ts` re-exports `SignalId`
 * and owns the actual compute functions. **Adding a signal = one entry here plus
 * one registry entry there.**
 */
export const signalId = z.enum([
  "throttle",
  "boostActive",
  "hullFraction",
  "shieldActive",
  "heatFraction",
  "firing",
  "speedFraction",
]);
export type SignalId = z.infer<typeof signalId>;

/**
 * A 3D transform relative to the ship hull origin. `pos` is required; `rot`
 * (euler radians XYZ) and uniform `scale` are optional. This is the pose the
 * renderer applies when attaching a module model or particle emitter.
 */
export const socketTransform = z.object({
  pos: z.tuple([z.number(), z.number(), z.number()]),
  rot: z.tuple([z.number(), z.number(), z.number()]).optional(),
  scale: z.number().positive().optional(),
});
export type SocketTransform = z.infer<typeof socketTransform>;

/**
 * A piecewise-linear response point `[input, output]`. A binding curve is an
 * array of these; input is clamped to the curve's domain before interpolation
 * (see {@link import("../sim/signals.js").evalCurve}). Points may ascend OR
 * descend in input (e.g. hull-fraction curves run 1 → 0), so the curve is
 * treated as a polyline in array order.
 */
export const curvePoint = z.tuple([z.number(), z.number()]);

/** One emitter binding: drive `param` of the effect from `source` via `curve`. */
export const emitterBinding = z.object({
  source: signalId,
  /** Name of the effect param this binding writes (must be in the effect's `params`). */
  param: z.string().min(1),
  curve: z.array(curvePoint).min(1),
});
export type EmitterBinding = z.infer<typeof emitterBinding>;

const socketBase = {
  /** Unique within the ship. */
  id: z.string().min(1),
  transform: socketTransform,
};

/**
 * Hardpoint socket — a module attachment point. The ORDER of hardpoint sockets
 * in a ship's `sockets[]` array defines each one's `hardpointIndex` (0-based,
 * counting only `kind: "hardpoint"` entries). The sim/fitting code derives this
 * ordered list via `hardpointsOf(ship)`; never hardcode indices.
 */
export const hardpointSocket = z.object({
  ...socketBase,
  kind: z.literal("hardpoint"),
  accepts: z.array(moduleFamily).min(1),
});
export type HardpointSocket = z.infer<typeof hardpointSocket>;

/**
 * Emitter socket — binds a particle effect (`fx.*`) to runtime signals through
 * per-binding response curves. Pure data: engine trails, damage smoke, overheat
 * venting are all just emitter sockets with different effects + bindings.
 */
export const emitterSocket = z.object({
  ...socketBase,
  kind: z.literal("emitter"),
  /** Effect config id (`fx.*`); resolved as a cross-reference at load. */
  effect: z.string().min(1),
  bindings: z.array(emitterBinding).default([]),
});
export type EmitterSocket = z.infer<typeof emitterSocket>;

/**
 * A ship socket. Discriminated on `kind` so NEW kinds (lights, shield anchors,
 * tow points, …) are added by appending to this union — validation rejects any
 * unknown `kind` loudly, and the renderer dispatches per kind. Nothing about
 * socket count or placement is hardcoded anywhere.
 */
export const socketSchema = z.discriminatedUnion("kind", [hardpointSocket, emitterSocket]);
export type SocketConfig = z.infer<typeof socketSchema>;

import { signalId, type SignalId } from "../schemas/socket.js";
import type { ShipSnapshot } from "./ArenaSimulation.js";

// Re-export so consumers can treat `shared/src/sim` as the signal home even
// though the zod enum is authored in the schema layer (avoids a schema→sim cycle).
export { signalId };
export type { SignalId };

/**
 * Signal registry (4.6 ⭐). Each entry computes one runtime scalar as a **pure
 * function of a ship snapshot** (and optionally the previous snapshot, for
 * motion). Emitter sockets read these through per-binding response curves to
 * drive particle params — engine trails, damage smoke, overheat venting are all
 * pure data on top of this table.
 *
 * The same functions run on the client renderer today and are available to any
 * future server-side effect logic. **Extensible: adding a signal = add its id to
 * `signalId` (schema) and one entry here.**
 *
 * `throttle` reads the snapshot's real commanded throttle (FLIGHT.md §1) — flight
 * orders are the only thing that moves a ship, so this is exactly what the pilot
 * asked for, with no inference.
 *
 * `speedFraction` and `boostActive` deliberately STAY on per-snapshot
 * displacement (FLIGHT.md §7 decision), now measured in 3D (BUBBLE.md §A) so a
 * climbing ship does not read as coasting: they describe *actual* motion, not the
 * command, and nothing in `ShipSnapshot` carries velocity — only position and
 * the commanded throttle travel over the wire. Deriving them from `throttle`
 * would make them lie during the accel ramp, while a rammed ship was bleeding
 * speed, or while boost was requested but denied for want of energy/heat. The
 * displacement basis keeps them dependency-free (no core-stat lookup); the
 * editor's signal simulator can override the normalization later.
 */

/** Reference displacement treated as absolute top speed (boosted). */
export const REFERENCE_TOP_STEP = 2.2;
/** Displacement above this reads as an active afterburner. */
export const BOOST_STEP_THRESHOLD = 1.35;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Distance moved in 3D between the previous and current snapshot (0 if no prev). */
function frameStep(ship: ShipSnapshot, prev?: ShipSnapshot): number {
  if (!prev) return 0;
  const dx = ship.pos.x - prev.pos.x;
  const dy = ship.pos.y - prev.pos.y;
  const dz = ship.pos.z - prev.pos.z;
  return Math.hypot(dx, dy, dz);
}

/** Signal-compute function: pure over (current, previous) snapshot. */
export type SignalFn = (ship: ShipSnapshot, prev?: ShipSnapshot) => number;

export const SIGNAL_REGISTRY: Record<SignalId, SignalFn> = {
  /** Commanded engine output, 0..1 — the pilot's own throttle, verbatim. */
  throttle: (s) => clamp01(s.throttle),
  /** 1 while moving fast enough to imply afterburner, else 0 (measured, see above). */
  boostActive: (s, p) => (frameStep(s, p) > BOOST_STEP_THRESHOLD ? 1 : 0),
  /** Remaining hull as a fraction of max, 0..1. */
  hullFraction: (s) => (s.hullMax > 0 ? clamp01(s.hull / s.hullMax) : 0),
  /** 1 while any shield module has an absorb reservoir, else 0. */
  shieldActive: (s) => (s.modules.some((m) => m.shieldPool > 0) ? 1 : 0),
  /** Current heat as a fraction of capacity, 0..1. */
  heatFraction: (s) => (s.heat.capacity > 0 ? clamp01(s.heat.cur / s.heat.capacity) : 0),
  /**
   * 1 while any active module is mid weapon cycle (a proxy for firing) OR is
   * channelling a continuous beam — which never uses a cycle timer and would
   * otherwise read as permanently silent — else 0.
   */
  firing: (s) => (s.modules.some((m) => m.state === "active" && (m.cycleTimer > 0 || m.channeling)) ? 1 : 0),
  /** Absolute speed as a fraction of a reference top speed, 0..1. */
  speedFraction: (s, p) => clamp01(frameStep(s, p) / REFERENCE_TOP_STEP),
};

/** Evaluate one signal by id. */
export function evalSignal(id: SignalId, ship: ShipSnapshot, prev?: ShipSnapshot): number {
  return SIGNAL_REGISTRY[id](ship, prev);
}

/**
 * Evaluate a piecewise-linear response curve at `x`. The curve is a polyline in
 * array order; `x` is clamped to the curve's input domain, then interpolated on
 * the segment whose endpoints bracket it. Handles ascending AND descending input
 * (hull-fraction curves run high → low). Empty curves return 0; single-point
 * curves return that point's output.
 */
export function evalCurve(curve: readonly (readonly [number, number])[], x: number): number {
  if (curve.length === 0) return 0;
  if (curve.length === 1) return curve[0]![1];

  // Clamp x to the domain spanned by the points.
  let minX = Infinity;
  let maxX = -Infinity;
  for (const [px] of curve) {
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
  }
  const cx = x < minX ? minX : x > maxX ? maxX : x;

  // Walk consecutive segments; interpolate where cx falls between endpoints.
  for (let i = 0; i < curve.length - 1; i++) {
    const [ax, ay] = curve[i]!;
    const [bx, by] = curve[i + 1]!;
    const lo = Math.min(ax, bx);
    const hi = Math.max(ax, bx);
    if (cx >= lo && cx <= hi) {
      if (bx === ax) return by; // vertical segment: take the later point
      const t = (cx - ax) / (bx - ax);
      return ay + (by - ay) * t;
    }
  }
  // cx exactly at (or beyond, though clamped) the last vertex.
  return curve[curve.length - 1]![1];
}

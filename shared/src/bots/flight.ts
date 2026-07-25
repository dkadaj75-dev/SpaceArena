// A bot's aim points are plain planar coordinates — the same `Vec2` the content
// schemas and snapshots use, deliberately not a bots-local re-declaration.
import type { Vec2 } from "../schemas/common.js";
import { angleDelta, clamp, headingOf } from "../sim/math.js";
import type { LosCircle } from "../sim/los.js";

/** World bearing from `from` to `to` — same convention as `Transform2D.heading`. */
export function bearing(from: Vec2, to: Vec2): number {
  return headingOf(to.x - from.x, to.z - from.z);
}

/** Point at `radius` from `origin` on the bearing `angle`. */
export function pointOnRing(origin: Vec2, angle: number, radius: number): Vec2 {
  return { x: origin.x + Math.cos(angle) * radius, z: origin.z + Math.sin(angle) * radius };
}

/**
 * **The flight-model core primitive** (FLIGHT.md §1/§7) — the turn axis a pilot
 * must hold for `horizonSec` to bring `heading` onto `desired`, given the ship's
 * `turnRate` (rad/s). This is the flight equivalent of "plan a move point": every
 * behaviour expresses intent as a heading (or a point, see {@link turnForPoint})
 * and this converts it into the `turn` field of a `flight` order.
 *
 * Proportional, not bang-bang, and that is the whole point. A `flight` order is
 * level-triggered: whatever the bot sends is integrated every tick until the next
 * decision, so full deflection held for one decision interval rotates the hull by
 * `turnRate * interval` — far past the target on a small correction, which is
 * exactly the oscillation that stops a bot from ever completing a lock. Scaling by
 * the rotation the horizon can buy lands the nose on `desired` at the moment the
 * next decision is taken, and the residual error each interval is only the target's
 * bearing drift. Nose-on discipline is what fills `lockProgress`.
 *
 * `toleranceRad` centres the stick once the nose is close enough, so an aligned bot
 * emits no further turn traffic (and drifts nowhere).
 *
 * `turnRate <= 0` means "unknown" (a driver that has not calibrated itself yet):
 * fall back to full deflection in the right direction, which is correct-but-coarse
 * for exactly one decision.
 */
export function turnForHeading(
  heading: number,
  desired: number,
  turnRate: number,
  horizonSec: number,
  toleranceRad = 0,
): number {
  const delta = angleDelta(heading, desired);
  if (Math.abs(delta) <= toleranceRad) return 0;
  const span = turnRate * horizonSec;
  if (!(span > 0)) return delta > 0 ? 1 : -1;
  return clamp(delta / span, -1, 1);
}

/** {@link turnForHeading} against a world point — "fly to this point, nose first". */
export function turnForPoint(
  pos: Vec2,
  heading: number,
  aim: Vec2,
  turnRate: number,
  horizonSec: number,
  toleranceRad = 0,
): number {
  const dx = aim.x - pos.x;
  const dz = aim.z - pos.z;
  // Co-located: no meaningful bearing, so hold the current heading.
  if (dx === 0 && dz === 0) return 0;
  return turnForHeading(heading, headingOf(dx, dz), turnRate, horizonSec, toleranceRad);
}

/** A blocker sitting in the ship's nose corridor, with the side it lies on. */
export interface NoseBlocker {
  /** Distance along the heading to the blocker's centre. */
  along: number;
  /** Lateral offset magnitude from the corridor centreline. */
  offset: number;
  /** +1 when the blocker is to port of the nose, -1 to starboard (turn this way to clear it). */
  side: 1 | -1;
}

/**
 * Nearest blocker inside the ship's nose corridor: centre within `lookahead`
 * ahead of the nose and within `radius + clearance` of the centreline. The cheap
 * "am I about to fly into a rock" test — flight has no avoidance system, so a bot
 * that wants to keep its hull has to look where it is going.
 *
 * `side` is the sign a `turn` should take to steer *away* from the blocker.
 * Iterates `blockers` in the caller's (snapshot) order and keeps the nearest hit,
 * first-wins on ties, so the result is deterministic.
 */
export function noseBlocker(
  pos: Vec2,
  heading: number,
  blockers: readonly LosCircle[],
  lookahead: number,
  clearance: number,
): NoseBlocker | null {
  if (lookahead <= 0) return null;
  const dirX = Math.cos(heading);
  const dirZ = Math.sin(heading);
  let best: NoseBlocker | null = null;
  for (const b of blockers) {
    const relX = b.pos.x - pos.x;
    const relZ = b.pos.z - pos.z;
    const along = relX * dirX + relZ * dirZ;
    if (along <= 0 || along > lookahead) continue;
    const cross = dirX * relZ - dirZ * relX; // signed lateral offset
    const offset = Math.abs(cross);
    if (offset > b.radius + clearance) continue;
    if (best !== null && along >= best.along) continue;
    best = { along, offset, side: cross >= 0 ? -1 : 1 };
  }
  return best;
}

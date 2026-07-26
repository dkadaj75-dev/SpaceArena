// A bot's aim points are bubble coordinates — the same `Vec3` the content
// schemas and snapshots use, deliberately not a bots-local re-declaration. `y`
// is optional there (a flat arena omits it), so every read goes through `?? 0`.
import type { Vec3 } from "../schemas/common.js";
import { angleDelta, clamp, facingVec, headingOf, len, pitchOf } from "../sim/math.js";
import type { LosCircle } from "../sim/los.js";

/**
 * A 3D bearing decomposed the way the sim's orientation model is (BUBBLE.md §A):
 * a wrapping `yaw` plus a non-wrapping `pitch` elevation. This decomposition IS
 * the bots' 3D steering: the two axes are independent in the integrator
 * (`heading += turn·turnRate·dt`, `pitch += pitchStick·pitchRate·dt`), so a 3D
 * bearing needs no quaternion — one proportional rule per axis.
 *
 * Straight up or straight down has no meaningful yaw (`atan2(0,0)` answers 0,
 * which would read as "+x"), so callers must consult {@link Bearing3.planar}
 * before steering the yaw axis. {@link steerForPoint} does exactly that.
 */
export interface Bearing3 {
  yaw: number;
  pitch: number;
  /** Horizontal (x,z) separation; 0 ⇒ `yaw` is meaningless, hold the nose. */
  planar: number;
}

export function bearing3(from: Vec3, to: Vec3): Bearing3 {
  const dx = to.x - from.x;
  const dy = (to.y ?? 0) - (from.y ?? 0);
  const dz = to.z - from.z;
  return { yaw: headingOf(dx, dz), pitch: pitchOf(dx, dy, dz), planar: len(dx, dz) };
}

/** Steepest elevation the spherical parametrisation below stays injective on. */
const VERTICAL = Math.PI / 2;

/**
 * Point at `radius` from `origin` along the 3D bearing (`yaw`, `pitch`) — the
 * bubble version of {@link pointOnRing}. Uses the sim's own facing convention,
 * `(cos p·cos h, sin p, cos p·sin h)`, so a point placed here is exactly where a
 * ship holding that attitude would fly.
 *
 * `pitch` is clamped to ±PI/2 because past vertical `cos p` goes negative and the
 * point silently lands on the OPPOSITE yaw — a real hazard for the callers that
 * add an offset to a measured elevation (kite's `verticalSlipRad` on an already
 * steep extend bearing would flip the whole extend leg back through the enemy).
 * At exactly ±PI/2 the point is straight up/down and the yaw is irrelevant, which
 * is the honest answer rather than a wrapped one.
 */
export function pointOnSphere(origin: Vec3, yaw: number, pitch: number, radius: number): Required<Vec3> {
  pitch = clamp(pitch, -VERTICAL, VERTICAL);
  const cp = Math.cos(pitch);
  return {
    x: origin.x + cp * Math.cos(yaw) * radius,
    y: (origin.y ?? 0) + Math.sin(pitch) * radius,
    z: origin.z + cp * Math.sin(yaw) * radius,
  };
}

/**
 * Point at `radius` from `origin` on the yaw `angle`, at the origin's own
 * altitude — a level ring, not a ground-plane one. Keeping `y` matters: a bot
 * fighting at y = 40 that aimed at a y = 0 ring point would dive out of the
 * fight every time a behaviour placed a point around it.
 */
export function pointOnRing(origin: Vec3, angle: number, radius: number): Required<Vec3> {
  return pointOnSphere(origin, angle, 0, radius);
}

/**
 * **The flight-model core primitive** (FLIGHT.md §1/§7, BUBBLE.md §D) — the yaw
 * axis a pilot must hold for `horizonSec` to bring `heading` onto `desired`,
 * given the ship's `turnRate` (rad/s). Every behaviour expresses intent as a
 * point and {@link steerForPoint} converts it into the `turn` and `pitchStick`
 * fields of a `flight` order; this is the yaw half of that.
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

/**
 * The pitch half of {@link turnForHeading}: identical proportional-horizon rule
 * on the elevation axis, with ONE difference — pitch does not wrap. It is clamped
 * to ±`tuning.maxPitchRad` so world-up can never flip (BUBBLE.md §A), so the
 * short way round is always the direct difference and `angleDelta` must NOT be
 * used here: it would happily plan a −0.1 rad correction as +6.18 the "short"
 * way once a caller handed it an unclamped desired elevation.
 *
 * `pitchRate` is the hull's pitch rate per unit stick (`turnRate ×
 * tuning.pitchRateMult` in the sim); `<= 0` means "not measured yet" and falls
 * back to full deflection, exactly as the yaw axis does.
 */
export function pitchForElevation(
  pitch: number,
  desired: number,
  pitchRate: number,
  horizonSec: number,
  toleranceRad = 0,
): number {
  const delta = desired - pitch;
  if (Math.abs(delta) <= toleranceRad) return 0;
  const span = pitchRate * horizonSec;
  if (!(span > 0)) return delta > 0 ? 1 : -1;
  return clamp(delta / span, -1, 1);
}

/** Both stick axes of a `flight` order, as the steering primitive produces them. */
export interface Steer3 {
  turn: number;
  pitchStick: number;
}

/** Hull + control-loop constants {@link steerForPoint} needs. */
export interface Steer3Params {
  /** Measured yaw rate per unit stick (rad/s); 0 ⇒ uncalibrated. */
  turnRate: number;
  /** Measured pitch rate per unit stick (rad/s); 0 ⇒ uncalibrated. */
  pitchRate: number;
  /** Seconds the correction is planned over (the driver's decision interval). */
  horizonSec: number;
  /** Error treated as "nose on" — inside it that axis centres (radians). */
  toleranceRad?: number;
  /** The sim's `tuning.maxPitchRad`; desired elevation is clamped into it. */
  maxPitchRad: number;
}

/**
 * "Fly at this point, nose first" in the bubble: decompose the 3D bearing into
 * yaw + pitch ({@link bearing3}) and run the same proportional-horizon rule on
 * each axis. This is what completes a lock against a CLIMBING target — the sim's
 * lock cone is a true 3D cone since T1, so a planar-only nose is off-cone the
 * moment the fight leaves the plane.
 *
 * Two edge cases, both real in a bubble:
 * - **Co-located** — no bearing at all; hold both axes.
 * - **Straight up / straight down** — the yaw of a purely vertical bearing is
 *   meaningless (`planar === 0`), so the yaw axis centres and only the nose
 *   moves. The desired elevation is clamped to ±`maxPitchRad` because the sim
 *   clamps the hull there: a bot asking for the unreachable ±PI/2 would pin the
 *   stick against the clamp forever, spamming a full-deflection axis that can
 *   never null its own error.
 */
export function steerForPoint(
  pos: Vec3,
  heading: number,
  pitch: number,
  aim: Vec3,
  params: Steer3Params,
): Steer3 {
  const dx = aim.x - pos.x;
  const dy = (aim.y ?? 0) - (pos.y ?? 0);
  const dz = aim.z - pos.z;
  const planar = len(dx, dz);
  if (planar === 0 && dy === 0) return { turn: 0, pitchStick: 0 };
  const tolerance = params.toleranceRad ?? 0;
  const limit = Math.abs(params.maxPitchRad);
  const desiredPitch = clamp(pitchOf(dx, dy, dz), -limit, limit);
  return {
    turn: planar > 0 ? turnForHeading(heading, headingOf(dx, dz), params.turnRate, params.horizonSec, tolerance) : 0,
    pitchStick: pitchForElevation(pitch, desiredPitch, params.pitchRate, params.horizonSec, tolerance),
  };
}

/** A blocker sitting in the ship's nose corridor, with the side it lies on. */
export interface NoseBlocker {
  /** Distance along the 3D facing vector to the blocker's centre. */
  along: number;
  /** Perpendicular (3D) offset magnitude from the corridor centreline. */
  offset: number;
  /** +1 when the blocker is to port of the nose, -1 to starboard (turn this way to clear it). */
  side: 1 | -1;
}

/** Scratch facing vector — this runs per decision per bot, so no per-call alloc. */
const noseDir = { x: 0, y: 0, z: 0 };

/**
 * Nearest blocker inside the ship's nose corridor: centre within `lookahead`
 * ahead of the nose and within `radius + clearance` of the centreline. The cheap
 * "am I about to fly into a rock" test — flight has no avoidance system, so a bot
 * that wants to keep its hull has to look where it is going.
 *
 * The corridor is a true 3D cylinder about the facing vector (BUBBLE.md §D): a
 * rock 30 units below a level nose is scenery, not a threat, and the planar test
 * used to swerve off it. The evasion `side` stays a YAW sign — the hull turns
 * faster in yaw than in pitch (`tuning.pitchRateMult` < 1) so yaw is the cheaper
 * way out of a corridor, and it keeps the overlay a single-axis nudge.
 *
 * Iterates `blockers` in the caller's (snapshot) order and keeps the nearest hit,
 * first-wins on ties, so the result is deterministic.
 */
export function noseBlocker(
  pos: Vec3,
  heading: number,
  pitch: number,
  blockers: readonly LosCircle[],
  lookahead: number,
  clearance: number,
): NoseBlocker | null {
  if (lookahead <= 0) return null;
  const dir = facingVec(heading, pitch, noseDir);
  const dirX = dir.x;
  const dirY = dir.y;
  const dirZ = dir.z;
  const yawX = Math.cos(heading);
  const yawZ = Math.sin(heading);
  const posY = pos.y ?? 0;
  let best: NoseBlocker | null = null;
  for (const b of blockers) {
    const relX = b.pos.x - pos.x;
    const relY = (b.pos.y ?? 0) - posY;
    const relZ = b.pos.z - pos.z;
    const along = relX * dirX + relY * dirY + relZ * dirZ;
    if (along <= 0 || along > lookahead) continue;
    const relSq = relX * relX + relY * relY + relZ * relZ;
    const offset = Math.sqrt(Math.max(relSq - along * along, 0));
    if (offset > b.radius + clearance) continue;
    if (best !== null && along >= best.along) continue;
    const cross = yawX * relZ - yawZ * relX; // signed lateral offset in the yaw plane
    best = { along, offset, side: cross >= 0 ? -1 : 1 };
  }
  return best;
}

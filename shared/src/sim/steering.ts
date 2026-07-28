import { advanceAttitude, clamp, len3, type Attitude } from "./math.js";

/** Scratch attitude — the predictor runs per frame, so no per-call allocation. */
const scratchAttitude: Attitude = { heading: 0, pitch: 0 };

/** Minimal kinematic state advanced by {@link flightStep}. Mutated in place. */
export interface SteerState {
  pos: { x: number; y: number; z: number };
  vel: { x: number; y: number; z: number };
  heading: number;
  /** Nose elevation in radians; held state, positive climbs (BUBBLE.md §A). */
  pitch: number;
}

/** Engine knobs the integrator needs (resolved stats, never a raw ship config). */
export interface FlightParams {
  nominalSpeed: number;
  accel: number;
  turnRate: number;
  /** `tuning.pitchRateMult` — pitch rate as a fraction of `turnRate`. */
  pitchRateMult: number;
  /**
   * `tuning.maxPitchRad` — the OPTIONAL legacy clamp on |pitch|. `null` (the
   * shipped case) means pitch is free and wraps, so the ship can loop; a number
   * pins the nose short of vertical the way the pre-loop sim always did.
   */
  maxPitchRad: number | null;
}

/** One tick of pilot input: stick/throttle plus the resolved boost multiplier. */
export interface FlightInput {
  /** 0..1 (clamped here, exactly like the order-apply clamp in NavigationSystem). */
  throttle: number;
  /** -1..1 (clamped here). */
  turn: number;
  /** -1..1 (clamped here). Positive raises the nose. */
  pitchStick: number;
  /** 1 when not boosting; `boost.speedMult` of the active boost module otherwise. */
  boostMult: number;
}

/**
 * One fixed-step of continuous flight (FLIGHT.md §1, extended to 3D by
 * BUBBLE.md §A) — the exact integration NavigationSystem runs for a ship with a
 * FlightState: turn-rate-limited heading and pitch from the sticks, accel-limited
 * approach to `throttle * nominalSpeed * boostMult`, velocity always aligned with
 * the 3D facing direction `(cos p cos h, sin p, cos p sin h)`. No arrival, no
 * avoidance, no auto-level.
 *
 * BOTH attitude axes wrap by default: heading always did, and pitch does too
 * unless a pack authors the legacy `maxPitchRad` clamp. The facing formula above
 * needs no special case for that — past vertical `cos p` simply goes negative and
 * the nose swings through the pole — so a held pitch stick flies a full loop.
 *
 * Yaw is BODY-FRAME ({@link advanceAttitude}): `turn` rotates the nose about the
 * ship's own up, not world Y. At level flight the two are the same thing; the
 * difference grows with pitch and is what makes steering read the same way at
 * every attitude.
 *
 * This is the client-prediction mirror of the sim path; the two are asserted
 * trajectory-identical in `steering.test.ts`. Keep them edited together — the
 * operation order below is load-bearing for bit-identity.
 */
export function flightStep(s: SteerState, input: FlightInput, p: FlightParams, dt: number): void {
  advanceAttitude(
    s.heading,
    s.pitch,
    clamp(input.turn, -1, 1) * p.turnRate * dt,
    clamp(input.pitchStick, -1, 1) * p.turnRate * p.pitchRateMult * dt,
    p.maxPitchRad,
    scratchAttitude,
  );
  s.heading = scratchAttitude.heading;
  s.pitch = scratchAttitude.pitch;

  const desiredSpeed = clamp(input.throttle, 0, 1) * p.nominalSpeed * input.boostMult;
  const curSpeed = len3(s.vel.x, s.vel.y, s.vel.z);
  const accelStep = p.accel * dt;
  const newSpeed =
    curSpeed < desiredSpeed ? Math.min(desiredSpeed, curSpeed + accelStep) : Math.max(desiredSpeed, curSpeed - accelStep);

  const cosPitch = Math.cos(s.pitch);
  s.vel.x = cosPitch * Math.cos(s.heading) * newSpeed;
  s.vel.y = Math.sin(s.pitch) * newSpeed;
  s.vel.z = cosPitch * Math.sin(s.heading) * newSpeed;
  s.pos.x += s.vel.x * dt;
  s.pos.y += s.vel.y * dt;
  s.pos.z += s.vel.z * dt;
}

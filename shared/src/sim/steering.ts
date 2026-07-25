import { clamp, headingOf, len, turnToward, wrapAngle } from "./math.js";

/** Minimal kinematic state advanced by {@link seekStep} / {@link flightStep}. Mutated in place. */
export interface SteerState {
  pos: { x: number; z: number };
  vel: { x: number; z: number };
  heading: number;
}

/** Engine knobs shared by both integrators (resolved stats, never a raw ship config). */
export interface FlightParams {
  nominalSpeed: number;
  accel: number;
  turnRate: number;
}

export interface SteerParams extends FlightParams {
  arrivalRadius: number;
  arrivalStop: number;
  speedMult: number;
}

/** One tick of pilot input: stick/throttle plus the resolved boost multiplier. */
export interface FlightInput {
  /** 0..1 (clamped here, exactly like the order-apply clamp in NavigationSystem). */
  throttle: number;
  /** -1..1 (clamped here). */
  turn: number;
  /** 1 when not boosting; `boost.speedMult` of the active boost module otherwise. */
  boostMult: number;
}

/**
 * One fixed-step of seek + arrival steering toward `target` — the exact
 * integration NavigationSystem performs for an unobstructed ship (no asteroid
 * avoidance). Exists so client-side prediction advances the local player with
 * the same math the server uses; any divergence (avoidance, collisions) is
 * absorbed by the prediction error blend.
 *
 * Returns true when the ship has arrived (caller clears its order).
 */
export function seekStep(s: SteerState, target: { x: number; z: number }, p: SteerParams, dt: number): boolean {
  const dx = target.x - s.pos.x;
  const dz = target.z - s.pos.z;
  const dist = len(dx, dz);

  if (dist <= p.arrivalStop) {
    s.vel.x = 0;
    s.vel.z = 0;
    return true;
  }

  const desiredHeading = headingOf(dx / dist, dz / dist);
  s.heading = turnToward(s.heading, desiredHeading, p.turnRate * dt);

  let desiredSpeed = p.nominalSpeed * p.speedMult;
  if (dist < p.arrivalRadius) desiredSpeed *= dist / p.arrivalRadius;

  const curSpeed = len(s.vel.x, s.vel.z);
  const accelStep = p.accel * dt;
  const newSpeed =
    curSpeed < desiredSpeed ? Math.min(desiredSpeed, curSpeed + accelStep) : Math.max(desiredSpeed, curSpeed - accelStep);

  s.vel.x = Math.cos(s.heading) * newSpeed;
  s.vel.z = Math.sin(s.heading) * newSpeed;
  s.pos.x += s.vel.x * dt;
  s.pos.z += s.vel.z * dt;
  return false;
}

/**
 * One fixed-step of continuous flight (FLIGHT.md §1) — the exact integration
 * NavigationSystem runs for a ship with a FlightState: turn-rate-limited heading
 * from the stick, accel-limited approach to `throttle * nominalSpeed * boostMult`,
 * velocity always heading-aligned. No arrival, no avoidance.
 *
 * This is the client-prediction mirror of the sim path; the two are asserted
 * trajectory-identical in `steering.test.ts`. Keep them edited together.
 */
export function flightStep(s: SteerState, input: FlightInput, p: FlightParams, dt: number): void {
  s.heading = wrapAngle(s.heading + clamp(input.turn, -1, 1) * p.turnRate * dt);

  const desiredSpeed = clamp(input.throttle, 0, 1) * p.nominalSpeed * input.boostMult;
  const curSpeed = len(s.vel.x, s.vel.z);
  const accelStep = p.accel * dt;
  const newSpeed =
    curSpeed < desiredSpeed ? Math.min(desiredSpeed, curSpeed + accelStep) : Math.max(desiredSpeed, curSpeed - accelStep);

  s.vel.x = Math.cos(s.heading) * newSpeed;
  s.vel.z = Math.sin(s.heading) * newSpeed;
  s.pos.x += s.vel.x * dt;
  s.pos.z += s.vel.z * dt;
}

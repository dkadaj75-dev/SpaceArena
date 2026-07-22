import { headingOf, len, turnToward } from "./math.js";

/** Minimal kinematic state advanced by {@link seekStep}. Mutated in place. */
export interface SteerState {
  pos: { x: number; z: number };
  vel: { x: number; z: number };
  heading: number;
}

export interface SteerParams {
  nominalSpeed: number;
  accel: number;
  turnRate: number;
  arrivalRadius: number;
  arrivalStop: number;
  speedMult: number;
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

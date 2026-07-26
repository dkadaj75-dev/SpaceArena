import type { ModuleConfig } from "../../schemas/index.js";
import type { EntityId, ShipCore } from "../components.js";
import { clamp, len3, wrapAngle } from "../math.js";
import { DEFAULT_MAX_PITCH_RAD, DEFAULT_PITCH_RATE_MULT } from "../tuningDefaults.js";
import type { World } from "../World.js";

/**
 * Boost speed multiplier for one ship this tick: 1 unless a fitted boost module
 * is `active` with energy + heat headroom, in which case its `boost.speedMult`
 * applies and the module is flagged worked-this-tick so EnergySystem charges
 * `drawActive` and its boost heat.
 */
function resolveBoostMult(world: World, id: EntityId, core: ShipCore, dt: number): number {
  let speedMult = 1;
  const mods = world.modules.get(id);
  if (!mods) return speedMult;
  for (const m of mods.modules) {
    if (m.state !== "active") continue;
    const cfg = world.configs.get<ModuleConfig>("module", m.moduleId);
    if (!cfg?.boost) continue;
    const hasEnergy = core.capacitor.cur > cfg.energy.drawActive * dt;
    const hasHeat = m.heat < cfg.heat.overheatThreshold;
    if (hasEnergy && hasHeat) {
      speedMult = cfg.boost.speedMult;
      m.workedThisTick = true;
    }
  }
  return speedMult;
}

/**
 * NavigationSystem (1.2) — moves ships through the arena bubble. There is exactly
 * one driver: the persistent **FlightState** (FLIGHT.md §1, BUBBLE.md §A),
 * written by `flight` orders. Stick turn, pitch and throttle are integrated every
 * tick, with no arrival concepts and no asteroid avoidance — the pilot (human or
 * bot) eats
 * `impactDamage` through CollisionSystem, which is what makes the deep-field
 * belts (§6) a real hazard rather than scenery the sim steers around.
 *
 * A ship with no FlightState coasts: `tuning.dragCoefficient` bleeds whatever
 * velocity it still carries (a fresh spawn has none).
 *
 * Boost: when the state asks for boost AND a fitted boost module is `active`
 * with energy + heat headroom, nominal speed is multiplied by `boost.speedMult`
 * (see {@link resolveBoostMult}).
 */
export function navigationSystem(world: World, dt: number): void {
  // Flight orders are level-triggered: stored, then integrated until replaced.
  for (const { entityId, order } of world.takeOrders("flight")) {
    if (!world.shipCores.has(entityId)) continue;
    // clamp() passes NaN through — a non-finite axis would poison heading/pos,
    // so drop the malformed order outright (offline path has no validateOrder).
    if (!Number.isFinite(order.throttle) || !Number.isFinite(order.turn)) continue;
    // An absent pitch axis is a centred stick (0) — held pitch, so that means
    // "leave the nose alone"; a present non-finite one is malformed like the rest.
    const pitchStick = order.pitchStick ?? 0;
    if (!Number.isFinite(pitchStick)) continue;
    world.flightStates.set(entityId, {
      throttle: clamp(order.throttle, 0, 1),
      turn: clamp(order.turn, -1, 1),
      pitchStick: clamp(pitchStick, -1, 1),
      boost: order.boost,
    });
  }

  const drag = world.tuning.dragCoefficient ?? 0;
  const pitchRateMult = world.tuning.pitchRateMult ?? DEFAULT_PITCH_RATE_MULT;
  const maxPitch = world.tuning.maxPitchRad ?? DEFAULT_MAX_PITCH_RAD;

  for (const id of world.shipIds()) {
    const core = world.shipCores.get(id)!;
    const tf = world.transforms.get(id)!;
    const vel = world.velocities.get(id)!;
    const flight = world.flightStates.get(id);

    if (!flight) {
      // Coast: mild drag brings a ship with no standing input to rest.
      if (drag > 0) {
        const decay = Math.max(0, 1 - drag);
        vel.x *= decay;
        vel.y *= decay;
        vel.z *= decay;
      }
      tf.pos.x += vel.x * dt;
      tf.pos.y += vel.y * dt;
      tf.pos.z += vel.z * dt;
      continue;
    }

    // Continuous flight (FLIGHT.md §1). MUST stay identical to `flightStep` in
    // steering.ts — that function is the client-prediction mirror and a test
    // asserts the two produce the same trajectory.
    const speedMult = flight.boost ? resolveBoostMult(world, id, core, dt) : 1;
    tf.heading = wrapAngle(tf.heading + flight.turn * core.engine.turnRate * dt);
    tf.pitch = clamp(
      tf.pitch + flight.pitchStick * core.engine.turnRate * pitchRateMult * dt,
      -maxPitch,
      maxPitch,
    );

    const desiredSpeed = flight.throttle * core.engine.nominalSpeed * speedMult;
    const curSpeed = len3(vel.x, vel.y, vel.z);
    const accelStep = core.engine.accel * dt;
    const newSpeed =
      curSpeed < desiredSpeed
        ? Math.min(desiredSpeed, curSpeed + accelStep)
        : Math.max(desiredSpeed, curSpeed - accelStep);

    const cosPitch = Math.cos(tf.pitch);
    vel.x = cosPitch * Math.cos(tf.heading) * newSpeed;
    vel.y = Math.sin(tf.pitch) * newSpeed;
    vel.z = cosPitch * Math.sin(tf.heading) * newSpeed;
    tf.pos.x += vel.x * dt;
    tf.pos.y += vel.y * dt;
    tf.pos.z += vel.z * dt;
  }
}

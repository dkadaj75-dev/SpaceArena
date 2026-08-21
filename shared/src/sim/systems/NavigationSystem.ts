import type { ModuleConfig } from "../../schemas/index.js";
import type { EntityId } from "../components.js";
import { clamp, len3 } from "../math.js";
import { advanceFrame, type FrameAttitude } from "../frame.js";

/** Scratch frame — the sim loops over every ship each tick, so reuse one. */
const scratchFrame: FrameAttitude = { heading: 0, pitch: 0, up: { x: 0, y: 1, z: 0 } };
import { pitchTuningOf } from "../tuningDefaults.js";
import { carriedFlagOf } from "./CtfSystem.js";
import type { World } from "../World.js";

/**
 * Boost speed multiplier for one ship this tick: 1 unless a fitted boost module
 * is `active` with charge left in ITS OWN TANK (energy overhaul
 * 2026-08-07 — there is no ship capacitor to check), in which case its
 * `boost.speedMult` applies and the module is flagged worked-this-tick so
 * EnergySystem drains `energy.drawPerSec` from that tank.
 */
function resolveBoostMult(world: World, id: EntityId): number {
  let speedMult = 1;
  // A FLAG CARRIER has no afterburner (owner 2026-07-31). Not a penalty bolted
  // on afterwards — it is what gives a defence time to arrive, and what makes
  // the run a fight rather than a sprint.
  if (carriedFlagOf(world, id)) return speedMult;
  const mods = world.modules.get(id);
  if (!mods) return speedMult;
  for (const m of mods.modules) {
    if (m.state !== "active") continue;
    const cfg = world.configs.get<ModuleConfig>("module", m.moduleId);
    if (!cfg?.boost || !cfg.energy) continue;
    // Any charge at all buys this tick of thrust; EnergySystem takes the module
    // offline on the tick the bottle actually empties, and it then has to charge
    // past `energy.rearmAbove` before the pilot can arm it again.
    if (m.energy > 0) {
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
 * `impactDamage` through CollisionSystem, which is what makes the Ring's rock
 * field (§6) a real hazard rather than scenery the sim steers around.
 *
 * A ship with no FlightState coasts: `tuning.dragCoefficient` bleeds whatever
 * velocity it still carries (a fresh spawn has none).
 *
 * Boost: when the state asks for boost AND a fitted boost module is `active`
 * with charge in its own tank, nominal speed is multiplied by `boost.speedMult`
 * (see {@link resolveBoostMult}).
 */
export function navigationSystem(world: World, dt: number): void {
  // Restore the last ordered trigger level before applying this tick's batch.
  // A previous tick may have temporarily raised `fire` by ORing a sub-tick tap.
  for (const [entityId, flight] of world.flightStates) {
    flight.fire = world.flightFireLevels.get(entityId) ?? flight.fire;
  }

  // Flight orders are level-triggered: stored, then integrated until replaced.
  // Axes come from the last valid order drained for a ship, but fire is ORed
  // across this tick's batch so a press+release between sim ticks still presents
  // one firing tick to discrete weapons.
  const fireThisTick = new Map<EntityId, boolean>();
  for (const { entityId, order } of world.takeOrders("flight")) {
    if (!world.shipCores.has(entityId)) continue;
    // clamp() passes NaN through — a non-finite axis would poison heading/pos,
    // so drop the malformed order outright (offline path has no validateOrder).
    if (!Number.isFinite(order.throttle) || !Number.isFinite(order.turn)) continue;
    // An absent pitch axis is a centred stick (0) — held pitch, so that means
    // "leave the nose alone"; a present non-finite one is malformed like the rest.
    const pitchStick = order.pitchStick ?? 0;
    if (!Number.isFinite(pitchStick)) continue;
    const previous = world.flightStates.get(entityId);
    world.flightFireLevels.set(entityId, order.fire);
    world.flightStates.set(entityId, {
      throttle: clamp(order.throttle, 0, 1),
      turn: clamp(order.turn, -1, 1),
      pitchStick: clamp(pitchStick, -1, 1),
      boost: order.boost,
      fire: (fireThisTick.get(entityId) ?? false) || order.fire,
      firePrev: previous?.firePrev ?? false,
    });
    fireThisTick.set(entityId, (fireThisTick.get(entityId) ?? false) || order.fire);
  }

  const drag = world.tuning.dragCoefficient ?? 0;
  const { pitchRateMult, maxPitchRad: maxPitch } = pitchTuningOf(world.tuning);

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
    const speedMult = flight.boost ? resolveBoostMult(world, id) : 1;
    advanceFrame(
      tf.heading,
      tf.pitch,
      tf.up,
      flight.turn * core.engine.turnRate * dt,
      flight.pitchStick * core.engine.turnRate * pitchRateMult * dt,
      maxPitch,
      scratchFrame,
    );
    tf.heading = scratchFrame.heading;
    tf.pitch = scratchFrame.pitch;
    tf.up.x = scratchFrame.up.x;
    tf.up.y = scratchFrame.up.y;
    tf.up.z = scratchFrame.up.z;

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

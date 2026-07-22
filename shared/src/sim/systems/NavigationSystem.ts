import type { ModuleConfig } from "../../schemas/index.js";
import { clamp, headingOf, len, turnToward } from "../math.js";
import type { World } from "../World.js";

const ARRIVAL_STOP = 1.5; // world units; order cleared inside this radius
const TARGET_MARGIN = 1.0; // extra gap kept between a clamped target and a rock

/**
 * If a move target lands within an asteroid (radius + shipRadius + margin), push
 * it out along the rock→target direction so the ship parks beside the asteroid
 * instead of shoving into it. Deterministic: asteroids iterated in id order.
 */
function clampTargetOutsideAsteroids(
  world: World,
  target: { x: number; z: number },
  shipRadius: number,
): { x: number; z: number } {
  let tx = target.x;
  let tz = target.z;
  for (const aid of world.asteroidIds()) {
    const ast = world.asteroids.get(aid)!;
    if (ast.state === "destroyed") continue;
    const at = world.transforms.get(aid)!;
    const ac = world.colliders.get(aid)!;
    let dx = tx - at.pos.x;
    let dz = tz - at.pos.z;
    let d = Math.sqrt(dx * dx + dz * dz);
    const minDist = ac.radius + shipRadius + TARGET_MARGIN;
    if (d >= minDist) continue;
    if (d < 1e-4) {
      dx = 1;
      dz = 0;
      d = 1;
    }
    tx = at.pos.x + (dx / d) * minDist;
    tz = at.pos.z + (dz / d) * minDist;
  }
  return { x: tx, z: tz };
}

/**
 * NavigationSystem (1.2) — seek + arrival steering toward MoveOrder.target on the
 * arena plane with turn-rate-limited heading and lookahead asteroid avoidance.
 *
 * Boost: when MoveOrder.boost is set AND a fitted boost module is `active` with
 * energy + heat headroom, nominal speed is multiplied by `boost.speedMult`; the
 * boost module is flagged worked-this-tick so EnergySystem charges `drawActive`
 * and its boost heat.
 */
export function navigationSystem(world: World, dt: number): void {
  // Apply queued move orders first, clamping targets that land inside an asteroid
  // out to just beyond its collider so ships stop alongside rocks, not inside them.
  for (const { entityId, order } of world.takeOrders("move")) {
    if (!world.shipCores.has(entityId)) continue;
    const shipR = world.colliders.get(entityId)?.radius ?? 0;
    const target = clampTargetOutsideAsteroids(world, order.target, shipR);
    world.moveOrders.set(entityId, { target, boost: order.boost });
    world.emit({ type: "moveOrderSet", entityId, target: { ...target }, boost: order.boost });
  }

  const tuning = world.tuning;
  const avoidLookahead = tuning.avoidLookahead ?? 16;
  const avoidWeight = tuning.avoidWeight ?? 30;
  const arrivalRadius = tuning.arrivalRadius ?? 10;
  const drag = tuning.dragCoefficient ?? 0;

  for (const id of world.shipIds()) {
    const core = world.shipCores.get(id)!;
    const tf = world.transforms.get(id)!;
    const vel = world.velocities.get(id)!;
    const col = world.colliders.get(id)!;
    const order = world.moveOrders.get(id);

    if (!order) {
      // Coast: mild drag brings an unordered ship to rest.
      if (drag > 0) {
        const decay = Math.max(0, 1 - drag);
        vel.x *= decay;
        vel.z *= decay;
      }
      tf.pos.x += vel.x * dt;
      tf.pos.z += vel.z * dt;
      continue;
    }

    const dx = order.target.x - tf.pos.x;
    const dz = order.target.z - tf.pos.z;
    const dist = len(dx, dz);

    if (dist <= ARRIVAL_STOP) {
      world.moveOrders.delete(id);
      vel.x = 0;
      vel.z = 0;
      world.emit({ type: "moveOrderCleared", entityId: id });
      continue;
    }

    const dirX = dx / dist;
    const dirZ = dz / dist;

    // Boost resolution.
    let speedMult = 1;
    if (order.boost) {
      const mods = world.modules.get(id);
      if (mods) {
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
      }
    }

    // Lookahead asteroid avoidance: steer tangentially around the worst threat.
    let steerX = dirX;
    let steerZ = dirZ;
    const perpX = -dirZ;
    const perpZ = dirX;
    const candidates = world.spatial.queryCircle(tf.pos.x, tf.pos.z, avoidLookahead + col.radius);
    let worst = 0;
    let worstSide = 0;
    let worstPerp = 0;
    for (const aid of candidates) {
      const ast = world.asteroids.get(aid);
      if (!ast || ast.state === "destroyed") continue;
      const at = world.transforms.get(aid)!;
      const ac = world.colliders.get(aid)!;
      const relX = at.pos.x - tf.pos.x;
      const relZ = at.pos.z - tf.pos.z;
      const along = relX * dirX + relZ * dirZ;
      if (along <= 0 || along > avoidLookahead) continue;
      const cross = dirX * relZ - dirZ * relX; // signed lateral offset
      const perpDist = Math.abs(cross);
      const sumR = ac.radius + col.radius;
      if (perpDist > sumR) continue;
      const blocked = clamp(1 - perpDist / sumR, 0, 1) * clamp(1 - along / avoidLookahead, 0, 1);
      if (blocked > worst) {
        worst = blocked;
        worstSide = cross >= 0 ? -1 : 1; // steer away from the side the rock is on
        worstPerp = perpDist;
      }
    }
    if (worst > 0) {
      void worstPerp;
      const w = worst * (avoidWeight / 30);
      steerX = dirX + perpX * worstSide * w;
      steerZ = dirZ + perpZ * worstSide * w;
    }

    const desiredHeading = headingOf(steerX, steerZ);
    tf.heading = turnToward(tf.heading, desiredHeading, core.engine.turnRate * dt);

    // Arrival deceleration inside arrivalRadius.
    let desiredSpeed = core.engine.nominalSpeed * speedMult;
    if (dist < arrivalRadius) desiredSpeed *= dist / arrivalRadius;

    const curSpeed = len(vel.x, vel.z);
    const accelStep = core.engine.accel * dt;
    let newSpeed = curSpeed;
    if (curSpeed < desiredSpeed) newSpeed = Math.min(desiredSpeed, curSpeed + accelStep);
    else newSpeed = Math.max(desiredSpeed, curSpeed - accelStep);

    vel.x = Math.cos(tf.heading) * newSpeed;
    vel.z = Math.sin(tf.heading) * newSpeed;

    tf.pos.x += vel.x * dt;
    tf.pos.z += vel.z * dt;
  }
}

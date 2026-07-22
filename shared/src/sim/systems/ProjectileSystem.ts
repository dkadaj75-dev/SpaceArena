import type { EntityId } from "../components.js";
import { applyDamageToAsteroid, applyDamageToShip } from "../damage.js";
import { headingOf, segmentIntersectsCircle, turnToward } from "../math.js";
import type { World } from "../World.js";

/**
 * ProjectileSystem — advances travelling ordnance, homes missiles toward their
 * target (turn-rate-limited), expires by lifetime, and does swept circle hit
 * detection (old→new segment vs collider) against enemy ships and asteroids so
 * fast projectiles cannot tunnel. First hit along the path wins.
 */
export function projectileSystem(world: World, dt: number): void {
  for (const id of world.projectileIds()) {
    const proj = world.projectiles.get(id)!;
    const tf = world.transforms.get(id)!;
    const vel = world.velocities.get(id)!;

    proj.lifetime -= dt;
    if (proj.lifetime <= 0) {
      world.destroyEntity(id);
      continue;
    }

    // Homing.
    if (proj.kind === "missile" && proj.targetId !== undefined && world.shipCores.has(proj.targetId)) {
      const tgt = world.transforms.get(proj.targetId)!;
      const desired = headingOf(tgt.pos.x - tf.pos.x, tgt.pos.z - tf.pos.z);
      const newHeading = turnToward(tf.heading, desired, (proj.turnRate ?? 0) * dt);
      tf.heading = newHeading;
      vel.x = Math.cos(newHeading) * proj.speed;
      vel.z = Math.sin(newHeading) * proj.speed;
    }

    const from = { x: tf.pos.x, z: tf.pos.z };
    const to = { x: tf.pos.x + vel.x * dt, z: tf.pos.z + vel.z * dt };

    const hit = findHit(world, id, from, to);
    tf.pos.x = to.x;
    tf.pos.z = to.z;

    if (hit) {
      if (hit.isAsteroid) {
        applyDamageToAsteroid(world, hit.id, proj.ownerId, proj.damage, proj.damageType);
      } else {
        applyDamageToShip(world, hit.id, proj.ownerId, proj.damage, proj.damageType);
      }
      world.destroyEntity(id);
    }
  }
}

interface Hit {
  id: EntityId;
  isAsteroid: boolean;
  along: number;
}

function findHit(
  world: World,
  projId: EntityId,
  from: { x: number; z: number },
  to: { x: number; z: number },
): Hit | null {
  const proj = world.projectiles.get(projId)!;
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const segLen = Math.sqrt(dx * dx + dz * dz) || 1;
  const dirX = dx / segLen;
  const dirZ = dz / segLen;

  const minX = Math.min(from.x, to.x) - proj.radius;
  const maxX = Math.max(from.x, to.x) + proj.radius;
  const minZ = Math.min(from.z, to.z) - proj.radius;
  const maxZ = Math.max(from.z, to.z) + proj.radius;
  const candidates = world.spatial.queryAABB(minX, minZ, maxX, maxZ);

  let best: Hit | null = null;
  for (const cid of candidates) {
    const col = world.colliders.get(cid);
    const ct = world.transforms.get(cid);
    if (!col || !ct) continue;

    const isAsteroid = world.asteroids.has(cid);
    const isShip = world.shipCores.has(cid);
    if (!isAsteroid && !isShip) continue;
    if (isShip) {
      if (cid === proj.ownerId) continue;
      if (world.teams.get(cid)?.team === proj.ownerTeam) continue;
      if (world.shipCores.get(cid)!.hull <= 0) continue;
    }
    if (isAsteroid && world.asteroids.get(cid)!.state === "destroyed") continue;

    if (!segmentIntersectsCircle(from, to, ct.pos, col.radius + proj.radius)) continue;
    const along = (ct.pos.x - from.x) * dirX + (ct.pos.z - from.z) * dirZ;
    if (!best || along < best.along) {
      best = { id: cid, isAsteroid, along };
    }
  }
  return best;
}

import type { EntityId } from "../components.js";
import { applyDamageToAsteroid, applyDamageToShip } from "../damage.js";
import { headingOf, len3, pitchOf, pitchToward, segmentIntersectsSphere, turnToward } from "../math.js";
import type { World } from "../World.js";

/** Fallback for `tuning.projectileBoundsMargin` (world units). */
const DEFAULT_BOUNDS_MARGIN = 20;

/**
 * ProjectileSystem — advances travelling ordnance, homes missiles toward their
 * target (turn-rate-limited, in 3D), expires by lifetime or by leaving the arena
 * bubble, and does swept SPHERE hit detection (old→new segment vs collider)
 * against enemy ships and asteroids so fast projectiles cannot tunnel. First hit
 * along the path wins.
 *
 * Homing is yaw + pitch (BUBBLE.md §A): each axis rotates toward the target's
 * bearing by at most `turnRate * dt`, the same budget the planar version spent on
 * yaw alone, so a missile can chase a climbing ship without gaining a new stat.
 */
export function projectileSystem(world: World, dt: number): void {
  const margin = world.tuning.projectileBoundsMargin ?? DEFAULT_BOUNDS_MARGIN;
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
      const dx = tgt.pos.x - tf.pos.x;
      const dy = tgt.pos.y - tf.pos.y;
      const dz = tgt.pos.z - tf.pos.z;
      const step = (proj.turnRate ?? 0) * dt;
      tf.heading = turnToward(tf.heading, headingOf(dx, dz), step);
      tf.pitch = pitchToward(tf.pitch, pitchOf(dx, dy, dz), step);
      const cosPitch = Math.cos(tf.pitch);
      vel.x = cosPitch * Math.cos(tf.heading) * proj.speed;
      vel.y = Math.sin(tf.pitch) * proj.speed;
      vel.z = cosPitch * Math.sin(tf.heading) * proj.speed;
    }

    const from = { x: tf.pos.x, y: tf.pos.y, z: tf.pos.z };
    const to = { x: tf.pos.x + vel.x * dt, y: tf.pos.y + vel.y * dt, z: tf.pos.z + vel.z * dt };

    const hit = findHit(world, id, from, to);
    tf.pos.x = to.x;
    tf.pos.y = to.y;
    tf.pos.z = to.z;

    // Out-of-arena cull. Ships are held inside the boundary by CollisionSystem,
    // but ordnance is not: a missile that loses its target keeps flying straight
    // for the rest of its lifetime and can end up hundreds of units outside the
    // rim. Nothing out there can be hit, and the wire encoding cannot even
    // represent the position (see `tuning.projectileBoundsMargin`), so despawn.
    // Done HERE rather than in the room so the rule is deterministic and
    // identical offline and online.
    if (!hit && outsideBounds(world, to, margin)) {
      world.destroyEntity(id);
      continue;
    }

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

/** Whether `pos` sits more than `margin` outside the arena's own bounds shape. */
function outsideBounds(world: World, pos: { x: number; y: number; z: number }, margin: number): boolean {
  const bounds = world.arena.bounds;
  if (bounds.shape === "sphere") {
    // 3D radial distance: ordnance that climbs out of the bubble is as far gone
    // as ordnance that flies out sideways.
    const limit = bounds.radius + margin;
    return pos.x * pos.x + pos.y * pos.y + pos.z * pos.z > limit * limit;
  }
  return Math.abs(pos.x) > bounds.width / 2 + margin || Math.abs(pos.z) > bounds.height / 2 + margin;
}

interface Hit {
  id: EntityId;
  isAsteroid: boolean;
  along: number;
}

function findHit(
  world: World,
  projId: EntityId,
  from: { x: number; y: number; z: number },
  to: { x: number; y: number; z: number },
): Hit | null {
  const proj = world.projectiles.get(projId)!;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const segLen = len3(dx, dy, dz) || 1;
  const dirX = dx / segLen;
  const dirY = dy / segLen;
  const dirZ = dz / segLen;

  const minX = Math.min(from.x, to.x) - proj.radius;
  const maxX = Math.max(from.x, to.x) + proj.radius;
  const minZ = Math.min(from.z, to.z) - proj.radius;
  const maxZ = Math.max(from.z, to.z) + proj.radius;
  const candidates = world.spatial.queryAABB(minX, minZ, maxX, maxZ);
  const minY = Math.min(from.y, to.y);
  const maxY = Math.max(from.y, to.y);

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

    // |Δy| prefilter on the planar broadphase result, then the true 3D sweep.
    const reach = col.radius + proj.radius;
    if (ct.pos.y + reach < minY || ct.pos.y - reach > maxY) continue;
    if (!segmentIntersectsSphere(from, to, ct.pos, reach)) continue;
    const along = (ct.pos.x - from.x) * dirX + (ct.pos.y - from.y) * dirY + (ct.pos.z - from.z) * dirZ;
    if (!best || along < best.along) {
      best = { id: cid, isAsteroid, along };
    }
  }
  return best;
}

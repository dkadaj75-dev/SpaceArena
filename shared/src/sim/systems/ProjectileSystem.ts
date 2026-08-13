import type { EntityId } from "../components.js";
import { DEFAULT_PROJECTILE_BOUNDS_MARGIN } from "../../schemas/arena.js";
import { applyDamageToAsteroid, applyDamageToShip } from "../damage.js";
import { clamp, headingOf, len3, pitchOf, segmentIntersectsSphere, sphereEntryAlong } from "../math.js";
import type { World } from "../World.js";

/**
 * ProjectileSystem — advances travelling ordnance, homes missiles toward their
 * target (turn-rate-limited, in 3D), expires by lifetime or by leaving the arena
 * bubble, and does swept SPHERE hit detection (old→new segment vs collider)
 * against enemy ships and asteroids so fast projectiles cannot tunnel. First hit
 * along the path wins.
 *
 * Homing spends one 3D angular budget (BUBBLE.md §A): velocity rotates toward
 * the bearing by at most `turnRate * dt`, then yaw/pitch are recovered.
 */
export function projectileSystem(world: World, dt: number): void {
  const margin = world.tuning.projectileBoundsMargin ?? DEFAULT_PROJECTILE_BOUNDS_MARGIN;
  for (const id of world.projectileIds()) {
    const proj = world.projectiles.get(id)!;
    const tf = world.transforms.get(id)!;
    const vel = world.velocities.get(id)!;

    proj.lifetime -= dt;
    if (proj.lifetime <= 0) {
      world.destroyEntity(id);
      continue;
    }

    // Mid-flight lure (owner 2026-07-31): an enemy heatsink dropped after this
    // missile launched steals the seeker head. Checked every tick and BEFORE
    // homing, so a sink jettisoned with ordnance already inbound pulls it off
    // the hull — which is the whole point of carrying one.
    if (proj.kind === "missile") retargetToDecoy(world, proj, tf.pos);

    // Homing.
    if (proj.kind === "missile" && proj.targetId !== undefined && world.transforms.has(proj.targetId)) {
      const tgt = world.transforms.get(proj.targetId)!;
      const dx = tgt.pos.x - tf.pos.x;
      const dy = tgt.pos.y - tf.pos.y;
      const dz = tgt.pos.z - tf.pos.z;
      const step = (proj.turnRate ?? 0) * dt;
      const speed = len3(vel.x, vel.y, vel.z);
      const bearingLength = len3(dx, dy, dz);
      if (speed > 0 && bearingLength > 0 && step > 0) {
        const next = rotateTowardUnit(
          { x: vel.x / speed, y: vel.y / speed, z: vel.z / speed },
          { x: dx / bearingLength, y: dy / bearingLength, z: dz / bearingLength },
          step,
        );
        vel.x = next.x * proj.speed;
        vel.y = next.y * proj.speed;
        vel.z = next.z * proj.speed;
        tf.heading = headingOf(next.x, next.z);
        tf.pitch = pitchOf(next.x, next.y, next.z);
      }
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
      if (hit.isStatic) {
        // Static props absorb ordnance but are not damageable entities.
      } else if (hit.isAsteroid) {
        applyDamageToAsteroid(world, hit.id, proj.ownerId, proj.damage, proj.damageType);
      } else {
        applyDamageToShip(world, hit.id, proj.ownerId, proj.damage, proj.damageType);
      }
      world.destroyEntity(id);
    }
  }
}

/**
 * Seeker distraction: if any enemy decoy is closer to this missile than its
 * current target, the missile switches to it. Re-evaluated every tick, so a sink
 * dropped mid-flight steals ordnance already on its way — and a missile that
 * outlives a burnt-out decoy simply finds nothing to switch to and keeps
 * flying straight (its old target id no longer resolves to a transform).
 */
function retargetToDecoy(
  world: World,
  proj: { targetId?: EntityId; ownerTeam: number },
  from: { x: number; y: number; z: number },
): void {
  const decoyIds = world.decoyIds();
  if (decoyIds.length === 0) return;
  let bestId: EntityId | undefined;
  let bestDist = proj.targetId !== undefined ? distSqTo(world, from, proj.targetId) : Infinity;
  for (const decoyId of decoyIds) {
    if (world.decoys.get(decoyId)!.team === proj.ownerTeam) continue;
    const d = distSqTo(world, from, decoyId);
    if (d < bestDist) {
      bestDist = d;
      bestId = decoyId;
    }
  }
  if (bestId !== undefined) proj.targetId = bestId;
}

/** Squared distance from `from` to an entity, or Infinity if it is gone. */
function distSqTo(world: World, from: { x: number; y: number; z: number }, id: EntityId): number {
  const tf = world.transforms.get(id);
  if (!tf) return Infinity;
  const dx = tf.pos.x - from.x;
  const dy = tf.pos.y - from.y;
  const dz = tf.pos.z - from.z;
  return dx * dx + dy * dy + dz * dz;
}

/** Rotate one unit vector toward another by one total angular step. */
function rotateTowardUnit(
  from: { x: number; y: number; z: number },
  to: { x: number; y: number; z: number },
  maxStep: number,
): { x: number; y: number; z: number } {
  const dot = clamp(from.x * to.x + from.y * to.y + from.z * to.z, -1, 1);
  const angle = Math.acos(dot);
  if (angle <= maxStep) return to;

  const sinAngle = Math.sin(angle);
  if (Math.abs(sinAngle) > 1e-8) {
    const fromWeight = Math.sin(angle - maxStep) / sinAngle;
    const toWeight = Math.sin(maxStep) / sinAngle;
    return {
      x: from.x * fromWeight + to.x * toWeight,
      y: from.y * fromWeight + to.y * toWeight,
      z: from.z * fromWeight + to.z * toWeight,
    };
  }

  // Antipodal fallback: choose a deterministic perpendicular.
  const reference =
    Math.abs(from.x) <= Math.abs(from.y) && Math.abs(from.x) <= Math.abs(from.z)
      ? { x: 1, y: 0, z: 0 }
      : Math.abs(from.y) <= Math.abs(from.z)
        ? { x: 0, y: 1, z: 0 }
        : { x: 0, y: 0, z: 1 };
  const px = from.y * reference.z - from.z * reference.y;
  const py = from.z * reference.x - from.x * reference.z;
  const pz = from.x * reference.y - from.y * reference.x;
  const plen = len3(px, py, pz);
  const c = Math.cos(maxStep);
  const s = Math.sin(maxStep) / plen;
  return { x: from.x * c + px * s, y: from.y * c + py * s, z: from.z * c + pz * s };
}

/** Whether `pos` sits more than `margin` outside the arena's own bounds shape. */
function outsideBounds(world: World, pos: { x: number; y: number; z: number }, margin: number): boolean {
  const bounds = world.arena.bounds;
  if (bounds.shape === "sphere") {
    // 3D radial distance: ordnance that climbs out of the bubble is as far gone
    // as ordnance that flies out sideways.
    const limit = bounds.radius + margin;
    return (
      pos.x * pos.x + pos.y * pos.y + pos.z * pos.z > limit * limit ||
      (bounds.floorY !== undefined && pos.y < bounds.floorY - margin)
    );
  }
  if (bounds.shape === "box") {
    return Math.abs(pos.x) > bounds.width / 2 + margin || Math.abs(pos.z) > bounds.height / 2 + margin || pos.y < bounds.floorY - margin || pos.y > bounds.ceilingY + margin;
  }
  return (
    Math.abs(pos.x) > bounds.width / 2 + margin ||
    Math.abs(pos.y) > bounds.verticalExtent / 2 + margin ||
    Math.abs(pos.z) > bounds.height / 2 + margin
  );
}

interface Hit {
  id: EntityId;
  isAsteroid: boolean;
  isStatic?: boolean;
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
  const staticHit = world.staticWorld.raycast(from, to);
  if (staticHit) best = { id: -1, isAsteroid: false, isStatic: true, along: staticHit.t * segLen };
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
    const centerAlong = (ct.pos.x - from.x) * dirX + (ct.pos.y - from.y) * dirY + (ct.pos.z - from.z) * dirZ;
    const along = sphereEntryAlong(from, ct.pos, centerAlong, reach);
    if (!best || along < best.along) {
      best = { id: cid, isAsteroid, along };
    }
  }
  return best;
}

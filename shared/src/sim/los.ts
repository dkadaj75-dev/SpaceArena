import type { EntityId } from "./components.js";
import { segmentIntersectsCircle } from "./math.js";
import type { World } from "./World.js";

/**
 * Pure 2D line-of-sight: segment `a`→`b` vs every (non-destroyed) asteroid
 * collider. Broadphase via the world spatial hash (segment AABB query), narrow
 * phase segment-vs-circle. Identical on client + server (no engine raycasts).
 */
export function hasLineOfSight(
  world: World,
  a: { x: number; z: number },
  b: { x: number; z: number },
): boolean {
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const minZ = Math.min(a.z, b.z);
  const maxZ = Math.max(a.z, b.z);
  const candidates = world.spatial.queryAABB(minX, minZ, maxX, maxZ);
  for (const id of candidates) {
    const ast = world.asteroids.get(id);
    if (!ast || ast.state === "destroyed") continue;
    const t = world.transforms.get(id);
    const col = world.colliders.get(id);
    if (!t || !col) continue;
    if (segmentIntersectsCircle(a, b, t.pos, col.radius)) return false;
  }
  return true;
}

function pairKey(a: EntityId, b: EntityId): number {
  const lo = a < b ? a : b;
  const hi = a < b ? b : a;
  return lo * 0x100000 + hi;
}

/** LoS between two entities, cached per tick per unordered pair. */
export function hasLineOfSightBetween(world: World, a: EntityId, b: EntityId): boolean {
  const key = pairKey(a, b);
  const cached = world.losCache.get(key);
  if (cached !== undefined) return cached;
  const ta = world.transforms.get(a);
  const tb = world.transforms.get(b);
  const result = ta && tb ? hasLineOfSight(world, ta.pos, tb.pos) : false;
  world.losCache.set(key, result);
  return result;
}

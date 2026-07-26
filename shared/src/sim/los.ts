import type { EntityId } from "./components.js";
import { segmentIntersectsSphere } from "./math.js";
import type { World } from "./World.js";

/**
 * A point on the sight line. `y` is optional so a caller holding a content-shaped
 * {@link import("../schemas/common.js").Vec3} (where `y` is optional, because a
 * flat arena omits it) can pass it straight in and have the missing axis read as
 * the arena plane. Every sim-side caller carries a real `y`; the bots have since
 * stage T4 too.
 */
export interface LosPoint {
  x: number;
  y?: number;
  z: number;
}

/** Scratch points so the narrow phase stays allocation-free per candidate. */
const losA = { x: 0, y: 0, z: 0 };
const losB = { x: 0, y: 0, z: 0 };
const losC = { x: 0, y: 0, z: 0 };

function load(out: { x: number; y: number; z: number }, p: LosPoint): { x: number; y: number; z: number } {
  out.x = p.x;
  out.y = p.y ?? 0;
  out.z = p.z;
  return out;
}

/**
 * Line-of-sight in the bubble: segment `a`→`b` vs every (non-destroyed) asteroid
 * collider, as spheres (BUBBLE.md §A) — a rock 20 units below the sight line no
 * longer blocks a shot the way the old planar test said it did. Broadphase via
 * the world spatial hash (planar segment AABB query), narrow phase
 * segment-vs-sphere. Identical on client + server (no engine raycasts).
 */
export function hasLineOfSight(world: World, a: LosPoint, b: LosPoint): boolean {
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
    if (segmentIntersectsSphere(load(losA, a), load(losB, b), t.pos, col.radius)) return false;
  }
  return true;
}

/**
 * A spherical LoS blocker (an asteroid) expressed without World access. `pos.y`
 * is optional for the same reason {@link LosPoint}'s is.
 */
export interface LosCircle {
  pos: LosPoint;
  radius: number;
}

/**
 * World-free variant of {@link hasLineOfSight}: segment `a`→`b` vs an explicit
 * list of spherical blockers. Same narrow-phase math (segment-vs-sphere), no
 * broadphase — used by consumers that only hold a read-only {@link
 * import("./ArenaSimulation.js").Snapshot} (bots, debug overlays) rather than a
 * live World. Keeping it here means there is exactly one LoS implementation.
 */
export function hasLineOfSightAmong(a: LosPoint, b: LosPoint, blockers: readonly LosCircle[]): boolean {
  load(losA, a);
  load(losB, b);
  for (let i = 0; i < blockers.length; i++) {
    const c = blockers[i]!;
    if (segmentIntersectsSphere(losA, losB, load(losC, c.pos), c.radius)) return false;
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

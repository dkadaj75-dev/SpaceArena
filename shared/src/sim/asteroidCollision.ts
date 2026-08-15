import { rockOrientationAt } from "../collision/rockPose.js";
import {
  rockSegmentEntry,
  rockSphereContact,
  rockWorldRadius,
  type RockContact,
  type RockQuat,
} from "../collision/rockShape.js";
import type { AsteroidTag, Transform3D } from "./components.js";
import type { World } from "./World.js";

/**
 * The sim's single seam onto the shared rock shape (see
 * `shared/src/collision/rockShape.ts`). Every gameplay consumer — ship push-out,
 * projectile sweeps, line of sight — comes through here, so there is exactly one
 * answer to "is this point inside that rock" and it is the same answer on the
 * client and the server.
 *
 * Rocks that author no `shape` keep the legacy sphere: the helpers below fall
 * back to `collider.radius` so a content pack can adopt shapes one config at a
 * time.
 */

/** Scratch contact — the narrowphase never allocates. */
export const rockContact: RockContact = { nx: 0, ny: 0, nz: 0, depth: 0 };

/**
 * The rock's world orientation at the current match time, recomputed at most
 * once per tick per rock. The cache is keyed on match time rather than tick
 * number so a World stepped by hand in a test (no clock at all) resolves to the
 * rock's rest pose and stays perfectly reproducible.
 */
export function asteroidOrientation(world: World, tag: AsteroidTag): RockQuat {
  if (tag.orientationTime !== world.matchElapsed) {
    rockOrientationAt(tag.spin, tag.baseRotationY, world.matchElapsed, tag.orientation);
    tag.orientationTime = world.matchElapsed;
  }
  return tag.orientation;
}

/**
 * Contact between a probe sphere and a rock. Fills {@link rockContact} and
 * returns true on overlap.
 *
 * `boundRadius` (the entity's `collider.radius`) is the bounding sphere, so the
 * caller's own broadphase reject is already the shape's early-out; this only
 * ever runs the field for a probe that is genuinely inside that sphere.
 */
export function asteroidContact(
  world: World,
  tag: AsteroidTag,
  transform: Transform3D,
  boundRadius: number,
  pointX: number,
  pointY: number,
  pointZ: number,
  probeRadius: number,
): boolean {
  const shape = tag.shape;
  if (!shape) {
    const dx = pointX - transform.pos.x;
    const dy = pointY - transform.pos.y;
    const dz = pointZ - transform.pos.z;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const reach = boundRadius + probeRadius;
    if (distance >= reach) return false;
    const inv = distance > 1e-9 ? 1 / distance : 0;
    rockContact.nx = inv === 0 ? 1 : dx * inv;
    rockContact.ny = inv === 0 ? 0 : dy * inv;
    rockContact.nz = inv === 0 ? 0 : dz * inv;
    rockContact.depth = reach - distance;
    return true;
  }
  return rockSphereContact(
    shape,
    tag.visualRadius,
    asteroidOrientation(world, tag),
    transform.pos.x,
    transform.pos.y,
    transform.pos.z,
    pointX,
    pointY,
    pointZ,
    probeRadius,
    rockContact,
  );
}

/**
 * Surface radius of a rock, in world units, along the direction from its centre
 * toward `point`. The World-side twin of
 * {@link import("./asteroidSurface.js").makeRockSurfaceProbe} — same surface,
 * read straight off the entity instead of rebuilt from a snapshot.
 */
export function asteroidSurfaceRadiusToward(
  world: World,
  tag: AsteroidTag,
  transform: Transform3D,
  boundRadius: number,
  pointX: number,
  pointY: number,
  pointZ: number,
): number {
  const shape = tag.shape;
  if (!shape) return boundRadius;
  return rockWorldRadius(
    shape,
    tag.visualRadius,
    asteroidOrientation(world, tag),
    pointX - transform.pos.x,
    pointY - transform.pos.y,
    pointZ - transform.pos.z,
  );
}

/** Scratch endpoints for the sphere fallback of the swept test. */
const sweepFrom = { x: 0, y: 0, z: 0 };
const sweepTo = { x: 0, y: 0, z: 0 };

/**
 * Swept probe sphere against a rock. Returns the entry parameter in `[0, 1]`
 * along `from`→`to`, or `-1` for a miss.
 */
export function asteroidSegmentEntry(
  world: World,
  tag: AsteroidTag,
  transform: Transform3D,
  boundRadius: number,
  from: { x: number; y: number; z: number },
  to: { x: number; y: number; z: number },
  probeRadius: number,
): number {
  const shape = tag.shape;
  if (!shape) return sphereSegmentEntry(transform.pos, boundRadius + probeRadius, from, to);
  return rockSegmentEntry(
    shape,
    tag.visualRadius,
    asteroidOrientation(world, tag),
    transform.pos.x,
    transform.pos.y,
    transform.pos.z,
    from,
    to,
    probeRadius,
  );
}

/** Legacy sphere sweep, kept so a shape-less rock behaves exactly as it always did. */
function sphereSegmentEntry(
  center: { x: number; y: number; z: number },
  radius: number,
  from: { x: number; y: number; z: number },
  to: { x: number; y: number; z: number },
): number {
  sweepFrom.x = from.x - center.x;
  sweepFrom.y = from.y - center.y;
  sweepFrom.z = from.z - center.z;
  sweepTo.x = to.x - from.x;
  sweepTo.y = to.y - from.y;
  sweepTo.z = to.z - from.z;
  const a = sweepTo.x * sweepTo.x + sweepTo.y * sweepTo.y + sweepTo.z * sweepTo.z;
  const b = sweepFrom.x * sweepTo.x + sweepFrom.y * sweepTo.y + sweepFrom.z * sweepTo.z;
  const c = sweepFrom.x * sweepFrom.x + sweepFrom.y * sweepFrom.y + sweepFrom.z * sweepFrom.z - radius * radius;
  if (c <= 0) return 0;
  if (a <= 1e-12) return -1;
  const disc = b * b - a * c;
  if (disc < 0) return -1;
  const t = (-b - Math.sqrt(disc)) / a;
  return t >= 0 && t <= 1 ? t : -1;
}

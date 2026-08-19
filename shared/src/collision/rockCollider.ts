import type { AsteroidConfig } from "../schemas/asteroid.js";
import { decodeFloat32Array, decodeUint32Array } from "./base64.js";
import { TriangleBvh, type Point3 } from "./bvh.js";
import type { RockContact, RockQuat } from "./rockShape.js";

/**
 * ROCK MESH — the triangle-soup half of asteroid collision.
 *
 * `rockShape.ts` compiles an authored radial field; this compiles an authored
 * MESH. Both answer the same three questions (`contact`, `segment entry`,
 * `surface radius toward`) and `sim/asteroidCollision.ts` picks between them, so
 * every gameplay consumer still sees exactly one collision surface per rock.
 *
 * ## Why both exist
 *
 * The field's own header argues against a BVH, and the argument still holds for
 * anything the field can express: no baked mesh in the pack, no traversal, no
 * per-instance data. What it cannot express is a rock that is not star-shaped
 * about its centre — and a sculpted GLB generally is not. The six shipped rocks
 * are modelled, textured and normal-mapped assets whose silhouettes exist
 * nowhere but their triangles, so for them the mesh IS the authority and a
 * refitted field would be a second, disagreeing shape.
 *
 * ## One BVH per CONFIG
 *
 * The tree is built once per config and shared by every placement, keyed on the
 * config object itself — the same `WeakMap` discipline `staticWorld.ts` uses for
 * props, so a content reload drops the old trees with the old configs.
 *
 * Placement differences (position, tumble, size) are applied by transforming the
 * QUERY into the config's local space rather than the mesh into the world:
 *
 *     local = conj(pose) * (world - centre) / worldRadius
 *
 * `pose` is {@link import("./rockPose.js").rockOrientationAt}'s closed form —
 * the very quaternion the client writes into the drawn instance — so a tumbling
 * rock's collider tracks its visuals exactly rather than drifting out of step
 * within a minute the way a static hull would.
 *
 * The mesh is authored at unit radius, so the scale factor is simply the rock's
 * world radius, and the bounding sphere the broadphase already rejects against
 * is a genuine upper bound on it.
 */

/** A config's collision mesh, compiled once. All radii are in units of the world radius. */
export interface ResolvedRockMesh {
  readonly bvh: TriangleBvh;
  /** Largest surface radius — 1.0 for a correctly normalized model. */
  readonly maxRadius: number;
  /** Distance to the NEAREST point of the surface; everything inside it is solid rock. */
  readonly minRadius: number;
  /** Area-weighted mean surface radius — the honest single-sphere stand-in. */
  readonly meanRadius: number;
}

const meshCache = new WeakMap<AsteroidConfig, ResolvedRockMesh>();

/**
 * The compiled mesh for a config, or `null` if it authors none. Cached per
 * config object; every placement of a rock shares one tree.
 */
export function resolveRockMesh(config: AsteroidConfig): ResolvedRockMesh | null {
  if (!config.collision) return null;
  const cached = meshCache.get(config);
  if (cached) return cached;
  const positions = decodeFloat32Array(config.collision.positions);
  const indices = decodeUint32Array(config.collision.indices);
  const resolved = compile(new TriangleBvh({ positions, indices }));
  meshCache.set(config, resolved);
  return resolved;
}

/**
 * Measure the extremes a coarse consumer needs. `minRadius` is the distance to
 * the closest point of the closest TRIANGLE, not of the closest vertex: a face
 * can pass nearer the centre than any of its corners, and an inner sphere that
 * overstated the solid core would report clear space as rock.
 */
function compile(bvh: TriangleBvh): ResolvedRockMesh {
  const { positions, indices } = bvh.mesh;
  let maxRadius = 0;
  for (let i = 0; i < positions.length; i += 3) {
    maxRadius = Math.max(maxRadius, Math.hypot(positions[i]!, positions[i + 1]!, positions[i + 2]!));
  }
  let minRadius = Infinity;
  let areaSum = 0;
  let weightedRadius = 0;
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = indices[t]! * 3, b = indices[t + 1]! * 3, c = indices[t + 2]! * 3;
    const ax = positions[a]!, ay = positions[a + 1]!, az = positions[a + 2]!;
    const bx = positions[b]!, by = positions[b + 1]!, bz = positions[b + 2]!;
    const cx = positions[c]!, cy = positions[c + 1]!, cz = positions[c + 2]!;
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const area = Math.hypot(nx, ny, nz) * 0.5;
    areaSum += area;
    weightedRadius += area * (Math.hypot(ax, ay, az) + Math.hypot(bx, by, bz) + Math.hypot(cx, cy, cz)) / 3;
    minRadius = Math.min(minRadius, distanceToTriangle(ax, ay, az, bx, by, bz, cx, cy, cz));
  }
  return {
    bvh,
    maxRadius,
    minRadius: Number.isFinite(minRadius) ? minRadius : 0,
    meanRadius: areaSum > 0 ? weightedRadius / areaSum : maxRadius,
  };
}

/** Distance from the ORIGIN to a triangle, via the barycentric closest-point regions. */
function distanceToTriangle(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
): number {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  // Vector from a to the origin.
  const apx = -ax, apy = -ay, apz = -az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return Math.hypot(ax, ay, az);
  const bpx = -bx, bpy = -by, bpz = -bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return Math.hypot(bx, by, bz);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return Math.hypot(ax + v * abx, ay + v * aby, az + v * abz);
  }
  const cpx = -cx, cpy = -cy, cpz = -cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return Math.hypot(cx, cy, cz);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return Math.hypot(ax + w * acx, ay + w * acy, az + w * acz);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    return Math.hypot(bx + w * (cx - bx), by + w * (cy - by), bz + w * (cz - bz));
  }
  const denom = 1 / (va + vb + vc), v = vb * denom, w = vc * denom;
  return Math.hypot(ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w);
}

/** Scratch query points; the narrowphase never allocates one per call. */
const localPoint: Point3 = { x: 0, y: 0, z: 0 };
const localFrom: Point3 = { x: 0, y: 0, z: 0 };
const localTo: Point3 = { x: 0, y: 0, z: 0 };
/** Separate scratch for the containment ray, which runs INSIDE a contact query. */
const rayFrom: Point3 = { x: 0, y: 0, z: 0 };
const rayTo: Point3 = { x: 0, y: 0, z: 0 };

/**
 * Local surface radius along a local direction, by casting INWARD from just
 * outside the bounding sphere: the first hit of that ray is the OUTERMOST
 * surface, which is the silhouette. (A ray cast outward from the centre reports
 * the nearest hit instead, which for a concave body can be the near wall of a
 * crater.)
 *
 * Returns `-1` when the ray misses the body entirely, which a closed mesh only
 * does for a direction the surface does not cover — the caller decides what that
 * means.
 */
function localSurfaceRadius(mesh: ResolvedRockMesh, dx: number, dy: number, dz: number): number {
  const length = Math.hypot(dx, dy, dz);
  if (length <= 1e-12) return -1;
  const reach = mesh.maxRadius * 1.001;
  rayFrom.x = (dx / length) * reach;
  rayFrom.y = (dy / length) * reach;
  rayFrom.z = (dz / length) * reach;
  rayTo.x = 0;
  rayTo.y = 0;
  rayTo.z = 0;
  const hit = mesh.bvh.segmentIntersect(rayFrom, rayTo);
  // `t` runs from the outside inward, so the surface sits at `(1 - t) * reach`.
  return hit ? (1 - hit.t) * reach : -1;
}

/**
 * World point into the rock's local (unit-radius, unrotated) space:
 * `conj(q) * (p - centre) / scale`, written into `out`.
 */
function toLocal(
  out: Point3,
  q: RockQuat,
  centerX: number, centerY: number, centerZ: number,
  scale: number,
  x: number, y: number, z: number,
): Point3 {
  const dx = (x - centerX) / scale;
  const dy = (y - centerY) / scale;
  const dz = (z - centerZ) / scale;
  // v' = conj(q) * v * q, expanded via t = 2 * (-qv) x v.
  const tx = 2 * (-q.y * dz + q.z * dy);
  const ty = 2 * (-q.z * dx + q.x * dz);
  const tz = 2 * (-q.x * dy + q.y * dx);
  out.x = dx + q.w * tx + (-q.y * tz + q.z * ty);
  out.y = dy + q.w * ty + (-q.z * tx + q.x * tz);
  out.z = dz + q.w * tz + (-q.x * ty + q.y * tx);
  return out;
}

/** Rotate a local direction back into world space by `q`. Writes `out`. */
function rotateToWorld(out: RockContact, q: RockQuat, x: number, y: number, z: number): void {
  const tx = 2 * (q.y * z - q.z * y);
  const ty = 2 * (q.z * x - q.x * z);
  const tz = 2 * (q.x * y - q.y * x);
  out.nx = x + q.w * tx + (q.y * tz - q.z * ty);
  out.ny = y + q.w * ty + (q.z * tx - q.x * tz);
  out.nz = z + q.w * tz + (q.x * ty - q.y * tx);
}

/**
 * Deepest contact between a probe sphere and a rock mesh. Fills `out` with a
 * WORLD-space outward normal and depth, and returns true on overlap.
 *
 * The signature mirrors {@link import("./rockShape.js").rockSphereContact} so
 * the sim's seam can branch on which representation a rock authored and pass the
 * same arguments either way.
 */
export function rockMeshSphereContact(
  mesh: ResolvedRockMesh,
  scale: number,
  q: RockQuat,
  centerX: number,
  centerY: number,
  centerZ: number,
  pointX: number,
  pointY: number,
  pointZ: number,
  probeRadius: number,
  out: RockContact,
): boolean {
  toLocal(localPoint, q, centerX, centerY, centerZ, scale, pointX, pointY, pointZ);
  const hit = mesh.bvh.sphereDeepestContact(localPoint, probeRadius / scale);
  if (!hit) return deepContact(mesh, scale, q, out, probeRadius);
  rotateToWorld(out, q, hit.normal.x, hit.normal.y, hit.normal.z);
  out.depth = hit.depth * scale;
  return normalizeContact(out);
}

/**
 * DEEP PENETRATION recovery, for a probe further inside the body than its own
 * radius. {@link TriangleBvh.sphereDeepestContact} only sees triangles within
 * `radius` of its centre, so a hull that has tunnelled into a rock — or spawned
 * in one — finds nothing and would be reported as standing in clear space.
 *
 * The recovery is radial: measure the surface along the direction the probe
 * already lies in, and if the probe is inside it, push straight out. That is the
 * same answer the radial field gives natively, it is monotone (every step moves
 * toward the outside), and it only ever runs for a probe the sphere query has
 * already declared clear — so the accurate near-surface contact, concavities
 * included, is never overridden by it.
 *
 * `localPoint` is the probe centre in local space, already written by the caller.
 */
function deepContact(
  mesh: ResolvedRockMesh,
  scale: number,
  q: RockQuat,
  out: RockContact,
  probeRadius: number,
): boolean {
  const distance = Math.hypot(localPoint.x, localPoint.y, localPoint.z);
  // Outside the inner sphere the query above is authoritative: anything out
  // there is either genuinely clear or within reach of a triangle.
  if (distance >= mesh.minRadius) return false;
  if (distance <= 1e-9) {
    // Dead centre has no radial direction; push along +x, which is as good as
    // any and keeps the result deterministic.
    rotateToWorld(out, q, 1, 0, 0);
    out.depth = mesh.minRadius * scale + probeRadius;
    return normalizeContact(out);
  }
  const surface = localSurfaceRadius(mesh, localPoint.x, localPoint.y, localPoint.z);
  if (surface < 0 || distance >= surface) return false;
  rotateToWorld(out, q, localPoint.x / distance, localPoint.y / distance, localPoint.z / distance);
  out.depth = (surface - distance) * scale + probeRadius;
  return normalizeContact(out);
}

/** Unit-length the contact normal in place; falls back to +x if it degenerates. */
function normalizeContact(out: RockContact): boolean {
  const length = Math.hypot(out.nx, out.ny, out.nz);
  if (length > 1e-9) {
    out.nx /= length;
    out.ny /= length;
    out.nz /= length;
  } else {
    out.nx = 1;
    out.ny = 0;
    out.nz = 0;
  }
  return true;
}

/**
 * Entry parameter in `[0, 1]` of a swept probe along `from`→`to`, or `-1` for a
 * miss.
 *
 * The mesh narrowphase treats the sweep as a RAY plus an "already overlapping at
 * the start" test, rather than marching a sphere down the segment. The probe
 * radius still widens the caller's bounding-sphere broadphase, so nothing is
 * rejected early; what it does not do is add the grazing band around the ray.
 * At `PROJECTILE_RADIUS` 0.4 against rocks 3–13 units across that band is a few
 * percent of the silhouette, and buying it back would cost one full BVH sphere
 * traversal per march step on a path that runs per projectile per rock per tick.
 * A shot that grazes the rim now flies past instead of clipping — which is the
 * side of the error this whole change exists to move toward.
 */
export function rockMeshSegmentEntry(
  mesh: ResolvedRockMesh,
  scale: number,
  q: RockQuat,
  centerX: number,
  centerY: number,
  centerZ: number,
  from: { x: number; y: number; z: number },
  to: { x: number; y: number; z: number },
  probeRadius: number,
): number {
  toLocal(localFrom, q, centerX, centerY, centerZ, scale, from.x, from.y, from.z);
  toLocal(localTo, q, centerX, centerY, centerZ, scale, to.x, to.y, to.z);
  // A sweep that BEGINS in the rock enters at t = 0 — the legacy sphere said so
  // (`if (c <= 0) return 0`) and a point query on the body centre has no
  // triangle to hit at all, so without this a zero-length probe inside solid
  // rock would report clear space.
  if (startsInside(mesh, probeRadius / scale)) return 0;
  const hit = mesh.bvh.segmentIntersect(localFrom, localTo);
  return hit ? hit.t : -1;
}

/**
 * Is {@link localFrom} inside the body (or within `localProbeRadius` of it)?
 *
 * Ordered cheapest-first, because this runs on every projectile and sight-line
 * query: a squared length against the two precomputed spheres answers the
 * overwhelming majority — a shot that starts anywhere outside the rock's bounds
 * costs one comparison — and only a probe genuinely between the inner and outer
 * spheres pays for a traversal.
 */
function startsInside(mesh: ResolvedRockMesh, localProbeRadius: number): boolean {
  const distance = Math.hypot(localFrom.x, localFrom.y, localFrom.z);
  if (distance > mesh.maxRadius + localProbeRadius) return false;
  if (distance < mesh.minRadius) return true;
  if (localProbeRadius > 0 && mesh.bvh.sphereDeepestContact(localFrom, localProbeRadius)) return true;
  const surface = localSurfaceRadius(mesh, localFrom.x, localFrom.y, localFrom.z);
  return surface >= 0 && distance < surface;
}

/**
 * Surface radius in world units along the direction from the body centre toward
 * `(dx, dy, dz)`. The mesh twin of
 * {@link import("./rockShape.js").rockWorldRadius}.
 */
export function rockMeshWorldRadius(
  mesh: ResolvedRockMesh,
  scale: number,
  q: RockQuat,
  dx: number,
  dy: number,
  dz: number,
): number {
  const length = Math.hypot(dx, dy, dz);
  if (length <= 1e-9) return mesh.minRadius * scale;
  // The body centre is the origin, so this is a pure inverse rotation.
  toLocal(localPoint, q, 0, 0, 0, 1, dx / length, dy / length, dz / length);
  const surface = localSurfaceRadius(mesh, localPoint.x, localPoint.y, localPoint.z);
  return (surface < 0 ? mesh.meanRadius : surface) * scale;
}

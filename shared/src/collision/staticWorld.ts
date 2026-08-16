import type { PropConfig } from "../schemas/prop.js";
import type { ArenaConfig } from "../schemas/arena.js";
import { decodeFloat32Array, decodeUint32Array } from "./base64.js";
import { TriangleBvh, type Point3 } from "./bvh.js";

type Placement = NonNullable<ArenaConfig["propPlacements"]>[number];
interface Matrix3 { m00: number; m01: number; m02: number; m10: number; m11: number; m12: number; m20: number; m21: number; m22: number }
interface BuiltPlacement {
  index: number; config: PropConfig; bvh: TriangleBvh; position: Point3; rotation: Matrix3; scale: number;
  min: Point3; max: Point3;
}

export interface StaticRayHit { t: number; point: Point3; normal: Point3; placementIndex: number }
export interface StaticSphereContact { depth: number; point: Point3; normal: Point3; placementIndex: number }

const bvhCache = new WeakMap<PropConfig, TriangleBvh>();

export class StaticWorld {
  private readonly built: BuiltPlacement[];

  constructor(placements: readonly Placement[], resolve: (id: string) => PropConfig | undefined) {
    this.built = [];
    for (let index = 0; index < placements.length; index++) {
      const authored = placements[index]!;
      const config = resolve(authored.propId);
      if (!config?.collision) continue;
      let bvh = bvhCache.get(config);
      if (!bvh) {
        bvh = new TriangleBvh({
          positions: decodeFloat32Array(config.collision.positions),
          indices: decodeUint32Array(config.collision.indices),
        });
        bvhCache.set(config, bvh);
      }
      const position = { x: authored.position.x, y: authored.position.y ?? 0, z: authored.position.z };
      const rotation = yawPitchRoll(authored.rotation?.y ?? 0, authored.rotation?.x ?? 0, authored.rotation?.z ?? 0);
      const scale = authored.scale ?? 1;
      const worldBounds = transformedBounds(config.collision.bounds, position, rotation, scale);
      this.built.push({ index, config, bvh, position, rotation, scale, ...worldBounds });
    }
  }

  get isEmpty(): boolean { return this.built.length === 0; }

  configAt(placementIndex: number): PropConfig | undefined {
    return this.built.find((p) => p.index === placementIndex)?.config;
  }

  raycast(from: Point3, to: Point3): StaticRayHit | null {
    let best: StaticRayHit | null = null;
    for (const p of this.built) {
      if (!segmentBounds(from, to, p.min, p.max, best?.t ?? 1)) continue;
      const localFrom = inversePoint(from, p);
      const localTo = inversePoint(to, p);
      const hit = p.bvh.segmentIntersect(localFrom, localTo);
      if (!hit || (best && hit.t >= best.t)) continue;
      best = { t: hit.t, point: worldPoint(hit.point, p), normal: worldNormal(hit.normal, p.rotation), placementIndex: p.index };
    }
    return best;
  }

  sphereContact(center: Point3, radius: number): StaticSphereContact | null {
    let best: StaticSphereContact | null = null;
    for (const p of this.built) {
      if (center.x + radius < p.min.x || center.x - radius > p.max.x || center.y + radius < p.min.y || center.y - radius > p.max.y || center.z + radius < p.min.z || center.z - radius > p.max.z) continue;
      const hit = p.bvh.sphereDeepestContact(inversePoint(center, p), radius / p.scale);
      if (!hit) continue;
      const contact = { depth: hit.depth * p.scale, point: worldPoint(hit.point, p), normal: worldNormal(hit.normal, p.rotation), placementIndex: p.index };
      if (!best || contact.depth > best.depth || (contact.depth === best.depth && contact.placementIndex < best.placementIndex)) best = contact;
    }
    return best;
  }

  heightBelow(pos: Point3, maxDrop: number): { y: number; normal: Point3 } | null {
    const hit = this.raycast(pos, { x: pos.x, y: pos.y - maxDrop, z: pos.z });
    return hit ? { y: hit.point.y, normal: hit.normal } : null;
  }
}

function yawPitchRoll(y: number, x: number, z: number): Matrix3 {
  const cy = Math.cos(y), sy = Math.sin(y), cx = Math.cos(x), sx = Math.sin(x), cz = Math.cos(z), sz = Math.sin(z);
  return {
    m00: cy * cz + sy * sx * sz, m01: -cy * sz + sy * sx * cz, m02: sy * cx,
    m10: cx * sz, m11: cx * cz, m12: -sx,
    m20: -sy * cz + cy * sx * sz, m21: sy * sz + cy * sx * cz, m22: cy * cx,
  };
}

function rotate(v: Point3, m: Matrix3): Point3 {
  return { x: m.m00 * v.x + m.m01 * v.y + m.m02 * v.z, y: m.m10 * v.x + m.m11 * v.y + m.m12 * v.z, z: m.m20 * v.x + m.m21 * v.y + m.m22 * v.z };
}

function inverseRotate(v: Point3, m: Matrix3): Point3 {
  return { x: m.m00 * v.x + m.m10 * v.y + m.m20 * v.z, y: m.m01 * v.x + m.m11 * v.y + m.m21 * v.z, z: m.m02 * v.x + m.m12 * v.y + m.m22 * v.z };
}

function inversePoint(v: Point3, p: BuiltPlacement): Point3 {
  const shifted = { x: (v.x - p.position.x) / p.scale, y: (v.y - p.position.y) / p.scale, z: (v.z - p.position.z) / p.scale };
  return inverseRotate(shifted, p.rotation);
}

function worldPoint(v: Point3, p: BuiltPlacement): Point3 {
  const r = rotate(v, p.rotation);
  return { x: p.position.x + r.x * p.scale, y: p.position.y + r.y * p.scale, z: p.position.z + r.z * p.scale };
}

function worldNormal(v: Point3, rotation: Matrix3): Point3 {
  const r = rotate(v, rotation), length = Math.hypot(r.x, r.y, r.z) || 1;
  return { x: r.x / length, y: r.y / length, z: r.z / length };
}

function transformedBounds(bounds: { min: Point3; max: Point3 }, position: Point3, rotation: Matrix3, scale: number): { min: Point3; max: Point3 } {
  const min = { x: Infinity, y: Infinity, z: Infinity }, max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
    const r = rotate({ x, y, z }, rotation);
    const wx = position.x + r.x * scale, wy = position.y + r.y * scale, wz = position.z + r.z * scale;
    min.x = Math.min(min.x, wx); min.y = Math.min(min.y, wy); min.z = Math.min(min.z, wz);
    max.x = Math.max(max.x, wx); max.y = Math.max(max.y, wy); max.z = Math.max(max.z, wz);
  }
  return { min, max };
}

/**
 * Running slab range for {@link segmentBounds}, at module level so a
 * six-comparison test allocates nothing.
 *
 * Safe as shared mutable state because it is never live across a call that could
 * re-enter: `slabAxis` is pure arithmetic, and `segmentBounds` has fully returned
 * before `raycast` does anything else. (`heightBelow` re-enters `raycast` at the
 * METHOD level, which is a different frame — by then this scratch is dead.)
 */
const slab = { lo: 0, hi: 0 };

/**
 * One slab axis, narrowing {@link slab}. False means a provable miss.
 *
 * The parallel-axis branch reproduces the original loop's `continue` exactly,
 * including for a NaN origin: both comparisons are false, so it returns true and
 * the axis is skipped, as before. `Math.max`/`Math.min` are kept verbatim rather
 * than rewritten as comparisons — they differ on NaN and -0, and this divides by
 * a delta that can be zero-ish.
 */
function slabAxis(origin: number, delta: number, low: number, high: number): boolean {
  if (Math.abs(delta) < 1e-15) return !(origin < low || origin > high);
  let a = (low - origin) / delta;
  let b = (high - origin) / delta;
  // Unconditional swap, so a temp is bit-identical to the destructured form
  // (and on NaN neither swaps).
  if (a > b) { const t = a; a = b; b = t; }
  slab.lo = Math.max(slab.lo, a);
  slab.hi = Math.min(slab.hi, b);
  return !(slab.lo > slab.hi);
}

/**
 * Segment vs AABB. Was a `for…of` over an array-of-tuple literal, which
 * allocated one outer array plus three 4-element tuples per call — and a fourth
 * on every `[a,b] = [b,a]` swap — to run six comparisons. It is the hottest
 * function in the bot phase on the CTF terrain, so the allocation dominated the
 * arithmetic. `&&` short-circuits exactly where the loop used to `return false`.
 */
function segmentBounds(from: Point3, to: Point3, min: Point3, max: Point3, maxT: number): boolean {
  slab.lo = 0;
  slab.hi = maxT;
  return slabAxis(from.x, to.x - from.x, min.x, max.x)
    && slabAxis(from.y, to.y - from.y, min.y, max.y)
    && slabAxis(from.z, to.z - from.z, min.z, max.z);
}

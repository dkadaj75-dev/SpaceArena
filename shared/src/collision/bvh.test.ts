import { describe, expect, it } from "vitest";
import { TriangleBvh, type CollisionMesh, type Point3, type SegmentHit, type SphereContact } from "./bvh.js";

function rng(seed = 0x51a7): () => number {
  let state = seed >>> 0;
  return () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 0x100000000);
}

describe("TriangleBvh", () => {
  it("matches a triangle-by-triangle brute force over 10000 seeded queries", () => {
    const random = rng();
    const positions: number[] = [];
    const indices: number[] = [];
    for (let tri = 0; tri < 48; tri++) {
      const cx = random() * 20 - 10, cy = random() * 20 - 10, cz = random() * 20 - 10;
      for (let vertex = 0; vertex < 3; vertex++) {
        positions.push(cx + random() * 2 - 1, cy + random() * 2 - 1, cz + random() * 2 - 1);
        indices.push(tri * 3 + vertex);
      }
    }
    const mesh = { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
    const tree = new TriangleBvh(mesh);
    for (let query = 0; query < 10_000; query++) {
      const center = point(random, 12);
      if ((query & 1) === 0) {
        const to = point(random, 12);
        const expected = naiveSegment(mesh, center, to);
        const actual = tree.segmentIntersect(center, to);
        expect(actual?.t ?? null).toBeCloseTo(expected?.t ?? 0, expected ? 10 : 0);
        expect(actual === null).toBe(expected === null);
        if (query % 1000 === 0 && expected && actual) {
          expect(actual.triIndex).toBe(expected.triIndex);
          expect(actual.point).toEqual(expected.point);
          expect(actual.normal).toEqual(expected.normal);
        }
      } else {
        const radius = 0.25 + random() * 2;
        const expected = naiveSphere(mesh, center, radius);
        const actual = tree.sphereDeepestContact(center, radius);
        expect(actual?.depth ?? null).toBeCloseTo(expected?.depth ?? 0, expected ? 9 : 0);
        expect(actual === null).toBe(expected === null);
        if (query % 1001 === 1 && expected && actual) {
          expect(actual.triIndex).toBe(expected.triIndex);
          expect(actual.point).toEqual(expected.point);
          expect(actual.normal).toEqual(expected.normal);
        }
      }
    }
  });

  it("returns nearest point, unit normal, and source triangle index", () => {
    const tree = new TriangleBvh({
      positions: new Float32Array([0, -1, -1, 0, 1, -1, 0, 0, 1, 3, -1, -1, 3, 1, -1, 3, 0, 1]),
      indices: new Uint32Array([0, 1, 2, 3, 4, 5]),
    });
    const hit = tree.segmentIntersect({ x: -2, y: 0, z: 0 }, { x: 5, y: 0, z: 0 });
    expect(hit).toMatchObject({ triIndex: 0 });
    expect(hit!.point.x).toBeCloseTo(0);
    expect(Math.hypot(hit!.normal.x, hit!.normal.y, hit!.normal.z)).toBeCloseTo(1);
  });

  it("matches analytic face, edge, and vertex Voronoi contacts", () => {
    const tree = planeTree();
    const cases = [
      [{ x: 1, y: 0, z: 0 }, 1.4, { x: 0, y: 0, z: 0 }, 0.4],
      [{ x: 0.2, y: 0, z: -2 }, 1.4, { x: 0, y: 0, z: -1 }, 1.4 - Math.sqrt(1.04)],
      [{ x: 0.2, y: -2, z: -2 }, 2, { x: 0, y: -1, z: -1 }, 2 - Math.sqrt(2.04)],
    ] as const;
    for (const [center, radius, point, depth] of cases) {
      const hit = tree.sphereDeepestContact(center, radius)!;
      expect(hit.triIndex).toBe(0);
      expect(hit.point).toEqual(point);
      expect(hit.depth).toBeCloseTo(depth);
      expect(Math.hypot(hit.normal.x, hit.normal.y, hit.normal.z)).toBeCloseTo(1);
    }
  });

  it("uses radius plus distance to eject centres behind the face in one iteration", () => {
    const tree = planeTree();
    for (const x of [-0.2, -1.2]) {
      const hit = tree.sphereDeepestContact({ x, y: 0, z: 0 }, 1.4)!;
      expect(x + hit.depth * hit.normal.x).toBeCloseTo(1.4);
    }
    expect(tree.sphereDeepestContact({ x: -1.69, y: 0, z: 0 }, 1.4)).toBeNull();
  });

  it("matches an analytic segment-triangle intersection", () => {
    const hit = planeTree().segmentIntersect({ x: -2, y: 0, z: 0 }, { x: 2, y: 0, z: 0 })!;
    expect(hit).toMatchObject({ t: 0.5, point: { x: 0, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 }, triIndex: 0 });
  });
});

function point(random: () => number, extent: number): Point3 {
  return { x: random() * extent * 2 - extent, y: random() * extent * 2 - extent, z: random() * extent * 2 - extent };
}

function planeTree(): TriangleBvh {
  return new TriangleBvh({ positions: new Float32Array([0, -1, -1, 0, 1, -1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]) });
}

/** Independent test oracle: plane/barycentric ray test, not the BVH triangle routine. */
function naiveSegment(mesh: CollisionMesh, from: Point3, to: Point3): SegmentHit | null {
  let best: SegmentHit | null = null;
  for (let triIndex = 0; triIndex < mesh.indices.length / 3; triIndex++) {
    const [a, b, c] = naiveTriangle(mesh, triIndex);
    const normal = naiveNormal(a, b, c);
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
    const denom = normal.x * dx + normal.y * dy + normal.z * dz;
    if (Math.abs(denom) < 1e-12) continue;
    const t = (normal.x * (a.x - from.x) + normal.y * (a.y - from.y) + normal.z * (a.z - from.z)) / denom;
    if (t < 0 || t > 1) continue;
    const point = { x: from.x + dx * t, y: from.y + dy * t, z: from.z + dz * t };
    if (!insideTriangle(point, a, b, c, normal)) continue;
    const hit = { t, point, normal, triIndex };
    if (!best || t < best.t || (t === best.t && triIndex < best.triIndex)) best = hit;
  }
  return best;
}

function naiveSphere(mesh: CollisionMesh, center: Point3, radius: number): SphereContact | null {
  let best: SphereContact | null = null;
  for (let triIndex = 0; triIndex < mesh.indices.length / 3; triIndex++) {
    const [a, b, c] = naiveTriangle(mesh, triIndex);
    const point = naiveClosest(center, a, b, c);
    let nx = center.x - point.x, ny = center.y - point.y, nz = center.z - point.z;
    const dist = Math.hypot(nx, ny, nz);
    if (dist > radius) continue;
    const surface = naiveNormal(a, b, c);
    const inside = dist > 1e-12 && (nx * surface.x + ny * surface.y + nz * surface.z) < 0;
    if (dist <= 1e-12 || inside) ({ x: nx, y: ny, z: nz } = surface);
    else ({ x: nx, y: ny, z: nz } = { x: nx / dist, y: ny / dist, z: nz / dist });
    const hit = { depth: inside ? radius + dist : radius - dist, point, normal: { x: nx, y: ny, z: nz }, triIndex };
    if (!best || hit.depth > best.depth || (hit.depth === best.depth && triIndex < best.triIndex)) best = hit;
  }
  return best;
}

function naiveTriangle(mesh: CollisionMesh, tri: number): [Point3, Point3, Point3] {
  const point = (offset: number): Point3 => {
    const i = mesh.indices[tri * 3 + offset]! * 3;
    return { x: mesh.positions[i]!, y: mesh.positions[i + 1]!, z: mesh.positions[i + 2]! };
  };
  return [point(0), point(1), point(2)];
}

function naiveNormal(a: Point3, b: Point3, c: Point3): Point3 {
  let x = (b.y - a.y) * (c.z - a.z) - (b.z - a.z) * (c.y - a.y);
  let y = (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z);
  let z = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const length = Math.hypot(x, y, z);
  if (length > 0) { x /= length; y /= length; z /= length; }
  return { x, y, z };
}

function insideTriangle(p: Point3, a: Point3, b: Point3, c: Point3, normal: Point3): boolean {
  const side = (u: Point3, v: Point3): number => {
    const ex = v.x - u.x, ey = v.y - u.y, ez = v.z - u.z;
    const px = p.x - u.x, py = p.y - u.y, pz = p.z - u.z;
    return (ey * pz - ez * py) * normal.x + (ez * px - ex * pz) * normal.y + (ex * py - ey * px) * normal.z;
  };
  const ab = side(a, b), bc = side(b, c), ca = side(c, a);
  return (ab >= -1e-10 && bc >= -1e-10 && ca >= -1e-10) || (ab <= 1e-10 && bc <= 1e-10 && ca <= 1e-10);
}

function naiveClosest(p: Point3, a: Point3, b: Point3, c: Point3): Point3 {
  const normal = naiveNormal(a, b, c);
  const plane = (p.x - a.x) * normal.x + (p.y - a.y) * normal.y + (p.z - a.z) * normal.z;
  const projected = { x: p.x - normal.x * plane, y: p.y - normal.y * plane, z: p.z - normal.z * plane };
  if (insideTriangle(projected, a, b, c, normal)) return projected;
  const candidates = [closestOnSegment(p, a, b), closestOnSegment(p, b, c), closestOnSegment(p, c, a)];
  return candidates.reduce((best, candidate) => squaredDistance(p, candidate) < squaredDistance(p, best) ? candidate : best);
}

function closestOnSegment(p: Point3, a: Point3, b: Point3): Point3 {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  const denom = dx * dx + dy * dy + dz * dz;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy + (p.z - a.z) * dz) / denom));
  return { x: a.x + dx * t, y: a.y + dy * t, z: a.z + dz * t };
}

function squaredDistance(a: Point3, b: Point3): number {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;
}

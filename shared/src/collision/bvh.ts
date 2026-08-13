export interface CollisionMesh {
  positions: Float32Array;
  indices: Uint32Array;
}

export interface Point3 { x: number; y: number; z: number }
export interface SegmentHit { t: number; point: Point3; normal: Point3; triIndex: number }
export interface SphereContact { depth: number; point: Point3; normal: Point3; triIndex: number }

interface Node {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
  start: number; count: number; left: number; right: number;
}

const LEAF_TRIANGLES = 8;

export class TriangleBvh {
  readonly nodes: Node[] = [];
  private readonly order: number[];

  constructor(readonly mesh: CollisionMesh) {
    const triCount = Math.floor(mesh.indices.length / 3);
    this.order = Array.from({ length: triCount }, (_, i) => i);
    if (triCount === 0) return;
    this.nodes.push(emptyNode(0, triCount));
    const pending = [0];
    while (pending.length > 0) {
      const nodeIndex = pending.pop()!;
      const node = this.nodes[nodeIndex]!;
      boundsForRange(mesh, this.order, node);
      if (node.count <= LEAF_TRIANGLES) continue;
      const ex = node.maxX - node.minX;
      const ey = node.maxY - node.minY;
      const ez = node.maxZ - node.minZ;
      const axis = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2;
      const sorted = this.order.slice(node.start, node.start + node.count).sort((a, b) => {
        const d = centroid(mesh, a, axis) - centroid(mesh, b, axis);
        return d === 0 ? a - b : d;
      });
      for (let i = 0; i < sorted.length; i++) this.order[node.start + i] = sorted[i]!;
      const leftCount = Math.floor(node.count / 2);
      node.left = this.nodes.length;
      node.right = node.left + 1;
      this.nodes.push(emptyNode(node.start, leftCount), emptyNode(node.start + leftCount, node.count - leftCount));
      node.count = 0;
      pending.push(node.right, node.left);
    }
  }

  segmentIntersect(from: Point3, to: Point3): SegmentHit | null {
    if (this.nodes.length === 0) return null;
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
    let best: SegmentHit | null = null;
    const stack = [0];
    while (stack.length > 0) {
      const node = this.nodes[stack.pop()!]!;
      if (!segmentAabb(from, dx, dy, dz, node, best?.t ?? 1)) continue;
      if (node.count === 0) {
        stack.push(node.right, node.left);
        continue;
      }
      for (let i = node.start; i < node.start + node.count; i++) {
        const tri = this.order[i]!;
        const hit = triangleSegment(this.mesh, tri, from, dx, dy, dz);
        if (hit && (!best || hit.t < best.t || (hit.t === best.t && tri < best.triIndex))) best = hit;
      }
    }
    return best;
  }

  sphereDeepestContact(center: Point3, radius: number): SphereContact | null {
    if (this.nodes.length === 0) return null;
    const radiusSq = radius * radius;
    let best: SphereContact | null = null;
    const stack = [0];
    while (stack.length > 0) {
      const node = this.nodes[stack.pop()!]!;
      if (pointAabbDistanceSq(center, node) > radiusSq) continue;
      if (node.count === 0) {
        stack.push(node.right, node.left);
        continue;
      }
      for (let i = node.start; i < node.start + node.count; i++) {
        const tri = this.order[i]!;
        const point = closestOnTriangle(this.mesh, tri, center);
        let nx = center.x - point.x, ny = center.y - point.y, nz = center.z - point.z;
        const distSq = nx * nx + ny * ny + nz * nz;
        if (distSq > radiusSq) continue;
        const dist = Math.sqrt(distSq);
        const surfaceNormal = triangleNormal(this.mesh, tri);
        let insideFace = false;
        if (dist > 1e-12) {
          nx /= dist; ny /= dist; nz /= dist;
          // Authored solid meshes wind outward. Outside the surface the
          // point-to-centre direction is already outward; inside it points
          // deeper into the solid, so use the triangle's authored outward
          // normal instead.
          if (nx * surfaceNormal.x + ny * surfaceNormal.y + nz * surfaceNormal.z < 0) {
            insideFace = true;
            nx = surfaceNormal.x; ny = surfaceNormal.y; nz = surfaceNormal.z;
          }
        } else {
          nx = surfaceNormal.x; ny = surfaceNormal.y; nz = surfaceNormal.z;
        }
        const contact = { depth: insideFace ? radius + dist : radius - dist, point, normal: { x: nx, y: ny, z: nz }, triIndex: tri };
        if (!best || contact.depth > best.depth || (contact.depth === best.depth && tri < best.triIndex)) best = contact;
      }
    }
    return best;
  }
}

function emptyNode(start: number, count: number): Node {
  return { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0, start, count, left: -1, right: -1 };
}

function vertex(mesh: CollisionMesh, index: number): [number, number, number] {
  const o = mesh.indices[index]! * 3;
  return [mesh.positions[o]!, mesh.positions[o + 1]!, mesh.positions[o + 2]!];
}

function centroid(mesh: CollisionMesh, tri: number, axis: number): number {
  return (vertex(mesh, tri * 3)[axis]! + vertex(mesh, tri * 3 + 1)[axis]! + vertex(mesh, tri * 3 + 2)[axis]!) / 3;
}

function boundsForRange(mesh: CollisionMesh, order: number[], node: Node): void {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = node.start; i < node.start + node.count; i++) {
    const tri = order[i]!;
    for (let j = 0; j < 3; j++) {
      const [x, y, z] = vertex(mesh, tri * 3 + j);
      minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z);
    }
  }
  node.minX = minX; node.minY = minY; node.minZ = minZ;
  node.maxX = maxX; node.maxY = maxY; node.maxZ = maxZ;
}

function segmentAabb(p: Point3, dx: number, dy: number, dz: number, n: Node, maxT: number): boolean {
  let lo = 0, hi = maxT;
  for (const [origin, dir, min, max] of [[p.x, dx, n.minX, n.maxX], [p.y, dy, n.minY, n.maxY], [p.z, dz, n.minZ, n.maxZ]] as const) {
    if (Math.abs(dir) < 1e-15) { if (origin < min || origin > max) return false; continue; }
    let a = (min - origin) / dir, b = (max - origin) / dir;
    if (a > b) [a, b] = [b, a];
    lo = Math.max(lo, a); hi = Math.min(hi, b);
    if (lo > hi) return false;
  }
  return true;
}

function triangleSegment(mesh: CollisionMesh, tri: number, p: Point3, dx: number, dy: number, dz: number): SegmentHit | null {
  const a = vertex(mesh, tri * 3), b = vertex(mesh, tri * 3 + 1), c = vertex(mesh, tri * 3 + 2);
  const e1x = b[0] - a[0], e1y = b[1] - a[1], e1z = b[2] - a[2];
  const e2x = c[0] - a[0], e2y = c[1] - a[1], e2z = c[2] - a[2];
  const hx = dy * e2z - dz * e2y, hy = dz * e2x - dx * e2z, hz = dx * e2y - dy * e2x;
  const det = e1x * hx + e1y * hy + e1z * hz;
  if (Math.abs(det) < 1e-12) return null;
  const inv = 1 / det;
  const sx = p.x - a[0], sy = p.y - a[1], sz = p.z - a[2];
  const u = (sx * hx + sy * hy + sz * hz) * inv;
  if (u < 0 || u > 1) return null;
  const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < 0 || u + v > 1) return null;
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  if (t < 0 || t > 1) return null;
  const normal = triangleNormal(mesh, tri);
  return { t, point: { x: p.x + dx * t, y: p.y + dy * t, z: p.z + dz * t }, normal, triIndex: tri };
}

function triangleNormal(mesh: CollisionMesh, tri: number): Point3 {
  const a = vertex(mesh, tri * 3), b = vertex(mesh, tri * 3 + 1), c = vertex(mesh, tri * 3 + 2);
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  let x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
  const len = Math.hypot(x, y, z);
  if (len > 0) { x /= len; y /= len; z /= len; }
  return { x, y, z };
}

function pointAabbDistanceSq(p: Point3, n: Node): number {
  const dx = p.x < n.minX ? n.minX - p.x : p.x > n.maxX ? p.x - n.maxX : 0;
  const dy = p.y < n.minY ? n.minY - p.y : p.y > n.maxY ? p.y - n.maxY : 0;
  const dz = p.z < n.minZ ? n.minZ - p.z : p.z > n.maxZ ? p.z - n.maxZ : 0;
  return dx * dx + dy * dy + dz * dz;
}

function closestOnTriangle(mesh: CollisionMesh, tri: number, p: Point3): Point3 {
  const a = vertex(mesh, tri * 3), b = vertex(mesh, tri * 3 + 1), c = vertex(mesh, tri * 3 + 2);
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
  const acx = c[0] - a[0], acy = c[1] - a[1], acz = c[2] - a[2];
  const apx = p.x - a[0], apy = p.y - a[1], apz = p.z - a[2];
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return { x: a[0], y: a[1], z: a[2] };
  const bpx = p.x - b[0], bpy = p.y - b[1], bpz = p.z - b[2];
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return { x: b[0], y: b[1], z: b[2] };
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return { x: a[0] + v * abx, y: a[1] + v * aby, z: a[2] + v * abz }; }
  const cpx = p.x - c[0], cpy = p.y - c[1], cpz = p.z - c[2];
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return { x: c[0], y: c[1], z: c[2] };
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return { x: a[0] + w * acx, y: a[1] + w * acy, z: a[2] + w * acz }; }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); return { x: b[0] + w * (c[0] - b[0]), y: b[1] + w * (c[1] - b[1]), z: b[2] + w * (c[2] - b[2]) }; }
  const denom = 1 / (va + vb + vc), v = vb * denom, w = vc * denom;
  return { x: a[0] + abx * v + acx * w, y: a[1] + aby * v + acy * w, z: a[2] + abz * v + acz * w };
}

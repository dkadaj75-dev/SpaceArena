/**
 * A brute-force triangle soup for the generator's own self-checks. The shipped
 * BVH lives in `shared/src/collision`, but the tool must not import shared (it
 * validates the bytes it is about to write, and it has to work before that
 * slice lands), so this is a deliberately tiny stand-in: a few hundred queries
 * over ~50k triangles is milliseconds.
 */
export interface PlacedMesh {
  positions: Float32Array;
  indices: Uint32Array;
  offset: { x: number; y: number; z: number };
}

export class CollisionWorld {
  private readonly tris: Float64Array;
  private readonly count: number;

  constructor(meshes: readonly PlacedMesh[]) {
    let total = 0;
    for (const mesh of meshes) total += mesh.indices.length / 3;
    this.tris = new Float64Array(total * 9);
    this.count = total;
    let k = 0;
    for (const mesh of meshes) {
      for (let i = 0; i < mesh.indices.length; i += 3) {
        for (let c = 0; c < 3; c++) {
          const v = mesh.indices[i + c]!;
          this.tris[k++] = mesh.positions[v * 3]! + mesh.offset.x;
          this.tris[k++] = mesh.positions[v * 3 + 1]! + mesh.offset.y;
          this.tris[k++] = mesh.positions[v * 3 + 2]! + mesh.offset.z;
        }
      }
    }
  }

  get triangleCount(): number {
    return this.count;
  }

  /** Highest surface at or below `y` under (x, z), or null within `maxDrop`. */
  heightBelow(x: number, y: number, z: number, maxDrop: number): number | null {
    let best: number | null = null;
    const floor = y - maxDrop;
    for (let t = 0; t < this.count; t++) {
      const o = t * 9;
      const ax = this.tris[o]!, az = this.tris[o + 2]!;
      const bx = this.tris[o + 3]!, bz = this.tris[o + 5]!;
      const cx = this.tris[o + 6]!, cz = this.tris[o + 8]!;
      const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (d === 0) continue;
      const w0 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
      if (w0 < 0 || w0 > 1) continue;
      const w1 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
      if (w1 < 0 || w1 > 1) continue;
      const w2 = 1 - w0 - w1;
      if (w2 < 0 || w2 > 1) continue;
      const hit = w0 * this.tris[o + 1]! + w1 * this.tris[o + 4]! + w2 * this.tris[o + 7]!;
      if (hit > y + 1e-6 || hit < floor) continue;
      if (best === null || hit > best) best = hit;
    }
    return best;
  }

  /** Distance from a point to the nearest triangle. */
  nearestDistance(x: number, y: number, z: number): number {
    let best = Infinity;
    for (let t = 0; t < this.count; t++) {
      const o = t * 9;
      const d = pointTriangleDistanceSquared(
        x, y, z,
        this.tris[o]!, this.tris[o + 1]!, this.tris[o + 2]!,
        this.tris[o + 3]!, this.tris[o + 4]!, this.tris[o + 5]!,
        this.tris[o + 6]!, this.tris[o + 7]!, this.tris[o + 8]!,
      );
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  }
}

/** Ericson, Real-Time Collision Detection §5.1.5 — closest point on a triangle. */
function pointTriangleDistanceSquared(
  px: number, py: number, pz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
): number {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  let qx: number, qy: number, qz: number;
  if (d1 <= 0 && d2 <= 0) { qx = ax; qy = ay; qz = az; }
  else {
    const bpx = px - bx, bpy = py - by, bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz;
    const d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) { qx = bx; qy = by; qz = bz; }
    else {
      const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
      const d5 = abx * cpx + aby * cpy + abz * cpz;
      const d6 = acx * cpx + acy * cpy + acz * cpz;
      if (d6 >= 0 && d5 <= d6) { qx = cx; qy = cy; qz = cz; }
      else {
        const vc = d1 * d4 - d3 * d2;
        if (vc <= 0 && d1 >= 0 && d3 <= 0) {
          const v = d1 / (d1 - d3);
          qx = ax + abx * v; qy = ay + aby * v; qz = az + abz * v;
        } else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) {
            const w = d2 / (d2 - d6);
            qx = ax + acx * w; qy = ay + acy * w; qz = az + acz * w;
          } else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
              const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
              qx = bx + (cx - bx) * w; qy = by + (cy - by) * w; qz = bz + (cz - bz) * w;
            } else {
              const denom = 1 / (va + vb + vc);
              const v = vb * denom, w = vc * denom;
              qx = ax + abx * v + acx * w; qy = ay + aby * v + acy * w; qz = az + abz * v + acz * w;
            }
          }
        }
      }
    }
  }
  const dx = px - qx, dy = py - qy, dz = pz - qz;
  return dx * dx + dy * dy + dz * dz;
}

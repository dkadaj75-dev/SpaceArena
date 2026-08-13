/**
 * manifold-3d wrapper for the tunnel bores.
 *
 * A chunk is solidified (top surface grid + extruded sides + flat bottom) into a
 * watertight volume, the bore cylinders are subtracted, and the result comes
 * back as a plain indexed mesh. The sides and the bottom are stripped again by
 * the caller — they exist only so manifold has a closed solid to cut.
 */
import ManifoldModule from "manifold-3d";
import type { Manifold as ManifoldType, ManifoldToplevel } from "manifold-3d";
import type { Bore } from "./field.js";

export interface IndexedMesh {
  positions: Float32Array;
  indices: Uint32Array;
}

let toplevel: ManifoldToplevel | null = null;

export async function loadCsg(): Promise<ManifoldToplevel> {
  if (!toplevel) {
    const wasm = await ManifoldModule();
    wasm.setup();
    toplevel = wasm;
  }
  return toplevel;
}

export interface BoreCutOptions {
  /** Segments around the circumference. */
  readonly segments: number;
  /** Spacing of rings ALONG the bore. Without rings there is nothing to rib. */
  readonly ringSpacing: number;
  /** Outward-only radial offset, in world units (>= 0, never into the bore). */
  readonly displace: (x: number, y: number, z: number) => number;
}

/**
 * The cutting tool for one bore: a ribbed tube, not a lathe-perfect cylinder.
 * The radial noise is baked into the SOLID before the boolean, because
 * manifold's own `cylinder()` carries no rings along its axis — displacing the
 * output afterwards would have no vertices to move and would just shear the
 * two long quads that make up each facet.
 */
function boreSolid(wasm: ManifoldToplevel, bore: Bore, radius: number, options: BoreCutOptions): ManifoldType {
  const { Manifold, Mesh } = wasm;
  const { segments } = options;
  const rings = Math.max(2, Math.round(bore.length / options.ringSpacing) + 1);
  const ax = bore.dir[0], az = bore.dir[2];
  // Right-handed frame (u, v, axis): cross(u, v) = axis.
  const ux = 0, uy = 1, uz = 0;
  const vx = -az, vy = 0, vz = ax;

  const positions = new Float32Array((rings * segments + 2) * 3);
  for (let r = 0; r < rings; r++) {
    const t = (bore.length * r) / (rings - 1);
    const cx = bore.start[0] + ax * t, cy = bore.start[1], cz = bore.start[2] + az * t;
    for (let s = 0; s < segments; s++) {
      const theta = (s / segments) * Math.PI * 2;
      const ct = Math.cos(theta), st = Math.sin(theta);
      const rx = ux * ct + vx * st, ry = uy * ct + vy * st, rz = uz * ct + vz * st;
      const rr = radius + options.displace(cx + rx * radius, cy + ry * radius, cz + rz * radius);
      const o = (r * segments + s) * 3;
      positions[o] = cx + rx * rr; positions[o + 1] = cy + ry * rr; positions[o + 2] = cz + rz * rr;
    }
  }
  const capA = rings * segments, capB = capA + 1;
  positions[capA * 3] = bore.start[0]; positions[capA * 3 + 1] = bore.start[1]; positions[capA * 3 + 2] = bore.start[2];
  positions[capB * 3] = bore.end[0]; positions[capB * 3 + 1] = bore.end[1]; positions[capB * 3 + 2] = bore.end[2];

  const indices = new Uint32Array(((rings - 1) * segments * 2 + segments * 2) * 3);
  let k = 0;
  for (let r = 0; r + 1 < rings; r++) {
    for (let s = 0; s < segments; s++) {
      const s1 = (s + 1) % segments;
      const a = r * segments + s, b = r * segments + s1;
      const c = (r + 1) * segments + s, d = (r + 1) * segments + s1;
      indices[k++] = a; indices[k++] = b; indices[k++] = c;
      indices[k++] = b; indices[k++] = d; indices[k++] = c;
    }
  }
  for (let s = 0; s < segments; s++) {
    const s1 = (s + 1) % segments;
    indices[k++] = capA; indices[k++] = s1; indices[k++] = s;
    indices[k++] = capB; indices[k++] = (rings - 1) * segments + s; indices[k++] = (rings - 1) * segments + s1;
  }
  const solid = new Manifold(new Mesh({ numProp: 3, vertProperties: positions, triVerts: indices }));
  const status = solid.status();
  if (status !== "NoError") {
    solid.delete();
    throw new Error(`manifold rejected a bore tube: ${status}`);
  }
  return solid;
}

/**
 * Subtract every listed bore from `solid`. Returns the mesh unchanged when
 * there is nothing to cut, so untouched chunks skip the WASM round trip.
 */
export function subtractBores(
  wasm: ManifoldToplevel,
  solid: IndexedMesh,
  bores: readonly Bore[],
  options: BoreCutOptions,
): IndexedMesh {
  if (bores.length === 0) return solid;
  const { Manifold, Mesh } = wasm;
  const input = new Manifold(new Mesh({ numProp: 3, vertProperties: solid.positions, triVerts: solid.indices }));
  const status = input.status();
  if (status !== "NoError") {
    input.delete();
    throw new Error(`manifold rejected the chunk solid: ${status}`);
  }
  let current = input;
  const scratch: ManifoldType[] = [input];
  for (const bore of bores) {
    const cyl = boreSolid(wasm, bore, bore.tunnel.r, options);
    const next = current.subtract(cyl);
    scratch.push(cyl, next);
    current = next;
  }
  const out = current.getMesh();
  // Copy element-wise: the returned views may alias WASM memory.
  const result: IndexedMesh = {
    positions: Float32Array.from(out.vertProperties),
    indices: Uint32Array.from(out.triVerts),
  };
  for (const item of scratch) item.delete();
  return result;
}

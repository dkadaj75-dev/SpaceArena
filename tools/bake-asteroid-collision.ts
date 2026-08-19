/**
 * Bakes the six asteroid collision GLBs into the `collision` block of their
 * `content/asteroids/rock-*.json` configs.
 *
 *   npx tsx tools/bake-asteroid-collision.ts
 *
 * Idempotent: it rewrites only the `collision` key of an existing config, so
 * re-running after a mesh edit is the whole update procedure.
 *
 * ## Source meshes
 *
 * `tools/asteroid-collision/asteroid_<letter>_col.glb` — the 1250-triangle
 * decimations of the 5200-triangle visual rocks in `content/asteroids/`. They
 * live under `tools/` rather than `content/` because nothing at runtime fetches
 * them: the triangles ship inside the JSON. Keeping them in the tree is what
 * makes this bake reproducible.
 *
 * ## Coordinate space: ENGINE space, not glTF space
 *
 * A prop's collision block is glTF-verbatim because props load through
 * `AssetRegistry.ensureModel(..., { mergeParts: false })`, which bakes each part
 * relative to the loader's `__root__` and therefore reaches the scene unhanded.
 *
 * Asteroids take the MERGED path (`getAsteroidMaster` → `loadedModel` → default
 * `mergeParts: true`), which bakes the full world matrix — glTF `__root__`
 * included. That root carries Babylon's right-to-left-handed conversion: a 180°
 * Y rotation composed with a Z mirror, whose net effect on a vertex is
 *
 *     (x, y, z)  ->  (-x, y, z)
 *
 * So the rock a pilot SEES is the X-mirror of the rock in the file. Storing
 * glTF-verbatim positions would hand the sim the mirror image of the drawn
 * surface — invisible to any test that only queries the sim, and wrong in the
 * exact way (`d`'s bent neck on the other side) this whole change exists to fix.
 * The flip is applied here, once, offline.
 *
 * Mirroring reverses triangle orientation, so each triangle's winding is
 * reversed to restore the outward normals `TriangleBvh.sphereDeepestContact`
 * relies on to tell "outside the surface" from "inside the solid".
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { NodeIO, type Node, type Primitive, type TypedArray } from "@gltf-transform/core";
import { encodeFloat32Array, encodeUint32Array } from "@space-arena/shared/collision/base64";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SOURCE_DIR = path.join(ROOT, "tools", "asteroid-collision");
const CONFIG_DIR = path.join(ROOT, "content", "asteroids");
const LETTERS = ["a", "b", "c", "d", "e", "f"] as const;

interface Vec3 { x: number; y: number; z: number }
interface Baked {
  positions: Float32Array;
  indices: Uint32Array;
  bounds: { min: Vec3; max: Vec3 };
  maxRadius: number;
}

/**
 * World-transform every triangle of every mesh node, mirror it into engine
 * space, and weld bit-identical vertices.
 *
 * The weld is EXACT (a key over the three float32 values as stored), never a
 * tolerance merge: a tolerance weld can pull a vertex across a thin feature and
 * silently invert a triangle, and these meshes already share vertices at their
 * seams. It is here for size — 1250 triangles reference ~627 distinct vertices,
 * so welding turns 3750 stored positions into 627 and takes the encoded config
 * from ~60 kB to ~30 kB.
 */
function bakeNodes(nodes: readonly Node[]): Baked {
  const positions: number[] = [];
  const indices: number[] = [];
  const seen = new Map<string, number>();
  const min: Vec3 = { x: Infinity, y: Infinity, z: Infinity };
  const max: Vec3 = { x: -Infinity, y: -Infinity, z: -Infinity };
  // Round-trip through a one-element Float32Array so the weld key, the bounds
  // and the encoded payload all agree on the value: `bounds must contain
  // decoded collision positions` is checked against the DECODED f32s.
  const narrow = new Float32Array(1);
  const f32 = (value: number): number => {
    narrow[0] = value;
    return narrow[0]!;
  };

  for (const node of nodes) {
    const matrix = node.getWorldMatrix();
    for (const primitive of node.getMesh()!.listPrimitives()) {
      const triangles = primitiveTriangles(primitive);
      if (!triangles) continue;
      const { values, order } = triangles;
      // Reversed winding: the mirror below flips every triangle's orientation.
      for (let t = 0; t + 2 < order.length; t += 3) {
        for (const corner of [order[t]!, order[t + 2]!, order[t + 1]!]) {
          const o = corner * 3;
          const x = Number(values[o]), y = Number(values[o + 1]), z = Number(values[o + 2]);
          const wx = matrix[0]! * x + matrix[4]! * y + matrix[8]! * z + matrix[12]!;
          const wy = matrix[1]! * x + matrix[5]! * y + matrix[9]! * z + matrix[13]!;
          const wz = matrix[2]! * x + matrix[6]! * y + matrix[10]! * z + matrix[14]!;
          // glTF -> engine space. See the module comment.
          const ex = f32(-wx), ey = f32(wy), ez = f32(wz);
          const key = `${ex},${ey},${ez}`;
          let index = seen.get(key);
          if (index === undefined) {
            index = positions.length / 3;
            seen.set(key, index);
            positions.push(ex, ey, ez);
            min.x = Math.min(min.x, ex); min.y = Math.min(min.y, ey); min.z = Math.min(min.z, ez);
            max.x = Math.max(max.x, ex); max.y = Math.max(max.y, ey); max.z = Math.max(max.z, ez);
          }
          indices.push(index);
        }
      }
    }
  }

  let maxRadius = 0;
  for (let i = 0; i < positions.length; i += 3) {
    maxRadius = Math.max(maxRadius, Math.hypot(positions[i]!, positions[i + 1]!, positions[i + 2]!));
  }
  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    bounds: { min, max },
    maxRadius,
  };
}

function primitiveTriangles(primitive: Primitive): { values: TypedArray; order: number[] } | null {
  const accessor = primitive.getAttribute("POSITION");
  if (!accessor || primitive.getMode() !== 4) return null;
  const values = accessor.getArray();
  if (!values) return null;
  const indexArray = primitive.getIndices()?.getArray();
  const order = indexArray
    ? Array.from(indexArray, (value) => Number(value))
    : Array.from({ length: values.length / 3 }, (_, i) => i);
  return { values, order };
}

const io = new NodeIO();
let failed = false;

for (const letter of LETTERS) {
  const source = path.join(SOURCE_DIR, `asteroid_${letter}_col.glb`);
  const configPath = path.join(CONFIG_DIR, `rock-${letter}.json`);
  const document = await io.read(source);
  const nodes = document.getRoot().listNodes().filter((node) => node.getMesh());
  const baked = bakeNodes(nodes);
  const triangles = baked.indices.length / 3;

  // The rock is DRAWN at `instance scale = radius`, so a collider reaching past
  // 1.0 would collide wider than it looks. The broadphase sphere is derived from
  // this same measurement (`spawnAsteroid`) rather than assumed to be 1.0, so
  // the tolerance here only has to absorb the float32 round-trip on a mesh
  // authored at exactly 1.0 — it is not load-bearing for contact rejection.
  if (baked.maxRadius > 1.001) {
    console.error(`✖ asteroid_${letter}_col.glb: max radius ${baked.maxRadius.toFixed(6)} exceeds 1.0`);
    failed = true;
    continue;
  }
  if (triangles === 0) {
    console.error(`✖ asteroid_${letter}_col.glb: no triangle geometry`);
    failed = true;
    continue;
  }

  const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
  config.collision = {
    positions: encodeFloat32Array(baked.positions),
    indices: encodeUint32Array(baked.indices),
    bounds: baked.bounds,
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  console.log(
    `rock-${letter}  ${String(triangles).padStart(5)} tris  ${String(baked.positions.length / 3).padStart(5)} verts  ` +
    `maxR ${baked.maxRadius.toFixed(5)}  ${String(Math.round(JSON.stringify(config.collision).length / 1024)).padStart(3)} kB`,
  );
}

if (failed) process.exit(1);

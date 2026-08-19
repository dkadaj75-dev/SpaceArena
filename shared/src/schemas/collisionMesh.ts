import { z } from "zod";
import { decodeFloat32Array, decodeUint32Array } from "../collision/base64.js";

/**
 * A baked triangle mesh an offline tool produced from a GLB, carried inside the
 * config that owns it (see `client/src/editor/editorUploadModel.ts` for props
 * and `tools/bake-asteroid-collision.ts` for rocks).
 *
 * Shared by props and asteroids because both feed the same
 * {@link import("../collision/bvh.js").TriangleBvh}, and a second copy of the
 * decode-and-check rules would be a second place for them to drift.
 */

const requiredVec3 = z.object({ x: z.number(), y: z.number(), z: z.number() });

/** Ceiling on a single collision mesh, checked before anything is decoded. */
export const MAX_COLLISION_TRIANGLES = 150_000;
const AABB_EPSILON = 1e-4;

export const collisionMeshSchema = z.object({
  /** Vertex positions, f32 little-endian, base64. */
  positions: z.string().min(1),
  /** Triangle corners into `positions`, u32 little-endian, base64. */
  indices: z.string().min(1),
  /** Local-space AABB, so a broadphase can reject without decoding. */
  bounds: z.object({ min: requiredVec3, max: requiredVec3 }),
});

export type CollisionMeshConfig = z.infer<typeof collisionMeshSchema>;

/** The decoded byte count implied by a padded base64 string, without allocating it. */
function decodedByteLength(value: string): number | null {
  if (value.length === 0 || value.length % 4 !== 0) return null;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return value.length / 4 * 3 - padding;
}

/**
 * Decode a collision block and report every way it can be malformed, at
 * `basePath` inside the owning config.
 *
 * Runs inside the owner's `superRefine` rather than as a `.superRefine` on
 * {@link collisionMeshSchema} itself: a refined schema cannot be `.extend`ed or
 * composed as cleanly, and the owner needs to add its own rules (an asteroid's
 * unit-radius check) against the same decoded arrays.
 */
export function validateCollisionMesh(
  collision: CollisionMeshConfig,
  ctx: z.RefinementCtx,
  basePath: readonly (string | number)[] = ["collision"],
): { positions: Float32Array; indices: Uint32Array } | null {
  const at = (...rest: (string | number)[]): (string | number)[] => [...basePath, ...rest];

  // Three uint32 indices per triangle: reject before decoding/allocating.
  const indexBytes = decodedByteLength(collision.indices);
  if (indexBytes !== null && indexBytes / 12 > MAX_COLLISION_TRIANGLES) {
    ctx.addIssue({ code: "custom", path: at("indices"), message: `collision mesh must not exceed ${MAX_COLLISION_TRIANGLES} triangles` });
    return null;
  }
  let positions: Float32Array;
  let indices: Uint32Array;
  try {
    positions = decodeFloat32Array(collision.positions);
  } catch (error) {
    ctx.addIssue({ code: "custom", path: at("positions"), message: String(error) });
    return null;
  }
  try {
    indices = decodeUint32Array(collision.indices);
  } catch (error) {
    ctx.addIssue({ code: "custom", path: at("indices"), message: String(error) });
    return null;
  }
  if (positions.length % 3 !== 0) {
    ctx.addIssue({ code: "custom", path: at("positions"), message: "decoded positions length must be divisible by 3" });
  }
  if (indices.length % 3 !== 0) {
    ctx.addIssue({ code: "custom", path: at("indices"), message: "decoded indices length must be divisible by 3" });
  }
  if (indices.length / 3 > MAX_COLLISION_TRIANGLES) {
    ctx.addIssue({ code: "custom", path: at("indices"), message: `collision mesh must not exceed ${MAX_COLLISION_TRIANGLES} triangles` });
  }
  const vertexCount = positions.length / 3;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let finitePositions = positions.length % 3 === 0;
  for (let i = 0; finitePositions && i < positions.length; i += 3) {
    const x = positions[i]!, y = positions[i + 1]!, z = positions[i + 2]!;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      ctx.addIssue({ code: "custom", path: at("positions"), message: "decoded positions must be finite" });
      finitePositions = false;
      break;
    }
    minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z);
  }
  for (let i = 0; i < indices.length; i++) {
    if (indices[i]! >= vertexCount) {
      ctx.addIssue({ code: "custom", path: at("indices"), message: `index ${i} exceeds vertex count` });
      break;
    }
  }
  for (const axis of ["x", "y", "z"] as const) {
    if (collision.bounds.min[axis] > collision.bounds.max[axis]) {
      ctx.addIssue({ code: "custom", path: at("bounds", "min", axis), message: "bounds min must not exceed max" });
    }
  }
  if (finitePositions && (
    collision.bounds.min.x > minX + AABB_EPSILON || collision.bounds.min.y > minY + AABB_EPSILON || collision.bounds.min.z > minZ + AABB_EPSILON ||
    collision.bounds.max.x < maxX - AABB_EPSILON || collision.bounds.max.y < maxY - AABB_EPSILON || collision.bounds.max.z < maxZ - AABB_EPSILON
  )) {
    ctx.addIssue({ code: "custom", path: at("bounds"), message: "bounds must contain decoded collision positions" });
  }
  return finitePositions ? { positions, indices } : null;
}

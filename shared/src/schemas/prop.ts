import { z } from "zod";
import { decodeFloat32Array, decodeUint32Array } from "../collision/base64.js";
import { baseShape } from "./base.js";
import { renderRecipe } from "./common.js";

const requiredVec3 = z.object({ x: z.number(), y: z.number(), z: z.number() });
const MAX_COLLISION_TRIANGLES = 150_000;
const AABB_EPSILON = 1e-4;

/** The decoded byte count implied by a padded base64 string, without allocating it. */
function decodedByteLength(value: string): number | null {
  if (value.length === 0 || value.length % 4 !== 0) return null;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return value.length / 4 * 3 - padding;
}

export const propRenderRecipe = renderRecipe;

export const propSchema = z
  .object({
    ...baseShape("prop"),
    category: z.enum(["terrain", "structure", "rock", "decor"]),
    impactDamage: z.number().nonnegative().default(0),
    render: propRenderRecipe,
    collision: z.object({
      positions: z.string().min(1),
      indices: z.string().min(1),
      bounds: z.object({ min: requiredVec3, max: requiredVec3 }),
    }).optional(),
  })
  .superRefine((prop, ctx) => {
    const collision = prop.collision;
    if (!collision) return;
    // Three uint32 indices per triangle: reject before decoding/allocating.
    const indexBytes = decodedByteLength(collision.indices);
    if (indexBytes !== null && indexBytes / 12 > MAX_COLLISION_TRIANGLES) {
      ctx.addIssue({ code: "custom", path: ["collision", "indices"], message: "collision mesh must not exceed 150000 triangles" });
      return;
    }
    let positions: Float32Array;
    let indices: Uint32Array;
    try {
      positions = decodeFloat32Array(collision.positions);
    } catch (error) {
      ctx.addIssue({ code: "custom", path: ["collision", "positions"], message: String(error) });
      return;
    }
    try {
      indices = decodeUint32Array(collision.indices);
    } catch (error) {
      ctx.addIssue({ code: "custom", path: ["collision", "indices"], message: String(error) });
      return;
    }
    if (positions.length % 3 !== 0) {
      ctx.addIssue({ code: "custom", path: ["collision", "positions"], message: "decoded positions length must be divisible by 3" });
    }
    if (indices.length % 3 !== 0) {
      ctx.addIssue({ code: "custom", path: ["collision", "indices"], message: "decoded indices length must be divisible by 3" });
    }
    if (indices.length / 3 > MAX_COLLISION_TRIANGLES) {
      ctx.addIssue({ code: "custom", path: ["collision", "indices"], message: "collision mesh must not exceed 150000 triangles" });
    }
    const vertexCount = positions.length / 3;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let finitePositions = positions.length % 3 === 0;
    for (let i = 0; finitePositions && i < positions.length; i += 3) {
      const x = positions[i]!, y = positions[i + 1]!, z = positions[i + 2]!;
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        ctx.addIssue({ code: "custom", path: ["collision", "positions"], message: "decoded positions must be finite" });
        finitePositions = false;
        break;
      }
      minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z);
    }
    for (let i = 0; i < indices.length; i++) {
      if (indices[i]! >= vertexCount) {
        ctx.addIssue({ code: "custom", path: ["collision", "indices"], message: `index ${i} exceeds vertex count` });
        break;
      }
    }
    for (const axis of ["x", "y", "z"] as const) {
      if (collision.bounds.min[axis] > collision.bounds.max[axis]) {
        ctx.addIssue({ code: "custom", path: ["collision", "bounds", "min", axis], message: "bounds min must not exceed max" });
      }
    }
    if (finitePositions && (
      collision.bounds.min.x > minX + AABB_EPSILON || collision.bounds.min.y > minY + AABB_EPSILON || collision.bounds.min.z > minZ + AABB_EPSILON ||
      collision.bounds.max.x < maxX - AABB_EPSILON || collision.bounds.max.y < maxY - AABB_EPSILON || collision.bounds.max.z < maxZ - AABB_EPSILON
    )) {
      ctx.addIssue({ code: "custom", path: ["collision", "bounds"], message: "bounds must contain decoded collision positions" });
    }
  });

export type PropConfig = z.infer<typeof propSchema>;

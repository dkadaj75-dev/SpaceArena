import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { NodeIO, type Node, type Primitive, type TypedArray } from "@gltf-transform/core";
// Deep subpath import, NOT the @space-arena/shared barrel: vite.config.ts loads
// this module in plain Node, where the externalized barrel would hit `.js`
// specifiers against `.ts` sources. base64.ts has no relative imports, so the
// subpath survives Node's type stripping, and tsc resolves it via the package
// exports map without a rootDir violation.
import { encodeFloat32Array, encodeUint32Array } from "@space-arena/shared/collision/base64";

export const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;
export const MAX_COLLISION_TRIANGLES = 150_000;

export interface UploadModelResult {
  status: number;
  body: Record<string, unknown>;
}

/** Validate, persist and bake a dev-editor prop GLB. Exported for direct Node tests. */
export async function uploadEditorModel(contentDir: string, requestedPath: string, bytes: Uint8Array): Promise<UploadModelResult> {
  const match = /^props\/([a-z0-9]+(?:-[a-z0-9]+)*)\.glb$/.exec(requestedPath);
  if (!match) return fail(400, "path must be props/<kebab-name>.glb");
  if (bytes.byteLength > MAX_UPLOAD_BYTES) return fail(413, "model exceeds the 32 MB upload limit");

  const absolute = path.resolve(contentDir, requestedPath);
  const propsDir = path.resolve(contentDir, "props");
  if (path.dirname(absolute) !== propsDir) return fail(400, "model path escapes content/props");

  let document;
  try {
    document = await new NodeIO().readBinary(bytes);
  } catch (error) {
    return fail(400, `invalid GLB: ${error instanceof Error ? error.message : String(error)}`);
  }

  const nodes = document.getRoot().listNodes().filter((node) => node.getMesh());
  const collisionNodes = nodes.filter((node) => /(^|_)COL_/i.test(node.getMesh()!.getName()));
  const sourceNodes = collisionNodes.length ? collisionNodes : nodes;
  const baked = bakeNodes(sourceNodes);
  const name = match[1]!;
  const draft = {
    id: `prop.${name}`,
    type: "prop" as const,
    name: titleCase(name),
    category: "structure" as const,
    impactDamage: 0,
    render: { recipe: "model.static", model: requestedPath, modelScale: 1 },
  };

  // Keep the upload so the editor can accept the explicit decor fallback.
  await mkdir(propsDir, { recursive: true });
  await writeFile(absolute, bytes);
  if (!baked.positions.length || !baked.indices.length) {
    return { status: 422, body: { ok: false, reason: "model has no triangle geometry", draft: { ...draft, category: "decor" } } };
  }
  if (!collisionNodes.length && baked.indices.length / 3 > MAX_COLLISION_TRIANGLES) {
    return {
      status: 422,
      body: {
        ok: false,
        reason: `visual geometry has ${baked.indices.length / 3} triangles; collision limit is ${MAX_COLLISION_TRIANGLES}`,
        draft: { ...draft, category: "decor" },
      },
    };
  }
  return {
    status: 200,
    body: {
      ok: true,
      draft: {
        ...draft,
        collision: {
          positions: encodeFloat32Array(baked.positions),
          indices: encodeUint32Array(baked.indices),
          bounds: baked.bounds,
        },
      },
      collisionSource: collisionNodes.length ? "COL" : "visual",
      triangleCount: baked.indices.length / 3,
    },
  };
}

function bakeNodes(nodes: readonly Node[]): {
  positions: Float32Array;
  indices: Uint32Array;
  bounds: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } };
} {
  const positions: number[] = [];
  const indices: number[] = [];
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const node of nodes) {
    const matrix = node.getWorldMatrix();
    for (const primitive of node.getMesh()!.listPrimitives()) appendPrimitive(primitive, matrix, positions, indices, min, max);
  }
  if (!positions.length) {
    Object.assign(min, { x: 0, y: 0, z: 0 });
    Object.assign(max, { x: 0, y: 0, z: 0 });
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices), bounds: { min, max } };
}

function appendPrimitive(
  primitive: Primitive,
  matrix: readonly number[],
  outPositions: number[],
  outIndices: number[],
  min: { x: number; y: number; z: number },
  max: { x: number; y: number; z: number },
): void {
  const accessor = primitive.getAttribute("POSITION");
  if (!accessor || primitive.getMode() !== 4) return;
  const values = accessor.getArray() as TypedArray | null;
  if (!values) return;
  const base = outPositions.length / 3;
  for (let i = 0; i + 2 < values.length; i += 3) {
    const x = Number(values[i]), y = Number(values[i + 1]), z = Number(values[i + 2]);
    const tx = matrix[0]! * x + matrix[4]! * y + matrix[8]! * z + matrix[12]!;
    const ty = matrix[1]! * x + matrix[5]! * y + matrix[9]! * z + matrix[13]!;
    const tz = matrix[2]! * x + matrix[6]! * y + matrix[10]! * z + matrix[14]!;
    outPositions.push(tx, ty, tz);
    min.x = Math.min(min.x, tx); min.y = Math.min(min.y, ty); min.z = Math.min(min.z, tz);
    max.x = Math.max(max.x, tx); max.y = Math.max(max.y, ty); max.z = Math.max(max.z, tz);
  }
  const indexArray = primitive.getIndices()?.getArray();
  if (indexArray) for (const index of indexArray) outIndices.push(base + Number(index));
  else for (let i = 0; i < values.length / 3; i++) outIndices.push(base + i);
}

function titleCase(name: string): string {
  return name.split("-").map((part) => part[0]!.toUpperCase() + part.slice(1)).join(" ");
}

function fail(status: number, reason: string): UploadModelResult {
  return { status, body: { ok: false, reason } };
}

/** Minimal GLB writer over @gltf-transform/core. Render-only meshes, no textures. */
import { Document, NodeIO } from "@gltf-transform/core";
import type { Surface } from "./mesh.js";

export interface MaterialSpec {
  readonly name: string;
  readonly metallic: number;
  readonly roughness: number;
  readonly baseColor: readonly [number, number, number, number];
  readonly emissive?: readonly [number, number, number];
}

export interface Part {
  readonly surface: Surface;
  readonly material: MaterialSpec;
}

export const RIFT_ROCK: MaterialSpec = {
  name: "RIFT_ROCK",
  metallic: 0,
  roughness: 0.96,
  baseColor: [1, 1, 1, 1],
};

const io = new NodeIO();

/** One mesh, one node, one scene; every part becomes a primitive of that mesh. */
export async function encodeGlb(meshName: string, parts: readonly Part[]): Promise<Uint8Array> {
  const doc = new Document();
  doc.getRoot().getAsset().generator = "space-arena/generate-lunar-rift";
  const buffer = doc.createBuffer();
  const mesh = doc.createMesh(meshName);
  const materials = new Map<string, ReturnType<Document["createMaterial"]>>();
  for (const part of parts) {
    const spec = part.material;
    let material = materials.get(spec.name);
    if (!material) {
      material = doc
        .createMaterial(spec.name)
        .setMetallicFactor(spec.metallic)
        .setRoughnessFactor(spec.roughness)
        .setBaseColorFactor([spec.baseColor[0], spec.baseColor[1], spec.baseColor[2], spec.baseColor[3]]);
      if (spec.emissive) material.setEmissiveFactor([spec.emissive[0], spec.emissive[1], spec.emissive[2]]);
      materials.set(spec.name, material);
    }
    const prim = doc
      .createPrimitive()
      .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setArray(part.surface.positions).setBuffer(buffer))
      .setAttribute("NORMAL", doc.createAccessor().setType("VEC3").setArray(part.surface.normals).setBuffer(buffer))
      .setAttribute("COLOR_0", doc.createAccessor().setType("VEC3").setArray(part.surface.colors).setBuffer(buffer))
      .setIndices(doc.createAccessor().setType("SCALAR").setArray(part.surface.indices).setBuffer(buffer))
      .setMaterial(material);
    mesh.addPrimitive(prim);
  }
  doc.createScene(meshName).addChild(doc.createNode(meshName).setMesh(mesh));
  return io.writeBinary(doc);
}

export function triangleCount(parts: readonly Part[]): number {
  return parts.reduce((sum, part) => sum + part.surface.indices.length / 3, 0);
}

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Document, NodeIO } from "@gltf-transform/core";
import { describe, expect, it } from "vitest";
import { decodeFloat32Array, decodeUint32Array } from "@space-arena/shared";
import { uploadEditorModel } from "./editor/editorUploadModel.js";

async function glb(name: string, triangleCount = 1): Promise<Uint8Array> {
  const doc = new Document(); const buffer = doc.createBuffer();
  const positions = new Float32Array(triangleCount * 9); const indices = new Uint32Array(triangleCount * 3);
  for (let triangle = 0; triangle < triangleCount; triangle++) {
    const vertex = triangle * 3; const offset = triangle * 9;
    positions.set([0, 0, triangle, 1, 0, triangle, 0, 1, triangle], offset);
    indices.set([vertex, vertex + 1, vertex + 2], vertex);
  }
  const primitive = doc.createPrimitive().setAttribute("POSITION", doc.createAccessor().setType("VEC3").setArray(positions).setBuffer(buffer)).setIndices(doc.createAccessor().setType("SCALAR").setArray(indices).setBuffer(buffer));
  const mesh = doc.createMesh(name).addPrimitive(primitive); doc.createScene().addChild(doc.createNode().setMesh(mesh));
  return new NodeIO().writeBinary(doc);
}

describe("editor GLB upload", () => {
  it("bakes COL_ geometry and persists the GLB", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "arena-upload-")); const bytes = await glb("wall_COL_mesh");
    const result = await uploadEditorModel(dir, "props/test-wall.glb", bytes);
    expect(result.status).toBe(200); expect(result.body.collisionSource).toBe("COL");
    const draft = result.body.draft as { collision: { positions: string; indices: string } };
    expect(decodeFloat32Array(draft.collision.positions)).toHaveLength(9);
    expect(decodeUint32Array(draft.collision.indices)).toEqual(new Uint32Array([0, 1, 2]));
    expect(await readFile(path.join(dir, "props/test-wall.glb"))).toHaveLength(bytes.length);
  });

  it("uses small visual geometry when COL_ is absent", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "arena-upload-"));
    const result = await uploadEditorModel(dir, "props/small-rock.glb", await glb("visual", 2));
    expect(result.status).toBe(200); expect(result.body.collisionSource).toBe("visual"); expect(result.body.triangleCount).toBe(2);
  });

  it("returns a decor draft for visual geometry above the collision limit", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "arena-upload-"));
    const result = await uploadEditorModel(dir, "props/huge-rock.glb", await glb("visual", 150_001));
    expect(result.status).toBe(422); expect(result.body.reason).toContain("150001"); expect((result.body.draft as { category: string }).category).toBe("decor");
  });

  it("rejects traversal and malformed paths", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "arena-upload-"));
    expect((await uploadEditorModel(dir, "props/../escape.glb", new Uint8Array())).status).toBe(400);
    expect((await uploadEditorModel(dir, "props/Bad Name.glb", new Uint8Array())).status).toBe(400);
  });
});

/** Render two low-angle seam diagnostics directly from the shipped terrain GLBs. */
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { NodeIO } from "@gltf-transform/core";
import { renderView, type PreviewMesh, type View } from "./lunar-rift/preview.js";

const propsDir = path.resolve(process.argv[2] ?? "content/props");
const outDir = path.resolve(process.argv[3] ?? "/tmp/lunar-rift-seams");
const arena = JSON.parse(readFileSync("content/arenas/lunar-rift.json", "utf8")) as {
  propPlacements: { propId: string; position: { x: number; y?: number; z: number } }[];
};
const placements = new Map(arena.propPlacements.map((placement) => [placement.propId, placement.position]));
const io = new NodeIO();
const meshes: PreviewMesh[] = [];

for (let index = 0; index < 16; index++) {
  const document = await io.read(path.join(propsDir, `lunar-rift-chunk-${index}.glb`));
  const placement = placements.get(`prop.lunar-rift-chunk-${index}`);
  if (!placement) throw new Error(`missing placement for chunk ${index}`);
  for (const primitive of document.getRoot().listMeshes().flatMap((mesh) => mesh.listPrimitives())) {
    const position = primitive.getAttribute("POSITION");
    const normal = primitive.getAttribute("NORMAL");
    const color = primitive.getAttribute("COLOR_0");
    const indices = primitive.getIndices();
    if (!position || !normal || !color || !indices) throw new Error(`incomplete chunk ${index}`);
    const colorArray = color.getArray();
    const divisor = colorArray instanceof Uint16Array ? 65535 : colorArray instanceof Uint8Array ? 255 : 1;
    const colors = new Float32Array(color.getCount() * 3);
    for (let vertex = 0; vertex < color.getCount(); vertex++) {
      for (let channel = 0; channel < 3; channel++) {
        colors[vertex * 3 + channel] = colorArray[vertex * color.getElementSize() + channel]! / divisor;
      }
    }
    meshes.push({
      positions: Float32Array.from(position.getArray()),
      normals: Float32Array.from(normal.getArray() ?? [], (value: number) => value / (normal.getArray() instanceof Int16Array ? 32767 : 1)),
      colors,
      indices: Uint32Array.from(indices.getArray()),
      offset: [placement.x, placement.y ?? 0, placement.z],
    });
  }
}

const views: View[] = [
  { name: "central-low", eye: [0, 2, -92], target: [0, -8, 60], fov: 68 },
  { name: "cross-border-low", eye: [-92, 2, 0], target: [60, -8, 0], fov: 68 },
];
mkdirSync(outDir, { recursive: true });
for (const view of views) renderView(meshes, view, path.join(outDir, `after-${view.name}.png`), 1200, 700);

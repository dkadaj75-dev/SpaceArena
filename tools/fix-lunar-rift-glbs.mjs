// Deterministic post-pass for the shipped Lunar Rift terrain and boulders.
// Replaces (rather than transforms) UVs/material state, so rerunning is safe.
// Run: node tools/fix-lunar-rift-glbs.mjs [--props-dir path] [--arena path]
/* global Buffer, process, console */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  if (!process.argv[index + 1]) throw new Error(`${name} requires a path`);
  return process.argv[index + 1];
};
const props = path.resolve(process.cwd(), arg("--props-dir", "content/props"));
const arenaPath = path.resolve(process.cwd(), arg("--arena", "content/arenas/lunar-rift.json"));
const arena = JSON.parse(readFileSync(arenaPath, "utf8"));
const offsets = new Map(
  arena.propPlacements
    .filter((p) => /^prop\.lunar-rift-chunk-\d+$/.test(p.propId))
    .map((p) => [p.propId.replace("prop.lunar-rift-chunk-", ""), p.position]),
);
const COMPONENTS = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const SIZES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const ELEMENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const align4 = (n) => (n + 3) & ~3;

function parseGlb(bytes) {
  const jsonLength = bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString("utf8"));
  const binAt = 20 + jsonLength;
  const binLength = bytes.readUInt32LE(binAt);
  return { json, bin: Buffer.from(bytes.subarray(binAt + 8, binAt + 8 + binLength)) };
}

function writeGlb(json, bin) {
  let jsonBytes = Buffer.from(JSON.stringify(json));
  jsonBytes = Buffer.concat([jsonBytes, Buffer.alloc(align4(jsonBytes.length) - jsonBytes.length, 0x20)]);
  bin = Buffer.concat([bin, Buffer.alloc(align4(bin.length) - bin.length)]);
  json.buffers[0].byteLength = bin.length;
  // byteLength changed after JSON serialization only in buffers; keep it stable by serializing once more.
  jsonBytes = Buffer.from(JSON.stringify(json));
  jsonBytes = Buffer.concat([jsonBytes, Buffer.alloc(align4(jsonBytes.length) - jsonBytes.length, 0x20)]);
  const out = Buffer.alloc(12 + 8 + jsonBytes.length + 8 + bin.length);
  out.writeUInt32LE(0x46546c67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(jsonBytes.length, 12); out.writeUInt32LE(0x4e4f534a, 16); jsonBytes.copy(out, 20);
  const at = 20 + jsonBytes.length;
  out.writeUInt32LE(bin.length, at); out.writeUInt32LE(0x004e4942, at + 4); bin.copy(out, at + 8);
  return out;
}

function readAccessor(json, bin, index) {
  const accessor = json.accessors[index];
  const view = json.bufferViews[accessor.bufferView];
  const Ctor = COMPONENTS[accessor.componentType];
  const elements = ELEMENTS[accessor.type];
  if (!Ctor || !elements) throw new Error(`unsupported accessor ${index}`);
  const offset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const componentSize = SIZES[accessor.componentType];
  const stride = view.byteStride ?? componentSize * elements;
  const array = new Ctor(accessor.count * elements);
  const data = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const read = (at) => accessor.componentType === 5120 ? data.getInt8(at)
    : accessor.componentType === 5121 ? data.getUint8(at)
      : accessor.componentType === 5122 ? data.getInt16(at, true)
        : accessor.componentType === 5123 ? data.getUint16(at, true)
          : accessor.componentType === 5125 ? data.getUint32(at, true) : data.getFloat32(at, true);
  const write = (element, component, value) => {
    const at = offset + element * stride + component * componentSize;
    if (accessor.componentType === 5120) data.setInt8(at, value);
    else if (accessor.componentType === 5121) data.setUint8(at, value);
    else if (accessor.componentType === 5122) data.setInt16(at, value, true);
    else if (accessor.componentType === 5123) data.setUint16(at, value, true);
    else if (accessor.componentType === 5125) data.setUint32(at, value, true);
    else data.setFloat32(at, value, true);
    array[element * elements + component] = value;
  };
  for (let i = 0; i < accessor.count; i++) for (let c = 0; c < elements; c++) array[i * elements + c] = read(offset + i * stride + c * componentSize);
  return { accessor, array, elements, write };
}

function appendUvs(json, bin, values) {
  const pad = align4(bin.length) - bin.length;
  const bytes = Buffer.from(values.buffer, values.byteOffset, values.byteLength);
  const offset = bin.length + pad;
  bin = Buffer.concat([bin, Buffer.alloc(pad), bytes]);
  json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target: 34962 });
  json.accessors.push({ bufferView: json.bufferViews.length - 1, componentType: 5126, count: values.length / 2, type: "VEC2", min: [Math.min(...values.filter((_, i) => i % 2 === 0)), Math.min(...values.filter((_, i) => i % 2 === 1))], max: [Math.max(...values.filter((_, i) => i % 2 === 0)), Math.max(...values.filter((_, i) => i % 2 === 1))] });
  return { bin, accessor: json.accessors.length - 1 };
}

function replaceUvs(json, bin, primitive, values) {
  const current = primitive.attributes.TEXCOORD_0;
  if (current !== undefined) {
    const uv = readAccessor(json, bin, current);
    if (uv.accessor.componentType === 5126 && uv.elements === 2 && uv.accessor.count * 2 === values.length) {
      for (let i = 0; i < uv.accessor.count; i++) {
        uv.write(i, 0, values[i * 2]);
        uv.write(i, 1, values[i * 2 + 1]);
      }
      return bin;
    }
  }
  const added = appendUvs(json, bin, values);
  primitive.attributes.TEXCOORD_0 = added.accessor;
  return added.bin;
}

function normalized(value, accessor) {
  if (!accessor.normalized || accessor.componentType === 5126) return value;
  const max = accessor.componentType === 5121 ? 255 : accessor.componentType === 5123 ? 65535 : 1;
  return value / max;
}

function setNormalized(data, element, component, value) {
  const accessor = data.accessor;
  const encoded = !accessor.normalized || accessor.componentType === 5126
    ? value
    : Math.round(Math.min(1, value) * (accessor.componentType === 5121 ? 255 : 65535));
  data.write(element, component, encoded);
}

function prepareTerrain(file, offset, index, lod) {
  const { json, bin: initialBin } = parseGlb(readFileSync(file));
  let bin = initialBin;
  const vertices = [];
  let removedSkirtTriangles = 0;
  const fixVersion = json.asset.extras?.lunarRiftSeamFix ?? 0;
  const needsSkirtColorFix = fixVersion < 1;
  for (const mesh of json.meshes) for (const primitive of mesh.primitives) {
    const pos = readAccessor(json, bin, primitive.attributes.POSITION);
    const normal = readAccessor(json, bin, primitive.attributes.NORMAL);
    const indices = readAccessor(json, bin, primitive.indices);
    for (let t = 0; t < indices.accessor.count; t += 3) {
      const ids = [indices.array[t], indices.array[t + 1], indices.array[t + 2]];
      const xs = ids.map((id) => pos.array[id * 3]);
      const zs = ids.map((id) => pos.array[id * 3 + 2]);
      const onXBorder = xs.every((x) => Math.abs(Math.abs(x) - 96) <= 0.03);
      const onZBorder = zs.every((z) => Math.abs(Math.abs(z) - 96) <= 0.03);
      if (!onXBorder && !onZBorder) continue;
      if (ids[0] === ids[1] && ids[0] === ids[2]) continue;
      // Surface triangles have an interior vertex. A triangle wholly in one
      // chunk-edge plane is one of the generated vertical skirt quads. Make it
      // degenerate in place so the rewrite is deterministic and idempotent.
      indices.write(t + 1, 0, ids[0]);
      indices.write(t + 2, 0, ids[0]);
      removedSkirtTriangles++;
    }
    const uv = new Float32Array(pos.accessor.count * 2);
    for (let i = 0; i < pos.accessor.count; i++) {
      const x = pos.array[i * 3], y = pos.array[i * 3 + 1], z = pos.array[i * 3 + 2];
      const nx = Math.abs(normalized(normal.array[i * 3], normal.accessor));
      const ny = Math.abs(normalized(normal.array[i * 3 + 1], normal.accessor));
      const nz = Math.abs(normalized(normal.array[i * 3 + 2], normal.accessor));
      if (ny >= nx && ny >= nz) { uv[i * 2] = (x + offset.x) / 90; uv[i * 2 + 1] = (z + offset.z) / 90; }
      else if (nx >= nz) { uv[i * 2] = (z + offset.z) / 24; uv[i * 2 + 1] = y / 24; }
      else { uv[i * 2] = (x + offset.x) / 24; uv[i * 2 + 1] = y / 24; }
    }
    if (fixVersion < 2) bin = replaceUvs(json, bin, primitive, uv);

    const colorIndex = primitive.attributes.COLOR_0;
    const color = colorIndex === undefined ? undefined : readAccessor(json, bin, colorIndex);
    if (color && needsSkirtColorFix) {
      for (let i = 0; i < pos.accessor.count; i++) {
        const x = Math.abs(pos.array[i * 3]), z = Math.abs(pos.array[i * 3 + 2]);
        const ny = Math.abs(normalized(normal.array[i * 3 + 1], normal.accessor));
        if (ny > 0.08 || (Math.abs(x - 96) > 0.03 && Math.abs(z - 96) > 0.03)) continue;
        for (let c = 0; c < Math.min(3, color.elements); c++) {
          setNormalized(color, i, c, normalized(color.array[i * color.elements + c], color.accessor) / 0.72);
        }
      }
    }
    for (let i = 0; i < pos.accessor.count; i++) {
      const x = pos.array[i * 3], z = pos.array[i * 3 + 2];
      if (Math.abs(Math.abs(x) - 96) > 0.03 && Math.abs(Math.abs(z) - 96) > 0.03) continue;
      vertices.push({ index, lod, pos, normal, color, i, x: x + offset.x, y: pos.array[i * 3 + 1] + offset.y, z: z + offset.z });
    }
  }
  return { file, json, bin, vertices, removedSkirtTriangles };
}

const distance = (a, b, count) => Math.hypot(...Array.from({ length: count }, (_, c) => a[c] - b[c]));
const values = (vertex, field, count) => {
  const data = vertex[field];
  if (!data) return undefined;
  return Array.from({ length: count }, (_, c) => normalized(data.array[vertex.i * data.elements + c], data.accessor));
};

function smoothBorders(assets) {
  const byXZ = new Map();
  for (const asset of assets) for (const vertex of asset.vertices) {
    const key = `${Math.round(vertex.x * 1000)},${Math.round(vertex.z * 1000)}`;
    if (!byXZ.has(key)) byXZ.set(key, []);
    byXZ.get(key).push(vertex);
  }
  const groups = [];
  for (const sameXZ of byXZ.values()) {
    sameXZ.sort((a, b) => a.y - b.y);
    for (const vertex of sameXZ) {
      let group = groups.find((candidate) => candidate.key === sameXZ && Math.abs(candidate.y - vertex.y) <= 0.05);
      if (!group) { group = { key: sameXZ, y: vertex.y, vertices: [] }; groups.push(group); }
      group.vertices.push(vertex);
    }
  }
  const adjacent = new Map();
  for (const group of groups) {
    const chunks = [...new Set(group.vertices.map((v) => v.index))];
    if (chunks.length < 2) continue;
    const averageY = group.vertices.reduce((sum, vertex) => sum + vertex.y, 0) / group.vertices.length;
    for (const vertex of group.vertices) {
      vertex.pos.write(vertex.i, 0, vertex.x - offsets.get(String(vertex.index)).x);
      vertex.pos.write(vertex.i, 1, averageY - offsets.get(String(vertex.index)).y);
      vertex.pos.write(vertex.i, 2, vertex.z - offsets.get(String(vertex.index)).z);
      vertex.y = averageY;
    }
    for (let a = 0; a < chunks.length; a++) for (let b = a + 1; b < chunks.length; b++) {
      const key = `${Math.min(chunks[a], chunks[b])}-${Math.max(chunks[a], chunks[b])}`;
      if (!adjacent.has(key)) adjacent.set(key, { beforeNormal: 0, beforeColor: 0, afterNormal: 0, afterColor: 0, pairs: 0 });
      const metric = adjacent.get(key);
      const left = group.vertices.filter((v) => v.index === chunks[a]);
      const right = group.vertices.filter((v) => v.index === chunks[b]);
      for (const va of left) for (const vb of right) {
        metric.beforeNormal = Math.max(metric.beforeNormal, distance(values(va, "normal", 3), values(vb, "normal", 3), 3));
        if (va.color && vb.color) metric.beforeColor = Math.max(metric.beforeColor, distance(values(va, "color", 3), values(vb, "color", 3), 3));
        metric.pairs++;
      }
    }
    // At an identical edge position the surface and vertical skirt have duplicate
    // vertices. Use only upward-facing surface normals for the target, then write
    // that result to every duplicate so the skirt top cannot render as a crease.
    const allNormals = group.vertices.map((v) => values(v, "normal", 3));
    const surfaceNormals = allNormals.filter((n) => n[1] > 0.25);
    const normals = surfaceNormals.length ? surfaceNormals : allNormals;
    const normalDelta = allNormals.reduce((max, n) => Math.max(max, distance(allNormals[0], n, 3)), 0);
    if (normalDelta > 1e-7) {
      const average = [0, 1, 2].map((c) => normals.reduce((sum, n) => sum + n[c], 0) / normals.length);
      const length = Math.hypot(...average) || 1;
      for (const vertex of group.vertices) for (let c = 0; c < 3; c++) setNormalized(vertex.normal, vertex.i, c, average[c] / length);
    }
    const colored = group.vertices.filter((v) => v.color);
    if (colored.length) {
      const colors = colored.map((v) => values(v, "color", 3));
      const colorDelta = colors.reduce((max, color) => Math.max(max, distance(colors[0], color, 3)), 0);
      if (colorDelta > 1e-7) {
        const averageColor = [0, 1, 2].map((c) => colors.reduce((sum, color) => sum + color[c], 0) / colors.length);
        for (const vertex of colored) for (let c = 0; c < 3; c++) setNormalized(vertex.color, vertex.i, c, averageColor[c]);
      }
    }
  }
  // Re-measure the exact groups that were modified, including LOD0-to-LOD1 pairs.
  for (const group of groups) {
    const chunks = [...new Set(group.vertices.map((v) => v.index))];
    for (let a = 0; a < chunks.length; a++) for (let b = a + 1; b < chunks.length; b++) {
      const metric = adjacent.get(`${Math.min(chunks[a], chunks[b])}-${Math.max(chunks[a], chunks[b])}`);
      if (!metric) continue;
      const left = group.vertices.filter((v) => v.index === chunks[a]);
      const right = group.vertices.filter((v) => v.index === chunks[b]);
      for (const va of left) for (const vb of right) {
        metric.afterNormal = Math.max(metric.afterNormal, distance(values(va, "normal", 3), values(vb, "normal", 3), 3));
        if (va.color && vb.color) metric.afterColor = Math.max(metric.afterColor, distance(values(va, "color", 3), values(vb, "color", 3), 3));
      }
    }
  }
  return adjacent;
}

function fixBoulder(file) {
  const { json, bin: initialBin } = parseGlb(readFileSync(file));
  let bin = initialBin;
  const image = json.images?.findIndex((item) => item.uri === "textures/game/gray_rocks_diff_1k.jpg") ?? -1;
  if (image < 0) (json.images ??= []).push({ uri: "textures/game/gray_rocks_diff_1k.jpg", name: "gray_rocks_diff" });
  const imageIndex = image < 0 ? json.images.length - 1 : image;
  let textureIndex = json.textures?.findIndex((item) => item.source === imageIndex) ?? -1;
  if (textureIndex < 0) { (json.textures ??= []).push({ source: imageIndex }); textureIndex = json.textures.length - 1; }
  for (const material of json.materials ?? []) {
    material.pbrMetallicRoughness ??= {};
    material.pbrMetallicRoughness.baseColorTexture = { index: textureIndex };
    material.pbrMetallicRoughness.baseColorFactor = [0.72, 0.74, 0.78, 1];
    material.pbrMetallicRoughness.metallicFactor = 0;
    material.pbrMetallicRoughness.roughnessFactor = 0.96;
  }
  for (const mesh of json.meshes) for (const primitive of mesh.primitives) {
    const pos = readAccessor(json, bin, primitive.attributes.POSITION);
    const normal = readAccessor(json, bin, primitive.attributes.NORMAL);
    const uv = new Float32Array(pos.accessor.count * 2);
    for (let i = 0; i < pos.accessor.count; i++) {
      const x = pos.array[i * 3], y = pos.array[i * 3 + 1], z = pos.array[i * 3 + 2];
      const nx = Math.abs(normalized(normal.array[i * 3], normal.accessor));
      const ny = Math.abs(normalized(normal.array[i * 3 + 1], normal.accessor));
      const nz = Math.abs(normalized(normal.array[i * 3 + 2], normal.accessor));
      if (ny >= nx && ny >= nz) { uv[i * 2] = x / 1.35; uv[i * 2 + 1] = z / 1.35; }
      else if (nx >= nz) { uv[i * 2] = z / 1.35; uv[i * 2 + 1] = y / 1.35; }
      else { uv[i * 2] = x / 1.35; uv[i * 2 + 1] = y / 1.35; }
    }
    bin = replaceUvs(json, bin, primitive, uv);
  }
  json.asset.extras = { ...(json.asset.extras ?? {}), lunarRiftRockTextureFix: 1 };
  writeFileSync(file, writeGlb(json, bin));
}

const terrain = readdirSync(props).filter((name) => /^lunar-rift-chunk-\d+(_lod1)?\.glb$/.test(name)).sort();
const terrainAssets = [];
for (const name of terrain) {
  const index = name.match(/^lunar-rift-chunk-(\d+)/)[1];
  const offset = offsets.get(index);
  if (!offset) throw new Error(`no placement found for chunk ${index}`);
  terrainAssets.push(prepareTerrain(path.join(props, name), offset, Number(index), name.includes("_lod1") ? 1 : 0));
}
const borderMetrics = smoothBorders(terrainAssets);
for (const asset of terrainAssets) {
  asset.json.asset.extras = { ...(asset.json.asset.extras ?? {}), lunarRiftSeamFix: 3 };
  writeFileSync(asset.file, writeGlb(asset.json, asset.bin));
}
console.log(`removed ${terrainAssets.reduce((sum, asset) => sum + asset.removedSkirtTriangles, 0)} skirt triangles`);
for (const [border, metric] of [...borderMetrics].sort()) console.log(
  `border ${border}: normal ${metric.beforeNormal.toExponential(3)} -> ${metric.afterNormal.toExponential(3)}, color ${metric.beforeColor.toExponential(3)} -> ${metric.afterColor.toExponential(3)} (${metric.pairs} pairs)`,
);
if ([...borderMetrics.values()].some((m) => m.afterNormal > 1e-5 || m.afterColor > 1 / 255 + 1e-6)) throw new Error("border smoothing verification failed");
const boulders = readdirSync(props).filter((name) => /^lunar-rift-boulder-[abc]\.glb$/.test(name)).sort();
for (const name of boulders) fixBoulder(path.join(props, name));
console.log(`fixed ${terrain.length} terrain GLBs and ${boulders.length} boulder GLBs`);

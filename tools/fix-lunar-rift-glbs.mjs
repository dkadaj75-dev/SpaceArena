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

function fixTerrain(file, offset) {
  const { json, bin: initialBin } = parseGlb(readFileSync(file));
  let bin = initialBin;
  for (const mesh of json.meshes) for (const primitive of mesh.primitives) {
    const pos = readAccessor(json, bin, primitive.attributes.POSITION);
    const normal = readAccessor(json, bin, primitive.attributes.NORMAL);
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
    bin = replaceUvs(json, bin, primitive, uv);

    const colorIndex = primitive.attributes.COLOR_0;
    if (colorIndex === undefined) continue;
    const color = readAccessor(json, bin, colorIndex);
    for (let i = 0; i < pos.accessor.count; i++) {
      const x = Math.abs(pos.array[i * 3]), z = Math.abs(pos.array[i * 3 + 2]);
      const ny = Math.abs(normalized(normal.array[i * 3 + 1], normal.accessor));
      if (ny > 0.08 || (Math.abs(x - 96) > 0.03 && Math.abs(z - 96) > 0.03)) continue;
      for (let c = 0; c < Math.min(3, color.elements); c++) {
        setNormalized(color, i, c, normalized(color.array[i * color.elements + c], color.accessor) / 0.72);
      }
    }
  }
  json.asset.extras = { ...(json.asset.extras ?? {}), lunarRiftSeamFix: 1 };
  writeFileSync(file, writeGlb(json, bin));
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
for (const name of terrain) {
  const index = name.match(/^lunar-rift-chunk-(\d+)/)[1];
  const offset = offsets.get(index);
  if (!offset) throw new Error(`no placement found for chunk ${index}`);
  fixTerrain(path.join(props, name), offset);
}
const boulders = readdirSync(props).filter((name) => /^lunar-rift-boulder-[abc]\.glb$/.test(name)).sort();
for (const name of boulders) fixBoulder(path.join(props, name));
console.log(`fixed ${terrain.length} terrain GLBs and ${boulders.length} boulder GLBs`);

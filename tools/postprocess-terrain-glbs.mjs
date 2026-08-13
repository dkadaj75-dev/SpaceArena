// Post-pass after tools/blender_terrain_pass.py:
//  1. COLOR_0 rescale (gltf-transform): raw vertex colors encode absolute albedo
//     (~0.31 mean, AO baked in). Against a real baseColorTexture they must be a
//     variation signal around 1.0 or the terrain double-darkens. x2.0, clamped.
//  2. Image extraction (direct GLB surgery): Blender embeds every map per chunk
//     (~19 MB duplicated). glTF 2.0 allows uri-referenced images inside .glb, but
//     gltf-transform's writer cannot emit that mix — so we rewrite the container
//     ourselves: extract each unique image once to content/props/textures/game/,
//     point json.images[].uri at it, drop the image bufferViews and repack the BIN
//     (remapping every accessor/bufferView index).
// Run: node tools/postprocess-terrain-glbs.mjs
/* global Buffer, process, console */
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readdirSync, writeFileSync, statSync, mkdirSync } from "node:fs";
import path from "node:path";
const req = createRequire(import.meta.url);
const { NodeIO } = req("@gltf-transform/core");

const PROPS = path.resolve(process.cwd(), "content/props");
const GAME_TEX = path.join(PROPS, "textures", "game");
mkdirSync(GAME_TEX, { recursive: true });
const io = new NodeIO();

const seen = new Map();
let totalBefore = 0;
let totalAfter = 0;

function align4(n) { return (n + 3) & ~3; }

function parseGlb(buf) {
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString("utf8"));
  const binHeader = 20 + jsonLen;
  let bin = Buffer.alloc(0);
  if (binHeader < buf.length) {
    const binLen = buf.readUInt32LE(binHeader);
    bin = buf.subarray(binHeader + 8, binHeader + 8 + binLen);
  }
  return { json, bin };
}

function writeGlb(json, bin) {
  let jsonBytes = Buffer.from(JSON.stringify(json), "utf8");
  const jsonPad = align4(jsonBytes.length) - jsonBytes.length;
  if (jsonPad) jsonBytes = Buffer.concat([jsonBytes, Buffer.alloc(jsonPad, 0x20)]);
  const binPad = align4(bin.length) - bin.length;
  const binPadded = binPad ? Buffer.concat([bin, Buffer.alloc(binPad)]) : bin;
  const total = 12 + 8 + jsonBytes.length + (binPadded.length ? 8 + binPadded.length : 0);
  const out = Buffer.alloc(total);
  out.writeUInt32LE(0x46546c67, 0); // glTF
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(total, 8);
  out.writeUInt32LE(jsonBytes.length, 12);
  out.writeUInt32LE(0x4e4f534a, 16); // JSON
  jsonBytes.copy(out, 20);
  if (binPadded.length) {
    const o = 20 + jsonBytes.length;
    out.writeUInt32LE(binPadded.length, o);
    out.writeUInt32LE(0x004e4942, o + 4); // BIN
    binPadded.copy(out, o + 8);
  }
  return out;
}

function extractImages(buf) {
  const { json, bin } = parseGlb(buf);
  if (!json.images?.length) return buf;
  const imageBvs = new Set();
  for (const img of json.images) {
    if (img.bufferView === undefined) continue;
    const bv = json.bufferViews[img.bufferView];
    const bytes = bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);
    const hash = createHash("sha1").update(bytes).digest("hex").slice(0, 12);
    let name = seen.get(hash);
    if (!name) {
      const ext = (img.mimeType ?? "image/jpeg").includes("png") ? "png" : "jpg";
      const base = (img.name || "tex").replace(/[^a-z0-9_-]/gi, "_").slice(0, 40) || "tex";
      name = `${base}_${hash}.${ext}`;
      writeFileSync(path.join(GAME_TEX, name), bytes);
      seen.set(hash, name);
    }
    imageBvs.add(img.bufferView);
    delete img.bufferView;
    img.uri = `textures/game/${name}`;
  }
  // repack BIN without the image bufferViews
  const keep = json.bufferViews.map((_, i) => !imageBvs.has(i));
  const remap = new Map();
  const parts = [];
  let offset = 0;
  const newBvs = [];
  json.bufferViews.forEach((bv, i) => {
    if (!keep[i]) return;
    remap.set(i, newBvs.length);
    const bytes = bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);
    const aligned = align4(offset);
    if (aligned !== offset) { parts.push(Buffer.alloc(aligned - offset)); offset = aligned; }
    const nv = { ...bv, byteOffset: offset };
    parts.push(bytes);
    offset += bv.byteLength;
    newBvs.push(nv);
  });
  json.bufferViews = newBvs;
  const remapRef = (obj, key) => {
    if (obj && obj[key] !== undefined) {
      const to = remap.get(obj[key]);
      if (to === undefined) throw new Error(`dangling bufferView ref ${obj[key]}`);
      obj[key] = to;
    }
  };
  for (const acc of json.accessors ?? []) {
    remapRef(acc, "bufferView");
    if (acc.sparse) { remapRef(acc.sparse.indices, "bufferView"); remapRef(acc.sparse.values, "bufferView"); }
  }
  const newBin = Buffer.concat(parts);
  json.buffers = [{ byteLength: newBin.length }];
  return writeGlb(json, newBin);
}

const files = readdirSync(PROPS).filter((f) => /^lunar-rift-chunk-\d+(_lod1)?\.glb$/.test(f)).sort();
for (const file of files) {
  const abs = path.join(PROPS, file);
  totalBefore += statSync(abs).size;

  // stage 1: COLOR_0 rescale via gltf-transform (valid embedded GLB in, embedded out).
  // Blender exports colors as NORMALIZED u8 VEC4 — multiply in the accessor's own
  // space and only the RGB channels (alpha stays), or a float-space multiply
  // silently saturates everything to white (been there).
  const doc = await io.read(abs);
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const col = prim.getAttribute("COLOR_0");
      if (!col) continue;
      const arr = col.getArray();
      const comps = col.getElementSize();
      // Blender 5.2 emits normalized Uint16 colors; older paths emit u8 or float32.
      // Multiply in the accessor's own value space or everything saturates.
      const cap = col.getNormalized()
        ? (arr instanceof Uint8Array ? 255 : arr instanceof Uint16Array ? 65535 : 1)
        : 1;
      const out = new arr.constructor(arr.length);
      for (let i = 0; i < arr.length; i++) {
        const channel = i % comps;
        out[i] = channel === 3 ? arr[i] : Math.min(cap, arr[i] * 2.0);
      }
      col.setArray(out);
    }
  }
  const embedded = Buffer.from(await io.writeBinary(doc));

  // stage 2: image extraction via container surgery
  const final = extractImages(embedded);
  writeFileSync(abs, final);
  totalAfter += final.length;
}

console.log(`processed ${files.length} GLBs: ${(totalBefore / 1e6).toFixed(1)} MB -> ${(totalAfter / 1e6).toFixed(1)} MB (+ ${seen.size} shared textures in textures/game/)`);

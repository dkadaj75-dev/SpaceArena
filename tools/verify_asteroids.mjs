/* global process, console, Buffer */
// Verification for the Space Arena asteroid GLBs.
//   node tools/verify_asteroids.mjs
import { NodeIO } from '@gltf-transform/core';
import fs from 'node:fs';
import path from 'node:path';

const VIS_DIR = path.resolve('content/asteroids');
// The collision sources live under tools/, not content/: nothing fetches them at
// runtime (their triangles ship inside the rock JSON, baked by
// tools/bake-asteroid-collision.ts), but keeping them in the tree is what makes
// that bake reproducible.
const COL_DIR = path.resolve('tools/asteroid-collision');
const LETTERS = ['a', 'b', 'c', 'd', 'e', 'f'];

const io = new NodeIO();

function pngJpgSize(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) {
    return [buf.readUInt32BE(16), buf.readUInt32BE(20), 'png'];
  }
  // JPEG: walk segments for SOFn
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5), 'jpg'];
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return [0, 0, '?'];
}

async function meshStats(file) {
  const doc = await io.read(file);
  const root = doc.getRoot();
  let tris = 0, maxR = 0, verts = 0;
  const ext = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      const idx = prim.getIndices();
      tris += idx ? idx.getCount() / 3 : pos.getCount() / 3;
      verts += pos.getCount();
      const a = [0, 0, 0];
      for (let i = 0; i < pos.getCount(); i++) {
        pos.getElement(i, a);
        const r = Math.hypot(a[0], a[1], a[2]);
        if (r > maxR) maxR = r;
        for (let k = 0; k < 3; k++) {
          if (a[k] < ext[k]) ext[k] = a[k];
          if (a[k] > ext[3 + k]) ext[3 + k] = a[k];
        }
      }
    }
  }
  const dims = [ext[3] - ext[0], ext[4] - ext[1], ext[5] - ext[2]];
  const aspect = Math.max(...dims) / Math.min(...dims);
  const mats = root.listMaterials();
  const texInfo = [];
  for (const t of root.listTextures()) {
    const img = t.getImage();
    const [w, h, kind] = pngJpgSize(Buffer.from(img));
    texInfo.push({ name: t.getName() || '(unnamed)', w, h, kind, kb: Math.round(img.byteLength / 1024) });
  }
  const m0 = mats[0];
  return {
    tris, verts, maxR, aspect, dims,
    matCount: mats.length,
    hasBaseColorTex: !!(m0 && m0.getBaseColorTexture()),
    hasNormalTex: !!(m0 && m0.getNormalTexture()),
    hasMRTex: !!(m0 && m0.getMetallicRoughnessTexture()),
    metallic: m0 ? m0.getMetallicFactor() : null,
    roughness: m0 ? m0.getRoughnessFactor() : null,
    texInfo,
    bytes: fs.statSync(file).size,
  };
}

const pad = (s, n) => String(s).padEnd(n);
const padl = (s, n) => String(s).padStart(n);

console.log('\n=== VISUAL MESHES  content/asteroids/*.glb ===');
console.log(pad('file', 16) + padl('tris', 6) + padl('verts', 7) + padl('maxR', 9) +
  padl('aspect', 8) + padl('mats', 5) + padl('BC', 4) + padl('N', 3) + padl('MR', 4) +
  padl('metal', 7) + padl('MB', 7) + '  textures');
let fail = 0;
const check = (ok, msg) => { if (!ok) { fail++; console.log('   !! ' + msg); } };

for (const L of LETTERS) {
  const f = path.join(VIS_DIR, `asteroid_${L}.glb`);
  if (!fs.existsSync(f)) { console.log(`asteroid_${L}.glb  MISSING`); fail++; continue; }
  const s = await meshStats(f);
  const tex = s.texInfo.map(t => `${t.w}x${t.h}${t.kind}/${t.kb}kB`).join(' ');
  console.log(pad(`asteroid_${L}.glb`, 16) + padl(s.tris, 6) + padl(s.verts, 7) +
    padl(s.maxR.toFixed(5), 9) + padl(s.aspect.toFixed(2), 8) + padl(s.matCount, 5) +
    padl(s.hasBaseColorTex ? 'y' : 'n', 4) + padl(s.hasNormalTex ? 'y' : 'n', 3) +
    padl(s.hasMRTex ? 'y' : 'n', 4) + padl(s.metallic.toFixed(2), 7) +
    padl((s.bytes / 1048576).toFixed(2), 7) + '  ' + tex);
  check(Math.abs(s.maxR - 1.0) <= 0.001, `${L}: maxR ${s.maxR} != 1.0 +-0.001`);
  check(s.tris >= 4000 && s.tris <= 6000, `${L}: tris ${s.tris} outside 4000-6000`);
  check(s.matCount === 1, `${L}: ${s.matCount} materials, expected 1`);
  check(s.hasBaseColorTex, `${L}: no baseColorTexture`);
  check(s.hasNormalTex, `${L}: no normalTexture`);
  check(s.metallic <= 0.25, `${L}: metallic ${s.metallic} > 0.25`);
  check(s.roughness >= 0.5 || s.hasMRTex, `${L}: roughnessFactor ${s.roughness} < 0.5 and no MR texture`);
}

console.log('\n=== COLLISION MESHES  tools/asteroid-collision/*_col.glb ===');
console.log(pad('file', 22) + padl('tris', 6) + padl('verts', 7) + padl('maxR', 9) +
  padl('mats', 6) + padl('kB', 7));
for (const L of LETTERS) {
  const f = path.join(COL_DIR, `asteroid_${L}_col.glb`);
  if (!fs.existsSync(f)) { console.log(`asteroid_${L}_col.glb  MISSING`); fail++; continue; }
  const s = await meshStats(f);
  console.log(pad(`asteroid_${L}_col.glb`, 22) + padl(s.tris, 6) + padl(s.verts, 7) +
    padl(s.maxR.toFixed(5), 9) + padl(s.matCount, 6) + padl(Math.round(s.bytes / 1024), 7));
  check(s.maxR <= 1.002, `${L} col: maxR ${s.maxR} > 1.002`);
  check(s.tris >= 1000 && s.tris <= 1500, `${L} col: tris ${s.tris} outside 1000-1500`);
}

console.log(fail === 0 ? '\nALL CHECKS PASSED\n' : `\n${fail} CHECK(S) FAILED\n`);
process.exit(fail === 0 ? 0 : 1);

/**
 * Lunar Rift generator (MAP-OVERHAUL.md §7 / §7.1).
 *
 *   npx tsx tools/generate-lunar-rift.ts [--preview] [--out content] [--quick]
 *
 * Deterministic end to end: seeded murmur noise only, no Math.random, no
 * Date.now in any value that reaches a file. Running it twice produces
 * byte-identical output, which the self-check proves by regenerating everything
 * into a temp directory and comparing.
 *
 * Pipeline: heightfield (the visually-approved `rift-lib` core, ported in
 * `lunar-rift/riftLib.ts`) -> per-chunk adaptive grid -> watertight solid ->
 * manifold-3d bore subtraction -> displaced, vertex-coloured surface + a coarser
 * collision surface from the same functions -> GLB + prop JSON + arena JSON.
 *
 * Deviations from the brief, with reasons:
 *  - Chunk grid pitch is tiered 1.6 / 2.0 / 4.0u instead of 1.6 / 4.0u. Only the
 *    four corner chunks are pure highland. The four core chunks (the ones
 *    that are mostly playable) keep 1.6u; the flank chunks take 2.0u.
 *  - Collision pitch remains 2.5u (the established collision fidelity).
 *    exactly, so collision verts land on chunk borders without a ragged seam.
 *  - Tunnel endpoints come from the approved `rift-lib` TUNNELS (Ø15, bore
 *    centre y 12) rather than the older coordinates written into §7.1 prose.
 *  - Nav nodes carry the y of the HIGHER of the two twin grounds, because exact
 *    180° symmetry and positional terrain noise cannot both be honoured; see
 *    NAV_MAX_CLEARANCE.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ManifoldToplevel } from "manifold-3d";

import { CollisionWorld, type PlacedMesh } from "./lunar-rift/collisionWorld.js";
import { loadCsg } from "./lunar-rift/csg.js";
import { RiftField, WORLD_EXT, type Bore } from "./lunar-rift/field.js";
import { RIFT_ROCK, encodeGlb, type Part } from "./lunar-rift/glb.js";
import {
  buildNavGraph,
  beaconsSouth,
  chunkPlacements,
  flagPadSouth,
  guideLightsSouth,
  scatterBouldersSouth,
  twinPlacement,
  wrapAngle,
  type NavGraph,
  type PropPlacement,
} from "./lunar-rift/layout.js";
import {
  buildChunkCollision,
  buildChunkSurface,
  boundsOf,
  planChunks,
  type ChunkSpec,
  type CollisionMesh,
  type Surface,
} from "./lunar-rift/mesh.js";
import { renderView, type PreviewMesh, type View } from "./lunar-rift/preview.js";
import {
  BOULDER_SHAPES,
  buildBeacon,
  buildBoulder,
  buildBoulderCollision,
  buildFlagPad,
  buildGuideLight,
} from "./lunar-rift/props.js";
import { CEILING, CRATERS, FLAGS, KILL_FLOOR, LANES, MOUTHS, SPAWNS, TUNNELS, TUNNELS_SOUTH } from "./lunar-rift/riftLib.js";

// ---------- budgets ----------
/**
 * Budget for the RAW surface this tool emits. The shipped LOD0/LOD1 budgets are
 * enforced by tools/bake-lunar-rift-terrain.mjs, which simplifies these meshes
 * down to what actually ships.
 */
const SOURCE_TRI_BUDGET = 340_000;
const COLLISION_TRI_BUDGET = 80_000;
const CHUNK_GLB_BYTES = 1_600_000;
/**
 * Chunk centres are 192u apart and Babylon measures LOD distance to a mesh's
 * bounding-sphere CENTRE, so the old 190 put every orthogonal neighbour on LOD1
 * the moment you stood on your own chunk — a cross-LOD border everywhere, all
 * the time. 300 clears the 192u orthogonal and 271.5u diagonal neighbours, so a
 * chunk only drops to LOD1 once it is genuinely in the distance.
 */
const LOD_DISTANCE = 300;
const COORD_LIMIT = 404;
const GROUND_DROP_LIMIT = 6;
const TUNNEL_CLEARANCE = 6.2;
/**
 * Nav nodes must be twinned exactly, so a node's y is the higher of the two twin
 * grounds plus 1.2u. Over positionally-noisy floors that pushes the clearance on
 * the lower side above the 4u the brief asks for; 6u is the honest bound.
 */
const NAV_MAX_CLEARANCE = 6;

interface EmittedFile {
  /** Relative to the output root. */
  path: string;
  bytes: Uint8Array;
}

interface ChunkOutput {
  spec: ChunkSpec;
  lod0: Surface;
  lod1: Surface;
  collision: CollisionMesh;
  lod0Bytes: number;
  lod1Bytes: number;
}

interface PropCollision {
  positions: Float32Array;
  indices: Uint32Array;
}

interface Generated {
  files: EmittedFile[];
  field: RiftField;
  chunks: ChunkOutput[];
  placements: PropPlacement[];
  navGraph: NavGraph;
  propCollisions: Map<string, PropCollision>;
  boulderVisuals: Map<string, Part>;
}

// ---------- helpers ----------

function base64LE(values: Float32Array | Uint32Array): string {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < values.length; i++) {
    if (values instanceof Float32Array) view.setFloat32(i * 4, values[i]!, true);
    else view.setUint32(i * 4, values[i]!, true);
  }
  return Buffer.from(bytes).toString("base64");
}

function json(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
}

const round = (v: number, digits = 6): number => {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
};

/** Rounds the AABB OUTWARD so the shortened decimals can never clip a contact. */
function collisionBlock(mesh: PropCollision): Record<string, unknown> {
  const bounds = boundsOf(mesh.positions);
  const down = (v: number): number => Math.floor(v * 1e4) / 1e4;
  const up = (v: number): number => Math.ceil(v * 1e4) / 1e4;
  return {
    positions: base64LE(mesh.positions),
    indices: base64LE(mesh.indices),
    bounds: {
      min: { x: down(bounds.min.x), y: down(bounds.min.y), z: down(bounds.min.z) },
      max: { x: up(bounds.max.x), y: up(bounds.max.y), z: up(bounds.max.z) },
    },
  };
}

// ---------- generation ----------

async function generate(wasm: ManifoldToplevel, log: (message: string) => void): Promise<Generated> {
  const field = new RiftField(log);
  const specs = planChunks(field);
  log(`chunk pitch: ${specs.map((s) => `${s.index}:${s.cell}`).join(" ")}`);

  const files: EmittedFile[] = [];
  const chunks: ChunkOutput[] = [];
  const propCollisions = new Map<string, PropCollision>();

  for (const spec of specs) {
    // ONE full-resolution surface per chunk, used for both LOD levels.
    //
    // LOD1 used to be meshed independently at twice the pitch. That gave every
    // cross-LOD border its own private set of chords, so the moment a chunk
    // swapped LOD the ground split away from its neighbour — and because the
    // swap distance is shorter than the chunk pitch, a cross-LOD border is the
    // normal in-play state, not an edge case. Both levels are now cut from this
    // one mesh by tools/bake-lunar-rift-terrain.mjs, which never touches the
    // border ring, so LOD0 and LOD1 of any chunk present an identical edge and
    // a cross-LOD border is as watertight as a same-LOD one.
    const lod0 = buildChunkSurface(wasm, field, spec, spec.cell, { rims: true, lod: 0 });
    const lod1 = lod0;
    const collision = buildChunkCollision(wasm, field, spec);
    const id = `lunar-rift-chunk-${spec.index}`;
    const lod0Glb = await encodeGlb(`LOD0_TERRAIN_${spec.index}`, [{ surface: lod0, material: RIFT_ROCK }]);
    const lod1Glb = await encodeGlb(`LOD1_TERRAIN_${spec.index}`, [{ surface: lod1, material: RIFT_ROCK }]);
    files.push({ path: `props/${id}.glb`, bytes: lod0Glb });
    files.push({ path: `props/${id}_lod1.glb`, bytes: lod1Glb });
    files.push({
      path: `props/${id}.json`,
      bytes: json({
        id: `prop.${id}`,
        type: "prop",
        version: 1,
        name: `Lunar Rift Terrain ${spec.index}`,
        category: "terrain",
        impactDamage: 10,
        render: {
          recipe: "model.static",
          model: `props/${id}.glb`,
          lods: [{ model: `props/${id}_lod1.glb`, distance: LOD_DISTANCE }],
        },
        collision: collisionBlock(collision),
      }),
    });
    propCollisions.set(`prop.${id}`, collision);
    chunks.push({ spec, lod0, lod1, collision, lod0Bytes: lod0Glb.length, lod1Bytes: lod1Glb.length });
    log(
      `chunk ${spec.index} pitch ${spec.cell} play ${(spec.playFraction * 100).toFixed(0)}% ` +
        `source ${(lod0.indices.length / 3).toLocaleString()} tris ${(lod0Glb.length / 1024).toFixed(0)}KB ` +
        `col ${(collision.indices.length / 3).toLocaleString()}`,
    );
  }

  // ---- boulders ----
  const boulderVisuals = new Map<string, Part>();
  for (const variant of ["a", "b", "c"] as const) {
    const id = `lunar-rift-boulder-${variant}`;
    const shape = BOULDER_SHAPES[variant];
    const part = buildBoulder(shape);
    const collision = buildBoulderCollision(shape);
    boulderVisuals.set(`prop.${id}`, part);
    propCollisions.set(`prop.${id}`, collision);
    files.push({ path: `props/${id}.glb`, bytes: await encodeGlb(`BOULDER_${variant.toUpperCase()}`, [part]) });
    files.push({
      path: `props/${id}.json`,
      bytes: json({
        id: `prop.${id}`,
        type: "prop",
        version: 1,
        name: `Lunar Rift Boulder ${variant.toUpperCase()}`,
        category: "rock",
        impactDamage: 14,
        render: { recipe: "model.static", model: `props/${id}.glb` },
        collision: collisionBlock(collision),
      }),
    });
  }

  // ---- guide light ----
  {
    const id = "lunar-rift-guidelight";
    const parts = buildGuideLight();
    files.push({ path: `props/${id}.glb`, bytes: await encodeGlb("GUIDELIGHT", parts) });
    files.push({
      path: `props/${id}.json`,
      bytes: json({
        id: `prop.${id}`,
        type: "prop",
        version: 1,
        name: "Lunar Rift Guide Light",
        category: "decor",
        impactDamage: 0,
        render: { recipe: "model.static", model: `props/${id}.glb` },
      }),
    });
  }

  // ---- flag pad ----
  {
    const id = "lunar-rift-flagpad";
    const pad = buildFlagPad();
    propCollisions.set(`prop.${id}`, pad.collision);
    files.push({ path: `props/${id}.glb`, bytes: await encodeGlb("FLAGPAD", pad.parts) });
    files.push({
      path: `props/${id}.json`,
      bytes: json({
        id: `prop.${id}`,
        type: "prop",
        version: 1,
        name: "Lunar Rift Landing Pad",
        category: "structure",
        impactDamage: 0,
        render: { recipe: "model.static", model: `props/${id}.glb` },
        collision: collisionBlock(pad.collision),
      }),
    });
  }

  // ---- beacons ----
  for (const team of ["blue", "red"] as const) {
    const id = `lunar-rift-beacon-${team}`;
    const beacon = buildBeacon(team);
    propCollisions.set(`prop.${id}`, beacon.collision);
    files.push({ path: `props/${id}.glb`, bytes: await encodeGlb(`BEACON_${team.toUpperCase()}`, beacon.parts) });
    files.push({
      path: `props/${id}.json`,
      bytes: json({
        id: `prop.${id}`,
        type: "prop",
        version: 1,
        name: `Lunar Rift Beacon ${team === "blue" ? "Blue" : "Red"}`,
        category: "structure",
        impactDamage: 6,
        render: { recipe: "model.static", model: `props/${id}.glb` },
        collision: collisionBlock(beacon.collision),
      }),
    });
  }

  // ---- arena ----
  // NOTE (2026-08-14): content/arenas/lunar-rift.json carries two hand edits on
  // top of this generator's output, because they cannot be expressed here — the
  // He-3 extraction plant is an imported GLB, not a procedural part, and every
  // placement below is emitted as a mirrored *pair* (see `twinPlacement`) while
  // the plant sits on the symmetry point and is its own twin:
  //   • propPlacements gains `prop.lunar-rift-he3-plant` at (0, -8.75, 0), scale 1.5;
  //   • `nav-crater-mid` is lifted from the crater floor to y = 26 so bot routing
  //     clears the plant's roof (~y 20) instead of aiming inside the building.
  // Re-run this generator and both are lost — re-apply them before shipping.
  const southBores = field.bores.slice(0, TUNNELS_SOUTH.length);
  const authored: PropPlacement[] = [
    flagPadSouth(field),
    ...beaconsSouth(field),
    ...guideLightsSouth(southBores),
    ...scatterBouldersSouth(field),
  ];
  const placements: PropPlacement[] = [...chunkPlacements(), ...authored, ...authored.map(twinPlacement)];
  const navGraph = buildNavGraph(field, southBores);
  log(`placements: ${placements.length} (16 terrain + ${authored.length * 2} scatter), nav ${navGraph.nodes.length} nodes / ${navGraph.links.length} links`);

  files.push({
    path: "arenas/lunar-rift.json",
    bytes: json({
      id: "arena.lunar-rift",
      type: "arena",
      version: 1,
      name: "Lunar Rift",
      bounds: { shape: "box", width: 768, height: 768, floorY: KILL_FLOOR, ceilingY: CEILING },
      asteroidPlacements: [],
      propPlacements: placements,
      navGraph,
      spawnPoints: SPAWNS.map((spawn) => ({
        id: spawn.id,
        team: spawn.team,
        position: { x: spawn.position.x, y: spawn.position.y, z: spawn.position.z },
        heading: round(spawn.heading),
      })),
      flagBases: FLAGS.map((flag) => ({
        id: flag.id,
        team: flag.team,
        position: { x: flag.position.x, y: flag.position.y, z: flag.position.z },
        radius: flag.radius,
      })),
      lighting: {
        // Canyon interiors live or die on fill light: with no realtime shadows,
        // the baked AO carries depth, but shadow-side walls need enough ambient
        // to read as rock instead of specular-black voids. 0.085 (the open
        // lunar-crater bubble value) buried them; 0.26 + a warmer bounce keeps
        // the lunar harshness while letting the fluting/strata survive.
        ambientColor: "#b8b4ac",
        ambientIntensity: 0.26,
        groundBounceColor: "#4a453d",
        directionalIntensity: 1.45,
      },
      render: {
        skybox: {
          texture: "skyboxes/lunar-crater.webp",
          intensity: 0.9,
          tint: "#f2f4f7",
          sun: { dir: [-0.707, 0.5, -0.5], color: "#ffffff", intensity: 1.45 },
        },
        boundaryShield: {
          baseOpacity: 1,
          glowStartDistance: 14,
          redTransitionDistance: 5,
          warnDistance: 8,
          blueColor: "#45c8ff",
          redColor: "#ff405c",
          hexDensity: 42,
          hexLineWidth: 0.012,
          warningNotification: "notification.boundary-warning",
        },
      },
      zones: [],
    }),
  });

  return { files, field, chunks, placements, navGraph, propCollisions, boulderVisuals };
}

// ---------- self checks ----------

interface CheckRow {
  name: string;
  pass: boolean;
  detail: string;
}

function twinKey(x: number, y: number, z: number): string {
  return `${Math.round(x * 1e4)}|${Math.round(y * 1e4)}|${Math.round(z * 1e4)}`;
}

function layoutTwinClosed(): CheckRow {
  const problems: string[] = [];
  const closed = (name: string, points: readonly (readonly [number, number])[]): void => {
    const set = new Set(points.map(([x, z]) => `${Math.round(x * 1e4)}|${Math.round(z * 1e4)}`));
    for (const [x, z] of points) {
      if (!set.has(`${Math.round(-x * 1e4)}|${Math.round(-z * 1e4)}`)) problems.push(`${name} (${x},${z})`);
    }
  };
  const lanePts = LANES.flatMap((lane) => lane.pts);
  closed("lane", lanePts);
  const mouthPts = MOUTHS.flatMap((mouth) => mouth.pts);
  closed("mouth", mouthPts);
  closed("crater", CRATERS.map((c) => c.c));
  const tunnelPts = TUNNELS.flatMap((t) => [t.a, t.b]);
  closed("tunnel", tunnelPts);
  return {
    name: "layout twin-closed (lanes/mouths/craters/tunnels)",
    pass: problems.length === 0,
    detail: problems.length === 0
      ? `${lanePts.length + mouthPts.length + tunnelPts.length + CRATERS.length} points`
      : problems.slice(0, 4).join(", "),
  };
}

function placementsTwinned(placements: readonly PropPlacement[]): CheckRow {
  const scatter = placements.filter((p) => !p.propId.startsWith("prop.lunar-rift-chunk-"));
  const index = new Map<string, PropPlacement[]>();
  for (const p of scatter) {
    const key = twinKey(p.position.x, p.position.y, p.position.z);
    const bucket = index.get(key);
    if (bucket) bucket.push(p); else index.set(key, [p]);
  }
  const problems: string[] = [];
  for (const p of scatter) {
    const twins = index.get(twinKey(-p.position.x, p.position.y, -p.position.z));
    const expectedYaw = wrapAngle((p.rotation?.y ?? 0) + Math.PI);
    const hit = twins?.some((t) => {
      const yaw = wrapAngle(t.rotation?.y ?? 0);
      const dy = Math.min(Math.abs(yaw - expectedYaw), Math.PI * 2 - Math.abs(yaw - expectedYaw));
      const sameFamily = t.propId === p.propId || t.propId.replace(/-(blue|red)$/, "") === p.propId.replace(/-(blue|red)$/, "");
      return dy < 1e-4 && sameFamily && (t.scale ?? 1) === (p.scale ?? 1);
    });
    if (!hit) problems.push(`${p.propId} (${p.position.x},${p.position.z})`);
  }
  return {
    name: "prop placements twinned (terrain exempt)",
    pass: problems.length === 0,
    detail: problems.length === 0 ? `${scatter.length} placements` : problems.slice(0, 4).join(", "),
  };
}

function pointsTwinned(name: string, points: readonly { x: number; y: number; z: number }[]): CheckRow {
  const set = new Set(points.map((p) => twinKey(p.x, p.y, p.z)));
  const missing = points.filter((p) => !set.has(twinKey(-p.x, p.y, -p.z)));
  return { name, pass: missing.length === 0, detail: missing.length === 0 ? `${points.length} points` : `${missing.length} unmatched` };
}

function groundCheck(world: CollisionWorld): CheckRow {
  const probes = [
    ...SPAWNS.map((s) => ({ id: s.id, ...s.position })),
    ...FLAGS.map((f) => ({ id: f.id, ...f.position })),
  ];
  let worst = 0, worstId = "";
  const misses: string[] = [];
  for (const probe of probes) {
    const hit = world.heightBelow(probe.x, probe.y, probe.z, GROUND_DROP_LIMIT);
    if (hit === null) { misses.push(probe.id); continue; }
    const drop = probe.y - hit;
    if (drop > worst) { worst = drop; worstId = probe.id; }
  }
  return {
    name: `spawn/flag ground within ${GROUND_DROP_LIMIT}u`,
    pass: misses.length === 0,
    detail: misses.length === 0 ? `worst drop ${worst.toFixed(2)}u (${worstId})` : `no ground under ${misses.join(", ")}`,
  };
}

function tunnelClearance(world: CollisionWorld, bores: readonly Bore[]): CheckRow {
  let worst = Infinity, worstAt = "";
  for (const [index, bore] of bores.entries()) {
    const from = bore.tIn + 1.5, to = bore.tOut - 1.5;
    for (let k = 0; k < 20; k++) {
      const t = from + ((to - from) * k) / 19;
      const x = bore.start[0] + bore.dir[0] * t;
      const z = bore.start[2] + bore.dir[2] * t;
      const d = world.nearestDistance(x, bore.tunnel.portalY, z);
      if (d < worst) { worst = d; worstAt = `bore ${index} t=${t.toFixed(0)}`; }
    }
  }
  return {
    name: `tunnel bore clearance >= ${TUNNEL_CLEARANCE}u`,
    pass: worst >= TUNNEL_CLEARANCE,
    detail: `min ${worst.toFixed(2)}u (${worstAt})`,
  };
}

function reachable(graph: NavGraph, from: string, to: string, banned: ReadonlySet<string>): boolean {
  if (banned.has(from) || banned.has(to)) return false;
  const adjacency = new Map<string, string[]>();
  const link = (a: string, b: string): void => {
    let list = adjacency.get(a);
    if (!list) { list = []; adjacency.set(a, list); }
    list.push(b);
  };
  for (const [a, b] of graph.links) {
    if (banned.has(a) || banned.has(b)) continue;
    link(a, b);
    link(b, a);
  }
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === to) return true;
    for (const next of adjacency.get(current) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return false;
}

function navChecks(graph: NavGraph, world: CollisionWorld): CheckRow[] {
  const blue = "nav-crater-blue", red = "nav-crater-blue-t";
  const ids = graph.nodes.map((n) => n.id);
  const midLane = new Set(ids.filter((id) => id.startsWith("nav-lane0-")));
  const flankLane = new Set(ids.filter((id) => id.startsWith("nav-lane1-")));
  const rows: CheckRow[] = [
    { name: "nav flag<->flag reachable", pass: reachable(graph, blue, red, new Set()), detail: `${graph.nodes.length} nodes / ${graph.links.length} links` },
    { name: "nav route via mid lane", pass: reachable(graph, blue, red, flankLane), detail: "flank lanes banned" },
    { name: "nav route via flanks (no mid, no tunnels)", pass: reachable(graph, blue, red, new Set([...midLane, ...ids.filter((id) => id.startsWith("nav-tunnel"))])), detail: "mid lane + tunnels banned" },
  ];
  const tunnelIds = ids.filter((id) => id.startsWith("nav-tunnel"));
  const groups = new Map<string, string[]>();
  for (const id of tunnelIds) {
    const match = /^nav-tunnel(\d+)-[01](-t)?$/.exec(id);
    if (!match) continue;
    const key = `nav-tunnel${match[1]}${match[2] ?? ""}`;
    let list = groups.get(key);
    if (!list) { list = []; groups.set(key, list); }
    list.push(id);
  }
  for (const key of [...groups.keys()].sort()) {
    const mine = groups.get(key)!;
    if (mine.length !== 2) continue;
    const others = new Set(tunnelIds.filter((id) => !mine.includes(id)));
    const pass =
      (reachable(graph, blue, mine[0]!, others) && reachable(graph, mine[1]!, red, others)) ||
      (reachable(graph, blue, mine[1]!, others) && reachable(graph, mine[0]!, red, others));
    rows.push({ name: `nav route through ${key}`, pass, detail: mine.join(" -> ") });
  }
  let worst = 0, worstId = "", buried = 0;
  for (const node of graph.nodes) {
    const hit = world.heightBelow(node.position.x, node.position.y, node.position.z, 40);
    if (hit === null) { buried++; continue; }
    const clearance = node.position.y - hit;
    if (clearance > worst) { worst = clearance; worstId = node.id; }
  }
  rows.push({
    name: `nav nodes above ground, clearance <= ${NAV_MAX_CLEARANCE}u`,
    pass: buried === 0 && worst <= NAV_MAX_CLEARANCE,
    detail: buried > 0 ? `${buried} nodes with no ground below` : `worst ${worst.toFixed(2)}u (${worstId})`,
  });
  return rows;
}

function wireCheck(generated: Generated): CheckRow {
  const offenders: string[] = [];
  const test = (label: string, values: readonly number[]): void => {
    for (const v of values) if (Math.abs(v) > COORD_LIMIT) offenders.push(`${label} ${v}`);
  };
  for (const p of generated.placements) test(p.propId, [p.position.x, p.position.y, p.position.z]);
  for (const n of generated.navGraph.nodes) test(n.id, [n.position.x, n.position.y, n.position.z]);
  for (const s of SPAWNS) test(s.id, [s.position.x, s.position.y, s.position.z]);
  for (const f of FLAGS) test(f.id, [f.position.x, f.position.y, f.position.z]);
  test("bounds", [WORLD_EXT, CEILING, KILL_FLOOR]);
  return { name: `every authored coordinate |v| <= ${COORD_LIMIT}`, pass: offenders.length === 0, detail: offenders.length === 0 ? "ok" : offenders.slice(0, 4).join(", ") };
}

function budgetChecks(generated: Generated): CheckRow[] {
  const lod0 = generated.chunks.reduce((sum, c) => sum + c.lod0.indices.length / 3, 0);
  const lod1 = generated.chunks.reduce((sum, c) => sum + c.lod1.indices.length / 3, 0);
  const collision = generated.chunks.reduce((sum, c) => sum + c.collision.indices.length / 3, 0);
  const biggest = generated.chunks.reduce((max, c) => Math.max(max, c.lod0Bytes, c.lod1Bytes), 0);
  void lod1;
  return [
    { name: `source total <= ${SOURCE_TRI_BUDGET.toLocaleString()} tris`, pass: lod0 <= SOURCE_TRI_BUDGET, detail: `${lod0.toLocaleString()} tris (bake trims this to the shipped LOD budgets)` },
    { name: `collision total <= ${COLLISION_TRI_BUDGET.toLocaleString()} tris`, pass: collision <= COLLISION_TRI_BUDGET, detail: `${collision.toLocaleString()} tris` },
    { name: `chunk GLB <= ${(CHUNK_GLB_BYTES / 1024 / 1024).toFixed(2)} MB`, pass: biggest <= CHUNK_GLB_BYTES, detail: `largest ${(biggest / 1024).toFixed(0)} KB` },
  ];
}

// ---------- preview ----------

function previewMeshes(generated: Generated): PreviewMesh[] {
  const meshes: PreviewMesh[] = [];
  for (const chunk of generated.chunks) {
    meshes.push({
      positions: chunk.lod0.positions,
      normals: chunk.lod0.normals,
      colors: chunk.lod0.colors,
      indices: chunk.lod0.indices,
      offset: [chunk.spec.cx, 0, chunk.spec.cz],
    });
  }
  for (const placement of generated.placements) {
    const part = generated.boulderVisuals.get(placement.propId);
    if (!part) continue;
    const scale = placement.scale ?? 1;
    const yaw = placement.rotation?.y ?? 0;
    const cos = Math.cos(yaw), sin = Math.sin(yaw);
    const source = part.surface;
    const positions = new Float32Array(source.positions.length);
    const normals = new Float32Array(source.normals.length);
    for (let i = 0; i < source.positions.length; i += 3) {
      const x = source.positions[i]! * scale, y = source.positions[i + 1]! * scale, z = source.positions[i + 2]! * scale;
      positions[i] = x * cos + z * sin;
      positions[i + 1] = y;
      positions[i + 2] = -x * sin + z * cos;
      const nx = source.normals[i]!, nz = source.normals[i + 2]!;
      normals[i] = nx * cos + nz * sin;
      normals[i + 1] = source.normals[i + 1]!;
      normals[i + 2] = -nx * sin + nz * cos;
    }
    meshes.push({
      positions,
      normals,
      colors: source.colors,
      indices: source.indices,
      offset: [placement.position.x, placement.position.y, placement.position.z],
    });
  }
  return meshes;
}

function previewViews(bores: readonly Bore[]): View[] {
  const west = bores[0]!;
  const portal = west.portals[0];
  const eye: [number, number, number] = [portal.x - west.dir[0] * 10, portal.y, portal.z - west.dir[2] * 10];
  const mid = (west.tIn + west.tOut) / 2;
  const inside: [number, number, number] = [
    west.start[0] + west.dir[0] * mid,
    west.tunnel.portalY,
    west.start[2] + west.dir[2] * mid,
  ];
  return [
    { name: "qa-west-lane", eye: [-182, 12, -118], target: [-225, 8, 0], fov: 68 },
    { name: "qa-blue-crater", eye: [0, 14, -250], target: [0, 4, -160], fov: 68 },
    { name: "qa-central", eye: [0, 2, -92], target: [0, -8, 60], fov: 68 },
    { name: "qa-overview", eye: [-240, 130, -300], target: [40, 0, 60], fov: 55 },
    { name: "qa-tunnel", eye, target: [portal.x + west.dir[0] * 60, portal.y, portal.z + west.dir[2] * 60], fov: 68 },
    // Mid-bore looking back out of the lane-side portal: judges interior
    // darkness falloff and the rib displacement in one frame.
    { name: "qa-tunnel-inside", eye: inside, target: [portal.x, portal.y, portal.z], fov: 68 },
  ];
}

// ---------- entry ----------

function writeAll(root: string, files: readonly EmittedFile[]): void {
  for (const file of files) {
    const target = path.join(root, file.path);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, file.bytes);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const preview = argv.includes("--preview");
  const quick = argv.includes("--quick");
  const outIndex = argv.indexOf("--out");
  const outDir = path.resolve(outIndex >= 0 ? argv[outIndex + 1] ?? "content" : "content");
  const started = Date.now();
  const log = (message: string): void => console.log(`  ${message}`);

  const wasm = await loadCsg();
  console.log("generating lunar rift…");
  const generated = await generate(wasm, log);
  writeAll(outDir, generated.files);
  console.log(`wrote ${generated.files.length} files to ${outDir}`);

  // ---- collision world for the geometric checks ----
  const placedMeshes: PlacedMesh[] = [];
  for (const placement of generated.placements) {
    const mesh = generated.propCollisions.get(placement.propId);
    if (!mesh) continue;
    const scale = placement.scale ?? 1;
    const yaw = placement.rotation?.y ?? 0;
    const cos = Math.cos(yaw), sin = Math.sin(yaw);
    const positions = new Float32Array(mesh.positions.length);
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const x = mesh.positions[i]! * scale, y = mesh.positions[i + 1]! * scale, z = mesh.positions[i + 2]! * scale;
      positions[i] = x * cos + z * sin;
      positions[i + 1] = y;
      positions[i + 2] = -x * sin + z * cos;
    }
    placedMeshes.push({ positions, indices: mesh.indices, offset: placement.position });
  }
  const world = new CollisionWorld(placedMeshes);

  const rows: CheckRow[] = [
    layoutTwinClosed(),
    placementsTwinned(generated.placements),
    pointsTwinned("spawn points twinned", SPAWNS.map((s) => s.position)),
    pointsTwinned("flag bases twinned", FLAGS.map((f) => f.position)),
    pointsTwinned("nav nodes twinned", generated.navGraph.nodes.map((n) => n.position)),
    groundCheck(world),
    tunnelClearance(world, generated.field.bores),
    ...navChecks(generated.navGraph, world),
    wireCheck(generated),
    ...budgetChecks(generated),
  ];

  if (preview) {
    const previewDir = path.resolve("tools/lunar-rift/preview");
    mkdirSync(previewDir, { recursive: true });
    const meshes = previewMeshes(generated);
    for (const view of previewViews(generated.field.bores)) {
      renderView(meshes, view, path.join(previewDir, `${view.name}.png`));
      console.log(`  preview ${view.name}.png`);
    }
  }

  if (quick) {
    rows.push({ name: "determinism (re-run byte compare)", pass: true, detail: "SKIPPED (--quick)" });
  } else {
    const temp = mkdtempSync(path.join(tmpdir(), "lunar-rift-"));
    try {
      const second = await generate(wasm, () => {});
      writeAll(temp, second.files);
      const mismatches: string[] = [];
      if (second.files.length !== generated.files.length) mismatches.push("file count");
      for (const [index, file] of generated.files.entries()) {
        const other = second.files[index];
        if (!other || other.path !== file.path) { mismatches.push(`order @${index}`); continue; }
        if (!Buffer.from(file.bytes).equals(Buffer.from(other.bytes))) mismatches.push(file.path);
      }
      rows.push({
        name: "determinism (re-run byte compare)",
        pass: mismatches.length === 0,
        detail: mismatches.length === 0 ? `${generated.files.length} files identical` : mismatches.slice(0, 4).join(", "),
      });
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }

  const width = Math.max(...rows.map((r) => r.name.length));
  console.log("");
  console.log("SELF-CHECKS");
  for (const row of rows) console.log(`  ${row.pass ? "PASS" : "FAIL"}  ${row.name.padEnd(width)}  ${row.detail}`);
  console.log(`\ndone in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  if (rows.some((row) => !row.pass)) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

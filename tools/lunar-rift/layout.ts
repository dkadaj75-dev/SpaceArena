/**
 * Arena authoring: prop placements and the bot nav graph.
 *
 * Everything here is authored ONCE and emitted with its 180° twin
 * ((-x, y, -z), yaw + π). That is the only way the map stays e-sport symmetric
 * while the terrain noise underneath is positional — nothing is ever authored
 * twice by hand, and the self-check proves the emitted set is twin closed.
 */
import { CRATERS, LANES, MID, MOUTHS_SOUTH, TEAM, WALL_RUN, hash2, type Pt } from "./riftLib.js";
import { WORLD_EXT, type Bore, type RiftField } from "./field.js";
import { CHUNKS_PER_SIDE, CHUNK_SIZE } from "./mesh.js";

export interface PropPlacement {
  propId: string;
  position: { x: number; y: number; z: number };
  rotation?: { y: number };
  scale?: number;
  locked?: boolean;
}

export interface NavNode {
  id: string;
  position: { x: number; y: number; z: number };
  hub?: boolean;
}

export interface NavGraph {
  nodes: NavNode[];
  links: [string, string][];
}

const TWO_PI = Math.PI * 2;
export const wrapAngle = (a: number): number => {
  let v = a % TWO_PI;
  if (v < 0) v += TWO_PI;
  return v;
};

const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;

/** The 180° twin of a placement. Team-coloured props swap their colour suffix. */
export function twinPlacement(p: PropPlacement): PropPlacement {
  const twinId = p.propId.endsWith("-blue")
    ? `${p.propId.slice(0, -5)}-red`
    : p.propId.endsWith("-red")
      ? `${p.propId.slice(0, -4)}-blue`
      : p.propId;
  const twin: PropPlacement = {
    propId: twinId,
    position: { x: round6(-p.position.x), y: round6(p.position.y), z: round6(-p.position.z) },
  };
  if (p.rotation) twin.rotation = { y: round6(wrapAngle(p.rotation.y + Math.PI)) };
  if (p.scale !== undefined) twin.scale = p.scale;
  if (p.locked !== undefined) twin.locked = p.locked;
  return twin;
}

// ---------- polyline helpers ----------

function polylineLength(pts: readonly Pt[]): number {
  let total = 0;
  for (let i = 0; i + 1 < pts.length; i++) total += Math.hypot(pts[i + 1]![0] - pts[i]![0], pts[i + 1]![1] - pts[i]![1]);
  return total;
}

interface Station { x: number; z: number; tx: number; tz: number }

function stationAt(pts: readonly Pt[], s: number): Station {
  let remaining = s;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!, b = pts[i + 1]!;
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (remaining <= len || i + 2 === pts.length) {
      const t = len > 0 ? Math.min(1, remaining / len) : 0;
      return { x: a[0] + dx * t, z: a[1] + dz * t, tx: dx / (len || 1), tz: dz / (len || 1) };
    }
    remaining -= len;
  }
  const last = pts[pts.length - 1]!;
  return { x: last[0], z: last[1], tx: 1, tz: 0 };
}

// ---------- terrain chunk placements ----------

export function chunkPlacements(): PropPlacement[] {
  const out: PropPlacement[] = [];
  for (let iz = 0; iz < CHUNKS_PER_SIDE; iz++) {
    for (let ix = 0; ix < CHUNKS_PER_SIDE; ix++) {
      out.push({
        propId: `prop.lunar-rift-chunk-${iz * CHUNKS_PER_SIDE + ix}`,
        position: {
          x: -WORLD_EXT + ix * CHUNK_SIZE + CHUNK_SIZE / 2,
          y: 0,
          z: -WORLD_EXT + iz * CHUNK_SIZE + CHUNK_SIZE / 2,
        },
        locked: true,
      });
    }
  }
  return out;
}

// ---------- boulder scatter ----------

const BOULDER_VARIANTS = ["a", "b", "c"] as const;

/** Ground level that keeps BOTH twins embedded rather than floating. */
function twinGround(field: RiftField, x: number, z: number): number {
  return Math.min(field.heightAt(x, z), field.heightAt(-x, -z));
}

function boulderAt(field: RiftField, x: number, z: number, key: number): PropPlacement {
  const size = hash2(Math.round(x * 7), Math.round(z * 7), 4200 + key);
  const scale = 1.2 + 3.3 * Math.pow(size, 1.7);
  const variant = BOULDER_VARIANTS[Math.min(2, Math.floor(hash2(Math.round(x * 3), Math.round(z * 3), 4300 + key) * 3))]!;
  const yaw = wrapAngle(hash2(Math.round(x * 5), Math.round(z * 5), 4400 + key) * TWO_PI);
  return {
    propId: `prop.lunar-rift-boulder-${variant}`,
    position: { x: round6(x), y: round6(twinGround(field, x, z) + 0.45 * scale), z: round6(z) },
    rotation: { y: round6(yaw) },
    scale: round6(scale),
  };
}

/**
 * Deterministic scatter over the southern half only; the caller mirrors it.
 * Boulders hug wall bases (cover you can hide behind at lane speed), ring the
 * crater floor edges, and cluster loosely on open floor.
 */
export function scatterBouldersSouth(field: RiftField): PropPlacement[] {
  const out: PropPlacement[] = [];
  /**
   * Southern half only, on ground flat enough to rest on, and only where the
   * twin site is at a similar height — a boulder carries its twin's y, so a big
   * height difference would leave one of the pair buried or floating.
   */
  const accept = (x: number, z: number): boolean => {
    if (z >= -0.5 || Math.abs(x) > 364 || Math.abs(z) > 364) return false;
    if (field.baseNormal(x, z)[1] < 0.74 || field.baseNormal(-x, -z)[1] < 0.74) return false;
    return Math.abs(field.heightAt(x, z) - field.heightAt(-x, -z)) < 3;
  };

  LANES.forEach((lane, laneIndex) => {
    const length = polylineLength(lane.pts);
    const stride = 25;
    for (let k = 0; k * stride + 8 < length; k++) {
      const station = stationAt(lane.pts, k * stride + 8);
      for (let side = 0; side < 2; side++) {
        const sign = side === 0 ? -1 : 1;
        if (hash2(laneIndex * 971 + k, side, 4001) > 0.53) continue;
        const offset = lane.width / 2 - 2 + 5 * hash2(k * 17 + side, laneIndex, 4013);
        const x = station.x + station.tz * sign * offset;
        const z = station.z - station.tx * sign * offset;
        if (!accept(x, z)) continue;
        out.push(boulderAt(field, round6(x), round6(z), laneIndex * 100 + k * 2 + side));
      }
    }
  });

  CRATERS.forEach((crater, craterIndex) => {
    const ringRadius = crater.r - WALL_RUN * 0.4 - 4;
    const steps = 18;
    for (let k = 0; k < steps; k++) {
      if (hash2(craterIndex * 313 + k, 7, 4101) > 0.5) continue;
      const angle = (k / steps) * TWO_PI + 0.21 * hash2(k, craterIndex, 4103);
      const radius = ringRadius - 5 * hash2(k, craterIndex + 5, 4107);
      const x = crater.c[0] + Math.cos(angle) * radius;
      const z = crater.c[1] + Math.sin(angle) * radius;
      if (!accept(x, z)) continue;
      out.push(boulderAt(field, round6(x), round6(z), 5000 + craterIndex * 50 + k));
    }
  });

  // Loose floor clusters: something to weave through in the open bowls.
  const clusters: Pt[] = [[0, -226], [-40, -176], [40, -176], [-52, -52], [46, -60], [-176, -128], [176, -128]];
  clusters.forEach((centre, index) => {
    for (let k = 0; k < 3; k++) {
      const angle = hash2(index, k, 4201) * TWO_PI;
      const radius = 5 + 11 * hash2(index + 3, k, 4203);
      const x = centre[0] + Math.cos(angle) * radius;
      const z = centre[1] + Math.sin(angle) * radius;
      if (!accept(x, z)) continue;
      out.push(boulderAt(field, round6(x), round6(z), 6000 + index * 10 + k));
    }
  });

  return out;
}

// ---------- flag pads, beacons, guide lights ----------

export function flagPadSouth(field: RiftField): PropPlacement {
  return {
    propId: "prop.lunar-rift-flagpad",
    position: { x: 0, y: round6(twinGround(field, TEAM.c[0], TEAM.c[1]) - 0.25), z: TEAM.c[1] },
    rotation: { y: 0 },
  };
}

export function beaconsSouth(field: RiftField): PropPlacement[] {
  // Just inside the crater lip, flanking the two side mouths, so the mouths
  // read as gates from anywhere in the bowl.
  const anchors: Pt[] = [MOUTHS_SOUTH[1]!.pts[0]!, MOUTHS_SOUTH[2]!.pts[0]!];
  return anchors.map((anchor) => {
    const toCentre = Math.atan2(TEAM.c[1] - anchor[1], TEAM.c[0] - anchor[0]);
    const x = round6(anchor[0] + Math.cos(toCentre) * 9);
    const z = round6(anchor[1] + Math.sin(toCentre) * 9);
    return {
      propId: "prop.lunar-rift-beacon-blue",
      position: { x, y: round6(twinGround(field, x, z) - 0.4), z },
      rotation: { y: round6(wrapAngle(toCentre)) },
    };
  });
}

/** Strips on the bore roof every ~15u, strictly inside the two portal faces. */
export function guideLightsSouth(bores: readonly Bore[]): PropPlacement[] {
  const out: PropPlacement[] = [];
  const spacing = 15;
  // tIn/tOut are the rock-face crossings found after the CSG cylinder's
  // extension march. Keep the rings clear of those faces, never on the open
  // lane floor outside a portal.
  const portalInset = 6;
  for (const bore of bores) {
    const from = bore.tIn + portalInset, to = bore.tOut - portalInset;
    if (to <= from) continue;
    const count = Math.max(1, Math.round((to - from) / spacing));
    const yaw = wrapAngle(Math.atan2(bore.dir[0], bore.dir[2]));
    for (let k = 0; k <= count; k++) {
      const t = from + ((to - from) * k) / count;
      out.push({
        propId: "prop.lunar-rift-guidelight",
        position: {
          x: round6(bore.start[0] + bore.dir[0] * t),
          y: round6(bore.tunnel.portalY + bore.tunnel.r - 0.55),
          z: round6(bore.start[2] + bore.dir[2] * t),
        },
        rotation: { y: round6(yaw) },
      });
    }
  }
  return out;
}

// ---------- nav graph ----------

const NAV_CLEARANCE = 1.2;

function navY(field: RiftField, x: number, z: number): number {
  return round6(Math.max(field.heightAt(x, z), field.heightAt(-x, -z)) + NAV_CLEARANCE);
}

interface AuthoredNav {
  nodes: NavNode[];
  links: [string, string][];
  /** Ids that are their own twin (they sit on the symmetry point). */
  selfTwin: Set<string>;
}

const twinId = (id: string): string => (id.endsWith("-t") ? id.slice(0, -2) : `${id}-t`);

/**
 * Lane centrelines every ~45u, every crater centre (hub) and mouth, and both
 * portals of every tunnel. Links chain the lanes and stitch mouths, craters and
 * tunnels together so flag<->flag routes exist through mid AND through either
 * flank, with or without the tunnels.
 */
function authorNav(field: RiftField, boresSouth: readonly Bore[]): AuthoredNav {
  const nodes: NavNode[] = [];
  const links: [string, string][] = [];
  const selfTwin = new Set<string>();
  const add = (id: string, x: number, z: number, y: number, hub = false): string => {
    const node: NavNode = { id, position: { x: round6(x), y: round6(y), z: round6(z) } };
    if (hub) node.hub = true;
    nodes.push(node);
    return id;
  };

  // Craters.
  const blueHub = add("nav-crater-blue", TEAM.c[0], TEAM.c[1], navY(field, TEAM.c[0], TEAM.c[1]), true);
  const midHub = add("nav-crater-mid", MID.c[0], MID.c[1], navY(field, MID.c[0], MID.c[1]), true);
  selfTwin.add(midHub);

  // Crater mouths (south set; the twins are generated).
  const mouthIds = MOUTHS_SOUTH.map((mouth, index) => {
    const a = mouth.pts[0]!, b = mouth.pts[mouth.pts.length - 1]!;
    const x = (a[0] + b[0]) / 2, z = (a[1] + b[1]) / 2;
    return add(`nav-mouth-${index}`, x, z, navY(field, x, z));
  });

  // Lane centrelines. The mid lane is authored south-only; the west flank lane
  // is authored end to end and its twin becomes the east flank.
  const laneIds: string[][] = [];
  [LANES[0]!, LANES[1]!].forEach((lane, laneIndex) => {
    const length = polylineLength(lane.pts);
    const count = Math.max(1, Math.round(length / 45));
    const ids: string[] = [];
    for (let k = 0; k <= count; k++) {
      const station = stationAt(lane.pts, (length * k) / count);
      ids.push(add(`nav-lane${laneIndex}-${k}`, station.x, station.z, navY(field, station.x, station.z)));
    }
    laneIds.push(ids);
    for (let k = 0; k + 1 < ids.length; k++) links.push([ids[k]!, ids[k + 1]!]);
  });
  const midLane = laneIds[0]!;
  const flankLane = laneIds[1]!;

  // Blue crater <-> its three mouths.
  links.push([blueHub, mouthIds[0]!], [blueHub, mouthIds[1]!], [blueHub, mouthIds[2]!]);
  // Mid mouth -> mid lane -> the central crater's south mouth -> the hub.
  links.push([mouthIds[0]!, midLane[0]!]);
  links.push([midLane[midLane.length - 1]!, mouthIds[3]!]);
  links.push([mouthIds[3]!, midHub]);
  // Side mouths -> the flank lanes. Mouth 1 opens onto the west lane's south
  // end; mouth 2 opens onto the EAST lane's south end, which is the twin of the
  // west lane's north end.
  links.push([mouthIds[1]!, flankLane[0]!]);
  links.push([mouthIds[2]!, twinId(flankLane[flankLane.length - 1]!)]);

  // Tunnel portals, parked just inside the bore near its floor.
  boresSouth.forEach((bore, index) => {
    const floorY = bore.tunnel.portalY - bore.tunnel.r + 2.2;
    const ends = [bore.tIn + 7, bore.tOut - 7];
    const ids = ends.map((t, side) =>
      add(
        `nav-tunnel${index}-${side}`,
        bore.start[0] + bore.dir[0] * t,
        bore.start[2] + bore.dir[2] * t,
        floorY,
      ),
    );
    links.push([ids[0]!, ids[1]!]);
    // Lane-side portal -> nearest flank lane node; crater-side portal -> hub.
    let nearest = flankLane[0]!, best = Infinity;
    const mouth = bore.portals[0];
    for (const id of flankLane) {
      const node = nodes.find((n) => n.id === id)!;
      const d = Math.hypot(node.position.x - mouth.x, node.position.z - mouth.z);
      if (d < best) { best = d; nearest = id; }
    }
    links.push([ids[0]!, nearest]);
    links.push([ids[1]!, midHub]);
  });

  return { nodes, links, selfTwin };
}

export function buildNavGraph(field: RiftField, boresSouth: readonly Bore[]): NavGraph {
  const authored = authorNav(field, boresSouth);
  const nodes: NavNode[] = [];
  for (const node of authored.nodes) {
    nodes.push(node);
    if (authored.selfTwin.has(node.id)) continue;
    const twin: NavNode = {
      id: twinId(node.id),
      position: { x: round6(-node.position.x), y: node.position.y, z: round6(-node.position.z) },
    };
    if (node.hub) twin.hub = true;
    nodes.push(twin);
  }
  const known = new Set(nodes.map((n) => n.id));
  const links: [string, string][] = [];
  const seen = new Set<string>();
  const push = (a: string, b: string): void => {
    if (!known.has(a) || !known.has(b) || a === b) return;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push([a, b]);
  };
  for (const [a, b] of authored.links) {
    push(a, b);
    push(authored.selfTwin.has(a) ? a : twinId(a), authored.selfTwin.has(b) ? b : twinId(b));
  }
  return { nodes, links };
}

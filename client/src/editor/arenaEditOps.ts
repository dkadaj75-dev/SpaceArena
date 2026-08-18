/**
 * Pure arena-placement editing math, lifted out of the old Map tool so the
 * viewport session that drives it stays a thin Babylon shell.
 *
 * Everything here operates on a plain {@link ArenaConfig} the caller has already
 * cloned — Constellation's draft pack is the single source of truth, so the
 * shape of an edit is always "clone the arena, mutate the clone, hand it back to
 * `DraftPackStore.setFile`". Nothing in this module touches a scene, a registry
 * or a network call.
 */

import type { ArenaConfig } from "@space-arena/shared";

/**
 * The layer vocabulary of the arena tool. "terrain" is a PSEUDO-layer: it owns
 * no placement array of its own, and instead governs the prop placements that
 * are ground (a `terrain`-category prop, or a hand-locked placement). "bounds"
 * likewise governs the bounds outline rather than a list.
 */
export type Layer = "asteroid" | "prop" | "terrain" | "spawn" | "flag" | "nav" | "bounds";
/** The layers that really do address a placement array. */
export type PlacementKind = Exclude<Layer, "bounds" | "terrain">;

export const PLACEMENT_KINDS: readonly PlacementKind[] = ["asteroid", "prop", "spawn", "flag", "nav"];

/** Row order of the Layers control — matches the old Map tool exactly. */
export const LAYERS: ReadonlyArray<readonly [Layer, string]> = [
  ["asteroid", "Asteroids"],
  ["prop", "Props"],
  ["terrain", "Terrain"],
  ["spawn", "Spawns"],
  ["flag", "Flag bases"],
  ["nav", "Nav graph"],
  ["bounds", "Bounds"],
];

/** Per-layer visibility + lock. Terrain starts LOCKED so stray clicks never drag the floor. */
export interface LayerState { visible: boolean; locked: boolean }
export function defaultLayers(): Map<Layer, LayerState> {
  return new Map(LAYERS.map(([layer]) => [layer, { visible: true, locked: layer === "terrain" }]));
}

/**
 * The union of every field the five placement arrays carry. The arena schema
 * keeps them as five distinct shapes; the editor addresses them uniformly and
 * only ever reads the fields the selected kind actually has.
 */
export interface EditorPlacement {
  position: { x: number; y?: number; z: number };
  id?: string;
  team?: number;
  heading?: number;
  asteroidId?: string;
  propId?: string;
  rotation?: number | { y?: number; x?: number; z?: number };
  scale?: number;
  radius?: number;
  hub?: boolean;
  locked?: boolean;
}

/** Mirror bookkeeping: index ↔ index of the twin placement, per kind. */
export type PairMap = Record<PlacementKind, Map<number, number>>;
export function emptyPairs(): PairMap {
  return { asteroid: new Map(), prop: new Map(), spawn: new Map(), flag: new Map(), nav: new Map() };
}

/** The array a placement kind lives in, or undefined when the arena authors none. */
export function listFor(arena: ArenaConfig, kind: PlacementKind): EditorPlacement[] | undefined {
  if (kind === "asteroid") return arena.asteroidPlacements as EditorPlacement[];
  if (kind === "prop") return arena.propPlacements as EditorPlacement[] | undefined;
  if (kind === "spawn") return arena.spawnPoints as EditorPlacement[];
  if (kind === "flag") return arena.flagBases as EditorPlacement[] | undefined;
  return arena.navGraph?.nodes as EditorPlacement[] | undefined;
}

/**
 * Which layer row governs one placement. Only props are interesting: a
 * `terrain`-category prop, or any placement with `locked: true`, answers to the
 * Terrain pseudo-layer instead of Props — so hiding or unlocking the ground is
 * one toggle rather than a hunt through 129 rows.
 */
export function governingLayer(
  arena: ArenaConfig,
  kind: PlacementKind,
  index: number,
  isTerrainProp: (propId: string) => boolean,
): Layer {
  if (kind !== "prop") return kind;
  const placement = arena.propPlacements?.[index];
  if (!placement) return "prop";
  return placement.locked || isTerrainProp(placement.propId) ? "terrain" : "prop";
}

/**
 * The mirrored counterpart of a placement: reflected through the arena origin
 * in X/Z, spun a half turn, and (for spawns and flag bases) handed to the other
 * team with a fresh unique id.
 */
export function twinOf(kind: PlacementKind, source: EditorPlacement, arena: ArenaConfig): EditorPlacement {
  const twin = structuredClone(source);
  twin.position = { ...twin.position, x: -twin.position.x, z: -twin.position.z };
  if (kind === "asteroid") twin.rotation = (typeof twin.rotation === "number" ? twin.rotation : 0) + Math.PI;
  if (kind === "prop") {
    const rotation = typeof twin.rotation === "object" && twin.rotation !== null ? twin.rotation : {};
    twin.rotation = { ...rotation, y: (rotation.y ?? 0) + Math.PI };
  }
  if (kind === "spawn") {
    twin.heading = (twin.heading ?? 0) + Math.PI;
    twin.team = twin.team === 0 ? 1 : 0;
    twin.id = uniqueTwinId(arena.spawnPoints, twin.id ?? "spawn");
  }
  if (kind === "flag") {
    twin.team = twin.team === 0 ? 1 : 0;
    twin.id = uniqueTwinId(arena.flagBases ?? [], twin.id ?? "flag");
  }
  if (kind === "nav") twin.id = nextNodeId(arena);
  return twin;
}

export function uniqueTwinId(items: ReadonlyArray<{ id: string }>, id: string): string {
  let next = `${id}-mirror`;
  let n = 2;
  while (items.some((item) => item.id === next)) next = `${id}-mirror-${n++}`;
  return next;
}

/** Does `candidate` look like the already-authored mirror of `source`? */
export function isTwinCandidate(kind: PlacementKind, source: EditorPlacement, candidate: EditorPlacement): boolean {
  if (Math.abs(candidate.position.x + source.position.x) > 0.001
    || Math.abs((candidate.position.y ?? 0) - (source.position.y ?? 0)) > 0.001
    || Math.abs(candidate.position.z + source.position.z) > 0.001) return false;
  if (kind === "asteroid" && candidate.asteroidId !== source.asteroidId) return false;
  if (kind === "prop" && candidate.propId !== source.propId) return false;
  if ((kind === "spawn" || kind === "flag") && candidate.team === source.team) return false;
  return true;
}

/**
 * Recover the mirror pairing of an arena that was authored elsewhere, so mirror
 * mode maintains the twins a shipped map already has rather than adding a
 * second copy of each.
 */
export function inferPairs(arena: ArenaConfig, pairs: PairMap): PairMap {
  for (const kind of PLACEMENT_KINDS) {
    const list = listFor(arena, kind) ?? [];
    const paired = pairs[kind];
    for (let index = 0; index < list.length; index++) {
      if (paired.has(index)) continue;
      const source = list[index]!;
      const twin = list.findIndex((candidate, other) => other !== index && !paired.has(other) && isTwinCandidate(kind, source, candidate));
      if (twin >= 0) { paired.set(index, twin); paired.set(twin, index); }
    }
  }
  return pairs;
}

/** Shift every surviving pair down past the removed indices. */
export function reindexPairs(pairs: Map<number, number>, removed: readonly number[]): Map<number, number> {
  const sorted = [...removed].sort((a, b) => a - b);
  const shifted = (value: number): number => value - sorted.filter((index) => index < value).length;
  const next = new Map<number, number>();
  for (const [a, b] of pairs) if (!removed.includes(a) && !removed.includes(b)) next.set(shifted(a), shifted(b));
  return next;
}

export function nextNodeId(arena: ArenaConfig): string {
  const ids = new Set(arena.navGraph?.nodes.map((node) => node.id) ?? []);
  let n = ids.size + 1;
  while (ids.has(`node-${n}`)) n++;
  return `node-${n}`;
}

/** A fresh spawn/flag id that does not collide with the ones already authored. */
export function nextPlacementId(items: ReadonlyArray<{ id: string }>, base: string): string {
  const ids = new Set(items.map((item) => item.id));
  let n = ids.size + 1;
  while (ids.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/** Translate snap: 1 world unit, matching the old gizmo `snapDistance`. */
export const TRANSLATE_SNAP = 1;
/** Rotate snap: 15°, matching the old gizmo `snapDistance` of PI/12. */
export const ROTATE_SNAP = Math.PI / 12;

export function snapPosition(position: { x: number; y: number; z: number }, snap: boolean): { x: number; y: number; z: number } {
  return {
    x: snap ? Math.round(position.x) : position.x,
    y: snap ? Math.round(position.y) : position.y,
    z: snap ? Math.round(position.z) : position.z,
  };
}

export function snapRotation(value: number, snap: boolean): number {
  return snap ? Math.round(value / ROTATE_SNAP) * ROTATE_SNAP : value;
}

/**
 * Placements carry ONE scale number, so a non-uniform gizmo drag has to be
 * collapsed. The average of the three axes is what the old tool wrote back, and
 * the caller then forces the marker itself uniform so the view agrees with disk.
 */
export function uniformScaleOf(x: number, y: number, z: number): number {
  return Math.max(0.01, (Math.abs(x) + Math.abs(y) + Math.abs(z)) / 3);
}

/** Trim Babylon's float32 round-trip noise before it reaches content JSON. */
export function roundPlacementValue(value: number): number { return Number(value.toFixed(4)); }

/**
 * Append a placement of `kind` to `arena` and return its index, or -1 when the
 * arena cannot hold one. Callers pass an already-cloned arena.
 */
export function appendPlacement(arena: ArenaConfig, kind: PlacementKind, placement: EditorPlacement): number {
  if (kind === "prop") arena.propPlacements ??= [];
  if (kind === "flag") arena.flagBases ??= [];
  if (kind === "nav") arena.navGraph ??= { nodes: [], links: [] };
  const list = listFor(arena, kind);
  if (!list) return -1;
  return list.push(placement) - 1;
}

/**
 * Remove `indices` from the kind's array, dropping any nav links that pointed at
 * a removed node. Indices are spliced high-to-low so earlier removals do not
 * shift the ones still to come.
 */
export function removePlacements(arena: ArenaConfig, kind: PlacementKind, indices: readonly number[]): void {
  const list = listFor(arena, kind);
  if (!list) return;
  const removedNavIds: string[] = [];
  for (const index of [...indices].sort((a, b) => b - a)) {
    const item = list[index];
    if (!item) continue;
    if (kind === "nav" && item.id) removedNavIds.push(item.id);
    list.splice(index, 1);
  }
  if (kind === "nav" && arena.navGraph) {
    arena.navGraph.links = arena.navGraph.links.filter(([a, b]) => !removedNavIds.includes(a) && !removedNavIds.includes(b));
  }
}

/**
 * Add or remove the link between two nav nodes (by array index), plus the
 * mirrored link when mirror mode has paired both endpoints. Toggling is
 * symmetric: if the primary link exists, both are removed.
 */
export function toggleNavLink(arena: ArenaConfig, selection: readonly number[], pairs: Map<number, number>, mirror: boolean): void {
  const graph = arena.navGraph;
  if (!graph || selection.length !== 2) return;
  const [ai, bi] = selection as [number, number];
  const a = graph.nodes[ai]?.id;
  const b = graph.nodes[bi]?.id;
  if (!a || !b) return;
  const links: Array<[string, string]> = [[a, b]];
  if (mirror) {
    const at = pairs.get(ai);
    const bt = pairs.get(bi);
    const ta = at === undefined ? undefined : graph.nodes[at]?.id;
    const tb = bt === undefined ? undefined : graph.nodes[bt]?.id;
    if (ta && tb && ta !== a && tb !== b) links.push([ta, tb]);
  }
  const linked = graph.links.some((link) => link.includes(a) && link.includes(b));
  if (linked) {
    graph.links = graph.links.filter((link) => !links.some(([x, y]) => link.includes(x) && link.includes(y)));
    return;
  }
  for (const pair of links) {
    if (!graph.links.some((link) => link.includes(pair[0]) && link.includes(pair[1]))) graph.links.push(pair);
  }
}

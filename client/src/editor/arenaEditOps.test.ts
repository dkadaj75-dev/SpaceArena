import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { arenaSchema, type ArenaConfig, type PropConfig } from "@space-arena/shared";
import {
  LAYERS, appendPlacement, defaultLayers, emptyPairs, governingLayer, inferPairs, isTwinCandidate,
  listFor, nextNodeId, nextPlacementId, reindexPairs, removePlacements, snapPosition, snapRotation,
  toggleNavLink, twinOf, uniformScaleOf,
} from "./arenaEditOps.js";

function repoFile(relative: string): string {
  for (const prefix of ["", "..", "../.."]) {
    const candidate = resolve(process.cwd(), prefix, relative);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`cannot locate ${relative} from ${process.cwd()}`);
}

function shippedArena(): ArenaConfig {
  return arenaSchema.parse(JSON.parse(readFileSync(repoFile("content/arenas/lunar-rift.json"), "utf8")));
}

function shippedProps(): Map<string, PropConfig> {
  const props = new Map<string, PropConfig>();
  for (const name of ["lunar-rift-chunk-0", "lunar-rift-boulder-a", "lunar-rift-beacon-blue"]) {
    const config = JSON.parse(readFileSync(repoFile(`content/props/${name}.json`), "utf8")) as PropConfig;
    props.set(config.id, config);
  }
  return props;
}

function arena(over: Partial<ArenaConfig> = {}): ArenaConfig {
  return {
    id: "arena.test", type: "arena", version: 1, name: "Test",
    bounds: { shape: "box", width: 200, height: 200, floorY: -20, ceilingY: 30 },
    asteroidPlacements: [],
    propPlacements: [],
    navGraph: { nodes: [], links: [] },
    spawnPoints: [{ id: "spawn-a", team: 0, position: { x: -10, y: 0, z: 0 }, heading: 0 }],
    flagBases: [],
    ...over,
  } as ArenaConfig;
}

describe("layer vocabulary", () => {
  it("keeps the Map tool's row order, and starts Terrain visible but LOCKED", () => {
    expect(LAYERS.map(([layer]) => layer)).toEqual(["asteroid", "prop", "terrain", "spawn", "flag", "nav", "bounds"]);
    const layers = defaultLayers();
    expect(layers.get("terrain")).toEqual({ visible: true, locked: true });
    for (const [layer] of LAYERS) {
      if (layer === "terrain") continue;
      // Stray clicks must never drag the floor — but nothing else is locked.
      expect(layers.get(layer)).toEqual({ visible: true, locked: false });
    }
  });

  it("routes terrain-category and hand-locked props to the Terrain pseudo-layer", () => {
    const draft = arena({
      propPlacements: [
        { propId: "prop.ground", position: { x: 0, z: 0 } },
        { propId: "prop.crate", position: { x: 4, z: 0 } },
        { propId: "prop.crate", position: { x: 8, z: 0 }, locked: true },
      ],
    });
    const isTerrain = (id: string): boolean => id === "prop.ground";
    expect(governingLayer(draft, "prop", 0, isTerrain)).toBe("terrain");
    expect(governingLayer(draft, "prop", 1, isTerrain)).toBe("prop");
    // A hand-locked ordinary prop answers to Terrain too.
    expect(governingLayer(draft, "prop", 2, isTerrain)).toBe("terrain");
    // Nothing but props has a pseudo-layer.
    expect(governingLayer(draft, "spawn", 0, isTerrain)).toBe("spawn");
  });
});

describe("mirror mode", () => {
  it("reflects position, spins a half turn and swaps the team with a fresh id", () => {
    const draft = arena({
      spawnPoints: [
        { id: "spawn-a", team: 0, position: { x: -10, y: 2, z: 4 }, heading: 0 },
      ],
    });
    const twin = twinOf("spawn", draft.spawnPoints[0]!, draft);
    expect(twin.position).toEqual({ x: 10, y: 2, z: -4 });
    expect(twin.heading).toBeCloseTo(Math.PI);
    expect(twin.team).toBe(1);
    expect(twin.id).toBe("spawn-a-mirror");
  });

  it("gives asteroids a scalar half turn and props an object one", () => {
    const draft = arena();
    const asteroid = twinOf("asteroid", { asteroidId: "a", position: { x: 3, z: 5 }, rotation: 0.5 }, draft);
    expect(asteroid.rotation).toBeCloseTo(0.5 + Math.PI);
    const prop = twinOf("prop", { propId: "p", position: { x: 3, z: 5 }, rotation: { x: 0.1, y: 0.2, z: 0.3 } }, draft);
    expect(prop.rotation).toMatchObject({ x: 0.1, z: 0.3 });
    expect((prop.rotation as { y: number }).y).toBeCloseTo(0.2 + Math.PI);
  });

  it("recognises an already-mirrored pair rather than adding a second copy", () => {
    const left = { propId: "p", position: { x: -8, y: 1, z: 3 } };
    expect(isTwinCandidate("prop", left, { propId: "p", position: { x: 8, y: 1, z: -3 } })).toBe(true);
    // Different prop, different altitude, or same team all disqualify.
    expect(isTwinCandidate("prop", left, { propId: "other", position: { x: 8, y: 1, z: -3 } })).toBe(false);
    expect(isTwinCandidate("prop", left, { propId: "p", position: { x: 8, y: 9, z: -3 } })).toBe(false);
    expect(isTwinCandidate("spawn", { position: { x: -8, z: 0 }, team: 0 }, { position: { x: 8, z: 0 }, team: 0 })).toBe(false);
  });

  it("infers the pairing of a shipped arena so mirror mode maintains it", () => {
    const shipped = shippedArena();
    const pairs = inferPairs(shipped, emptyPairs());
    // lunar-rift is a symmetric map: its two flag bases are each other's twin.
    expect(pairs.flag.get(0)).toBe(1);
    expect(pairs.flag.get(1)).toBe(0);
    // Every pairing is reciprocal, whatever the kind.
    for (const map of Object.values(pairs)) {
      for (const [a, b] of map) expect(map.get(b)).toBe(a);
    }
  });

  it("shifts surviving pairs down past a deleted index", () => {
    const pairs = new Map<number, number>([[0, 3], [3, 0], [1, 2], [2, 1]]);
    // Removing the 0/3 pair leaves 1↔2, which slide down to 0↔1.
    expect([...reindexPairs(pairs, [0, 3])]).toEqual([[0, 1], [1, 0]]);
  });
});

describe("snapping", () => {
  it("rounds to 1 unit and 15° only while snap is on", () => {
    expect(snapPosition({ x: 12.6, y: 124.9, z: -7.4 }, true)).toEqual({ x: 13, y: 125, z: -7 });
    expect(snapPosition({ x: 12.6, y: 124.9, z: -7.4 }, false)).toEqual({ x: 12.6, y: 124.9, z: -7.4 });
    expect(snapRotation(0.3, true)).toBeCloseTo(Math.PI / 12);
    expect(snapRotation(0.3, false)).toBe(0.3);
  });

  it("collapses a non-uniform gizmo drag to one positive scale number", () => {
    expect(uniformScaleOf(2, 2, 2)).toBe(2);
    expect(uniformScaleOf(1, 2, 3)).toBe(2);
    // Placement scale is `z.number().positive()` — a zeroed drag must not write 0.
    expect(uniformScaleOf(0, 0, 0)).toBe(0.01);
    expect(uniformScaleOf(-3, -3, -3)).toBe(3);
  });
});

describe("placement lists", () => {
  it("creates the optional arrays a shipped-lean arena omits", () => {
    const draft = arena({ propPlacements: undefined, flagBases: undefined, navGraph: undefined });
    expect(appendPlacement(draft, "prop", { propId: "p", position: { x: 0, z: 0 } })).toBe(0);
    expect(appendPlacement(draft, "flag", { id: "f", team: 0, position: { x: 0, z: 0 }, radius: 4 })).toBe(0);
    expect(appendPlacement(draft, "nav", { id: "node-1", position: { x: 0, z: 0 } })).toBe(0);
    expect(listFor(draft, "prop")).toHaveLength(1);
    expect(draft.navGraph!.nodes).toHaveLength(1);
  });

  it("deletes high-to-low and drops every nav link that pointed at a removed node", () => {
    const draft = arena({
      navGraph: {
        nodes: [
          { id: "node-1", position: { x: 0, z: 0 } },
          { id: "node-2", position: { x: 5, z: 0 } },
          { id: "node-3", position: { x: 10, z: 0 } },
        ],
        links: [["node-1", "node-2"], ["node-2", "node-3"]],
      },
    });
    removePlacements(draft, "nav", [0, 2]);
    expect(draft.navGraph!.nodes.map((node) => node.id)).toEqual(["node-2"]);
    expect(draft.navGraph!.links).toEqual([]);
  });

  it("mints ids that do not collide with what is already authored", () => {
    const draft = arena({ navGraph: { nodes: [{ id: "node-1", position: { x: 0, z: 0 } }], links: [] } });
    expect(nextNodeId(draft)).toBe("node-2");
    expect(nextPlacementId(draft.spawnPoints, "spawn")).toBe("spawn-2");
  });
});

describe("nav links", () => {
  const linked = (): ArenaConfig => arena({
    navGraph: {
      nodes: [
        { id: "a", position: { x: -5, z: 0 } }, { id: "b", position: { x: -5, z: 5 } },
        { id: "a2", position: { x: 5, z: 0 } }, { id: "b2", position: { x: 5, z: -5 } },
      ],
      links: [],
    },
  });

  it("links, then unlinks, the two selected nodes", () => {
    const draft = linked();
    toggleNavLink(draft, [0, 1], new Map(), false);
    expect(draft.navGraph!.links).toEqual([["a", "b"]]);
    toggleNavLink(draft, [0, 1], new Map(), false);
    expect(draft.navGraph!.links).toEqual([]);
  });

  it("mirrors the link onto the twin pair when mirror mode is on", () => {
    const draft = linked();
    const pairs = new Map<number, number>([[0, 2], [2, 0], [1, 3], [3, 1]]);
    toggleNavLink(draft, [0, 1], pairs, true);
    expect(draft.navGraph!.links).toEqual([["a", "b"], ["a2", "b2"]]);
    toggleNavLink(draft, [0, 1], pairs, true);
    expect(draft.navGraph!.links).toEqual([]);
  });
});

describe("against the shipped lunar-rift arena", () => {
  it("routes every locked placement to Terrain and leaves the rest selectable", () => {
    const shipped = shippedArena();
    const props = shippedProps();
    const isTerrain = (id: string): boolean => props.get(id)?.category === "terrain";
    const placements = shipped.propPlacements ?? [];
    expect(placements.length).toBe(129);

    const terrain = placements.filter((_, index) => governingLayer(shipped, "prop", index, isTerrain) === "terrain");
    // The 16 authored terrain chunks — the floor a stray click must never drag.
    expect(terrain).toHaveLength(16);
    expect(terrain.every((placement) => placement.locked)).toBe(true);
  });

  it("still parses after a mirrored placement round-trips through the ops", () => {
    const shipped = shippedArena();
    const source = shipped.propPlacements![0]!;
    const index = appendPlacement(shipped, "prop", twinOf("prop", source, shipped));
    expect(index).toBe(129);
    expect(arenaSchema.safeParse(shipped).success).toBe(true);
  });
});

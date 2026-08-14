import { describe, expect, it, beforeEach, vi } from "vitest";
import { ConfigService, EventBus, type ConfigEvents } from "@space-arena/shared";
import {
  arenaModelRenders,
  moduleModelRenders,
  preloadArenaModels,
  preloadMatchModels,
  preloadShipModels,
  shipModelRenders,
} from "./assetPreload.js";
import type { AssetRegistry } from "./AssetRegistry.js";

const SMALL_ROCK = {
  id: "asteroid.small-rock",
  type: "asteroid",
  version: 1,
  name: "Small Rock",
  radius: 3.5,
  hp: 40,
  destructible: true,
  impactDamage: 6,
  render: {
    recipe: "procedural.rock-small",
    palette: { primary: "#5b5148" },
    model: "asteroids/small_a.glb",
    modelScale: 3.5,
  },
  states: [
    { id: "intact" },
    { id: "destroyed", render: { recipe: "procedural.debris", model: "asteroids/debris.glb" } },
  ],
} satisfies Record<string, unknown>;

const SMALL_ROCK_B = {
  ...SMALL_ROCK,
  id: "asteroid.small-rock-b",
  name: "Small Rock B",
  render: { ...SMALL_ROCK.render, model: "asteroids/small_b.glb" },
  states: [{ id: "intact" }, { id: "destroyed", render: { recipe: "procedural.debris" } }],
} satisfies Record<string, unknown>;

/** Same gameplay stats, no model at all — the pre-model authoring style. */
const PROCEDURAL_ROCK = {
  ...SMALL_ROCK,
  id: "asteroid.plain",
  name: "Plain Rock",
  render: { recipe: "procedural.rock-small" },
  states: undefined,
} satisfies Record<string, unknown>;

const TERRAIN_PROP = {
  id: "prop.terrain",
  type: "prop",
  version: 1,
  name: "Terrain",
  category: "terrain",
  impactDamage: 0,
  render: {
    recipe: "model.static",
    model: "props/terrain.glb",
    lods: [
      { model: "props/terrain-lod1.glb", distance: 100 },
      { model: "props/terrain-lod2.glb", distance: 240 },
    ],
  },
} satisfies Record<string, unknown>;

function arena(asteroidIds: readonly string[]): Record<string, unknown> {
  return {
    id: "arena.test",
    type: "arena",
    version: 1,
    name: "Test Arena",
    bounds: { shape: "sphere", radius: 90 },
    asteroidPlacements: asteroidIds.map((asteroidId, i) => ({
      asteroidId,
      position: { x: i * 10, z: 0 },
    })),
    propPlacements: [],
    spawnPoints: [{ id: "sp-a", team: 0, position: { x: -20, z: 0 }, heading: 0 }],
    zones: [],
  };
}

describe("arenaModelRenders (per-arena GLB preloading)", () => {
  let configs: ConfigService;

  beforeEach(() => {
    const bus = new EventBus<ConfigEvents>();
    configs = new ConfigService(() => Promise.resolve(null), bus);
    for (const cfg of [SMALL_ROCK, SMALL_ROCK_B, PROCEDURAL_ROCK, TERRAIN_PROP]) {
      expect(configs.replace(cfg).ok).toBe(true);
    }
  });

  it("returns one entry per distinct model, however many times it is placed", () => {
    expect(configs.replace(arena(["asteroid.small-rock", "asteroid.small-rock", "asteroid.small-rock-b"])).ok).toBe(
      true,
    );
    const models = arenaModelRenders(configs, "arena.test").map((r) => r.model);
    // small_a once (placed twice), small_b once, plus small-rock's destroyed-state model.
    expect(models).toEqual(["asteroids/small_a.glb", "asteroids/debris.glb", "asteroids/small_b.glb"]);
  });

  it("carries the scale/yaw the registry keys its masters by", () => {
    expect(configs.replace(arena(["asteroid.small-rock"])).ok).toBe(true);
    const render = arenaModelRenders(configs, "arena.test")[0];
    expect(render?.modelScale).toBe(3.5);
  });

  it("skips asteroids that configure no model, so a procedural-only arena asks for nothing", () => {
    expect(configs.replace(arena(["asteroid.plain"])).ok).toBe(true);
    expect(arenaModelRenders(configs, "arena.test")).toEqual([]);
  });

  it("returns nothing for an arena the pack does not have", () => {
    expect(arenaModelRenders(configs, "arena.missing")).toEqual([]);
  });

  it("walks prop base and authored LOD models as unmerged preload variants", () => {
    expect(configs.replace({ ...arena([]), propPlacements: [{ propId: TERRAIN_PROP.id, position: { x: 0, z: 0 } }] }).ok).toBe(true);
    const renders = arenaModelRenders(configs, "arena.test");
    expect(renders.map((render) => render.model)).toEqual([
      "props/terrain.glb",
      "props/terrain-lod1.glb",
      "props/terrain-lod2.glb",
    ]);
    expect(renders.every((render) => render.mergeParts === false)).toBe(true);
  });

  it("waits for every distinct arena model before resolving", async () => {
    expect(configs.replace(arena(["asteroid.small-rock", "asteroid.small-rock-b"])).ok).toBe(true);
    const releases: Array<() => void> = [];
    const ensureModel = vi.fn(
      () => new Promise<null>((resolve) => releases.push(() => resolve(null))),
    );
    const assets = { ensureModel } as unknown as AssetRegistry;

    let settled = false;
    const preload = preloadArenaModels(assets, configs, "arena.test").then(() => {
      settled = true;
    });
    await Promise.resolve();

    // small_a, its authored destroyed state, and small_b are each loaded once.
    expect(ensureModel).toHaveBeenCalledTimes(3);
    expect(settled).toBe(false);
    releases[0]!();
    releases[1]!();
    await Promise.resolve();
    expect(settled).toBe(false);
    releases[2]!();
    await preload;
    expect(settled).toBe(true);
  });
});

describe("ship model preloading", () => {
  it("collects and awaits every ship model without consulting quality", async () => {
    const renders = [
      { recipe: "procedural.arrowhead", model: "ships/a.glb", lods: [
        { model: "ships/a-lod1.glb", distance: 40 },
        { model: "ships/a-lod2.glb", distance: 90 },
      ] },
      { recipe: "procedural.brawler" },
      { recipe: "procedural.support", model: "ships/c.glb" },
    ];
    const configs = {
      getAll: vi.fn(() => renders.map((render, i) => ({ id: `ship.${i}`, render }))),
    } as unknown as ConfigService;
    const ensureModel = vi.fn(async () => null);
    const assets = { ensureModel } as unknown as AssetRegistry;

    expect(shipModelRenders(configs).map((render) => render.model)).toEqual([
      "ships/a.glb", "ships/a-lod1.glb", "ships/a-lod2.glb", "ships/c.glb",
    ]);
    await preloadShipModels(assets, configs);
    expect(ensureModel).toHaveBeenCalledTimes(6);
    expect(ensureModel.mock.results.every((result) => result.type === "return")).toBe(true);
  });

  it("preloads match hulls, module cosmetics, asteroids, and arena prop LODs", async () => {
    const arenaConfig = {
      ...arena([SMALL_ROCK.id]),
      propPlacements: [{ propId: TERRAIN_PROP.id, position: { x: 0, z: 0 } }],
    };
    const ships = [{ id: "ship.one", render: { recipe: "ship", model: "ships/one.glb" } }];
    const modules = [{ id: "module.gun", render: { recipe: "module", model: "modules/gun.glb" } }];
    const configs = {
      get: vi.fn((type: string, id: string) => {
        if (type === "arena" && id === "arena.test") return arenaConfig;
        if (type === "asteroid" && id === SMALL_ROCK.id) return SMALL_ROCK;
        if (type === "prop" && id === TERRAIN_PROP.id) return TERRAIN_PROP;
        return undefined;
      }),
      getAll: vi.fn((type: string) => type === "ship" ? ships : type === "module" ? modules : []),
    } as unknown as ConfigService;
    const ensureModel = vi.fn(async (_render: { model?: string }) => null);
    const assets = { ensureModel } as unknown as AssetRegistry;

    expect(moduleModelRenders(configs).map((render) => render.model)).toEqual(["modules/gun.glb"]);
    await preloadMatchModels(assets, configs, "arena.test");

    expect(ensureModel.mock.calls.map(([render]) => render.model)).toEqual(expect.arrayContaining([
      "asteroids/small_a.glb",
      "asteroids/debris.glb",
      "props/terrain.glb",
      "props/terrain-lod1.glb",
      "props/terrain-lod2.glb",
      "ships/one.glb",
      "modules/gun.glb",
    ]));
  });

  it("reports monotonic load progress so the launch screen can show what is left", async () => {
    const arenaConfig = {
      ...arena([SMALL_ROCK.id]),
      propPlacements: [{ propId: TERRAIN_PROP.id, position: { x: 0, z: 0 } }],
    };
    const ships = [{ id: "ship.one", render: { recipe: "ship", model: "ships/one.glb" } }];
    const modules = [{ id: "module.gun", render: { recipe: "module", model: "modules/gun.glb" } }];
    const configs = {
      get: vi.fn((type: string, id: string) => {
        if (type === "arena" && id === "arena.test") return arenaConfig;
        if (type === "asteroid" && id === SMALL_ROCK.id) return SMALL_ROCK;
        if (type === "prop" && id === TERRAIN_PROP.id) return TERRAIN_PROP;
        return undefined;
      }),
      getAll: vi.fn((type: string) => (type === "ship" ? ships : type === "module" ? modules : [])),
    } as unknown as ConfigService;
    const assets = { ensureModel: vi.fn(async () => null) } as unknown as AssetRegistry;

    const seen: Array<[number, number]> = [];
    await preloadMatchModels(assets, configs, "arena.test", (loaded, total) => seen.push([loaded, total]));

    expect(seen[0]).toEqual([0, seen[0]![1]]);
    const total = seen[0]![1];
    expect(total).toBeGreaterThan(1);
    // One report per job, never going backwards, ending exactly at the total.
    expect(seen.map(([loaded]) => loaded)).toEqual([...Array(total + 1).keys()]);
    expect(seen.every(([, reported]) => reported === total)).toBe(true);
  });
});

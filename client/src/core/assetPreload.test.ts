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

const FIXTURE_ROCK_A = {
  id: "asteroid.fixture-rock-a",
  type: "asteroid",
  version: 1,
  name: "Fixture Rock A",
  radius: 3.5,
  hp: 40,
  destructible: true,
  impactDamage: 6,
  render: {
    recipe: "procedural.rock-small",
    palette: { primary: "#5b5148" },
    model: "fixtures/rock-a.glb",
    modelScale: 3.5,
  },
  states: [
    { id: "intact" },
    { id: "destroyed", render: { recipe: "procedural.debris", model: "fixtures/debris.glb" } },
  ],
} satisfies Record<string, unknown>;

const FIXTURE_ROCK_B = {
  ...FIXTURE_ROCK_A,
  id: "asteroid.fixture-rock-b",
  name: "Fixture Rock B",
  render: { ...FIXTURE_ROCK_A.render, model: "fixtures/rock-b.glb" },
  states: [{ id: "intact" }, { id: "destroyed", render: { recipe: "procedural.debris" } }],
} satisfies Record<string, unknown>;

/** Same gameplay stats, no model at all — the pre-model authoring style. */
const PROCEDURAL_ROCK = {
  ...FIXTURE_ROCK_A,
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
  };
}

describe("arenaModelRenders (per-arena GLB preloading)", () => {
  let configs: ConfigService;

  beforeEach(() => {
    const bus = new EventBus<ConfigEvents>();
    configs = new ConfigService(() => Promise.resolve(null), bus);
    for (const cfg of [FIXTURE_ROCK_A, FIXTURE_ROCK_B, PROCEDURAL_ROCK, TERRAIN_PROP]) {
      expect(configs.replace(cfg).ok).toBe(true);
    }
  });

  it("returns one entry per distinct model, however many times it is placed", () => {
    expect(configs.replace(arena(["asteroid.fixture-rock-a", "asteroid.fixture-rock-a", "asteroid.fixture-rock-b"])).ok).toBe(
      true,
    );
    const models = arenaModelRenders(configs, "arena.test").map((r) => r.model);
    // rock-a once (placed twice), rock-b once, plus rock-a's destroyed-state model.
    expect(models).toEqual(["fixtures/rock-a.glb", "fixtures/debris.glb", "fixtures/rock-b.glb"]);
  });

  it("carries the scale/yaw the registry keys its masters by", () => {
    expect(configs.replace(arena(["asteroid.fixture-rock-a"])).ok).toBe(true);
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
    expect(configs.replace(arena(["asteroid.fixture-rock-a", "asteroid.fixture-rock-b"])).ok).toBe(true);
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

    // rock-a, its authored destroyed state, and rock-b are each loaded once.
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
    // One request per authored GLB: the two hulls plus a.glb's two LOD levels.
    // The procedural ship asks for nothing.
    expect(ensureModel).toHaveBeenCalledTimes(4);
    expect(ensureModel.mock.results.every((result) => result.type === "return")).toBe(true);
  });

  it("preloads match hulls, module cosmetics, asteroids, and arena prop LODs", async () => {
    const arenaConfig = {
      ...arena([FIXTURE_ROCK_A.id]),
      propPlacements: [{ propId: TERRAIN_PROP.id, position: { x: 0, z: 0 } }],
    };
    const ships = [{ id: "ship.one", render: { recipe: "ship", model: "ships/one.glb" } }];
    const modules = [{ id: "module.gun", render: { recipe: "module", model: "modules/gun.glb" } }];
    const configs = {
      get: vi.fn((type: string, id: string) => {
        if (type === "arena" && id === "arena.test") return arenaConfig;
        if (type === "asteroid" && id === FIXTURE_ROCK_A.id) return FIXTURE_ROCK_A;
        if (type === "prop" && id === TERRAIN_PROP.id) return TERRAIN_PROP;
        return undefined;
      }),
      getAll: vi.fn((type: string) => type === "ship" ? ships : type === "module" ? modules : []),
    } as unknown as ConfigService;
    const ensureModel = vi.fn(async (_render: { model?: string }) => null);
    const assets = { ensureModel } as unknown as AssetRegistry;

    expect(moduleModelRenders(configs).map((render) => render.model)).toEqual(["modules/gun.glb"]);
    await preloadMatchModels(assets, configs, "arena.test").all;

    expect(ensureModel.mock.calls.map(([render]) => render.model)).toEqual(expect.arrayContaining([
      "fixtures/rock-a.glb",
      "fixtures/debris.glb",
      "props/terrain.glb",
      "props/terrain-lod1.glb",
      "props/terrain-lod2.glb",
      "ships/one.glb",
      "modules/gun.glb",
    ]));
  });

  it("reports monotonic load progress so the launch screen can show what is left", async () => {
    const arenaConfig = {
      ...arena([FIXTURE_ROCK_A.id]),
      propPlacements: [{ propId: TERRAIN_PROP.id, position: { x: 0, z: 0 } }],
    };
    const ships = [{ id: "ship.one", render: { recipe: "ship", model: "ships/one.glb" } }];
    const modules = [{ id: "module.gun", render: { recipe: "module", model: "modules/gun.glb" } }];
    const configs = {
      get: vi.fn((type: string, id: string) => {
        if (type === "arena" && id === "arena.test") return arenaConfig;
        if (type === "asteroid" && id === FIXTURE_ROCK_A.id) return FIXTURE_ROCK_A;
        if (type === "prop" && id === TERRAIN_PROP.id) return TERRAIN_PROP;
        return undefined;
      }),
      getAll: vi.fn((type: string) => (type === "ship" ? ships : type === "module" ? modules : [])),
    } as unknown as ConfigService;
    const assets = { ensureModel: vi.fn(async () => null) } as unknown as AssetRegistry;

    const seen: Array<[number, number]> = [];
    await preloadMatchModels(assets, configs, "arena.test", (loaded, total) => seen.push([loaded, total])).all;

    expect(seen[0]).toEqual([0, seen[0]![1]]);
    const total = seen[0]![1];
    expect(total).toBeGreaterThan(1);
    // One report per job, never going backwards, ending exactly at the total.
    expect(seen.map(([loaded]) => loaded)).toEqual([...Array(total + 1).keys()]);
    expect(seen.every(([, reported]) => reported === total)).toBe(true);
  });

  it("gates the launch on the seated hulls only, leaving the rest to land behind the match", async () => {
    const ships = [
      { id: "ship.seated", render: { recipe: "ship", model: "ships/seated.glb" } },
      { id: "ship.spare", render: { recipe: "ship", model: "ships/spare.glb" } },
    ];
    const configs = {
      // No arena in the pack, so the only jobs are the two hulls.
      get: vi.fn(() => undefined),
      getAll: vi.fn((type: string) => (type === "ship" ? ships : [])),
    } as unknown as ConfigService;
    const release = new Map<string, () => void>();
    const ensureModel = vi.fn(
      (render: { model?: string }) => new Promise<null>((resolve) => release.set(render.model!, () => resolve(null))),
    );
    const preload = preloadMatchModels({ ensureModel } as unknown as AssetRegistry, configs, "arena.missing");

    // Both hulls are in flight — the unseated one is loading, just not blocking.
    await Promise.resolve();
    expect([...release.keys()].sort()).toEqual(["ships/seated.glb", "ships/spare.glb"]);

    // Would hang (and time the test out) if the spare hull were in the gate.
    release.get("ships/seated.glb")!();
    await preload.ready(["ship.seated"]);

    let allSettled = false;
    void preload.all.then(() => {
      allSettled = true;
    });
    await Promise.resolve();
    expect(allSettled).toBe(false);
    release.get("ships/spare.glb")!();
    await preload.all;
  });

  it("blocks on every hull when the roster cannot name one, so a scripted spawn is never a stand-in", async () => {
    const ships = [{ id: "ship.one", render: { recipe: "ship", model: "ships/one.glb" } }];
    const configs = {
      get: vi.fn(() => undefined),
      getAll: vi.fn((type: string) => (type === "ship" ? ships : [])),
    } as unknown as ConfigService;
    const releases: Array<() => void> = [];
    const ensureModel = vi.fn(() => new Promise<null>((resolve) => releases.push(() => resolve(null))));
    const preload = preloadMatchModels({ ensureModel } as unknown as AssetRegistry, configs, "arena.missing");

    for (const seated of [undefined, [] as string[]]) {
      let ready = false;
      void preload.ready(seated).then(() => {
        ready = true;
      });
      await Promise.resolve();
      expect(ready).toBe(false);
    }
    releases[0]!();
    await preload.ready();
  });

  it("keeps the number of loads in flight bounded rather than opening one socket per model", async () => {
    const modules = Array.from({ length: 20 }, (_, i) => ({
      id: `module.${i}`,
      render: { recipe: "module", model: `modules/${i}.glb` },
    }));
    const configs = {
      get: vi.fn(() => undefined),
      getAll: vi.fn((type: string) => (type === "module" ? modules : [])),
    } as unknown as ConfigService;
    let inFlight = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const ensureModel = vi.fn(() => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      return new Promise<null>((resolve) => {
        releases.push(() => {
          inFlight--;
          resolve(null);
        });
      });
    });
    const preload = preloadMatchModels({ ensureModel } as unknown as AssetRegistry, configs, "arena.missing");

    // A pool, not a serial queue and not a twenty-wide burst.
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(6);

    // Each completion frees exactly one slot, so the whole list still drains.
    while (releases.length > 0) {
      releases.shift()!();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await preload.all;
    expect(ensureModel).toHaveBeenCalledTimes(20);
  });
});

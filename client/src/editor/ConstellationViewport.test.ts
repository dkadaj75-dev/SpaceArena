import { afterEach, describe, expect, it, vi } from "vitest";
import { ArcRotateCamera, NullEngine, Scene, Vector3 } from "@babylonjs/core";
import type { AnyConfig, ArenaConfig } from "@space-arena/shared";
import { ConstellationViewport, VIEWPORT_TYPES, boundsRadius, isViewportType, type ConstellationHost } from "./ConstellationViewport.js";

const engines: NullEngine[] = [];

function fakeHost(): { host: ConstellationHost; scene: Scene; calls: Record<string, ReturnType<typeof vi.fn>> } {
  const engine = new NullEngine();
  engines.push(engine);
  const scene = new Scene(engine);
  scene.activeCamera = new ArcRotateCamera("cam", 0, 1, 50, Vector3.Zero(), scene);
  const calls = {
    setGameVisible: vi.fn(),
    setArenaVisible: vi.fn(),
    pauseSim: vi.fn(),
    resumeSim: vi.fn(),
  };
  return { host: { scene, ...calls }, scene, calls };
}

function arena(over: Partial<ArenaConfig> = {}): ArenaConfig {
  return {
    id: "arena.test", type: "arena", version: 1, name: "Test",
    bounds: { shape: "sphere", radius: 120 },
    spawnPoints: [
      { id: "s1", team: 0, position: { x: -20, z: 0 }, heading: 0 },
      { id: "s2", team: 1, position: { x: 20, z: 0 }, heading: 0 },
    ],
    asteroidPlacements: [{ asteroidId: "asteroid.rock", position: { x: 5, z: 5 } }],
    propPlacements: [{ propId: "prop.crate", position: { x: -5, z: -5 } }],
    flagBases: [{ id: "b1", team: 0, position: { x: -30, z: 0 }, radius: 8 }],
    ...over,
  } as ArenaConfig;
}

/** Every mesh the viewport built, by name — its root is a dedicated TransformNode. */
function staged(scene: Scene): string[] {
  return scene.meshes.filter((mesh) => mesh.name.startsWith("constellation")).map((mesh) => mesh.name);
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const engine of engines.splice(0)) engine.dispose();
});

describe("viewport subject gate", () => {
  it("claims exactly the types with something to render", () => {
    expect([...VIEWPORT_TYPES].sort()).toEqual(["arena", "asteroid", "module", "prop", "ship"]);
    for (const type of VIEWPORT_TYPES) expect(isViewportType(type)).toBe(true);
    for (const type of ["tuning", "theme", "action", "manifest"]) expect(isViewportType(type)).toBe(false);
  });
});

describe("boundsRadius", () => {
  it("reads the half-span of every authored bounds shape", () => {
    expect(boundsRadius(arena())).toBe(120);
    expect(boundsRadius(arena({ bounds: { shape: "rect", width: 300, height: 200, verticalExtent: 60 } }))).toBe(150);
    expect(boundsRadius(arena({ bounds: { shape: "box", width: 100, height: 400, floorY: 0, ceilingY: 40 } }))).toBe(200);
  });
});

describe("ConstellationViewport", () => {
  it("takes the canvas on construction: sim paused, live match and arena hidden", () => {
    const { host, calls } = fakeHost();
    new ConstellationViewport(host);

    expect(calls.pauseSim).toHaveBeenCalled();
    expect(calls.setGameVisible).toHaveBeenCalledWith(false);
    expect(calls.setArenaVisible).toHaveBeenCalledWith(false);
  });

  it("stages an arena as bounds, spawn, flag and placement markers over the live arena", async () => {
    const { host, scene, calls } = fakeHost();
    const viewport = new ConstellationViewport(host);

    expect(await viewport.show(arena(), () => undefined)).toBe(true);

    const names = staged(scene);
    expect(names).toEqual(expect.arrayContaining([
      "constellation.spawn.s1", "constellation.spawn.s2",
      "constellation.flag.b1", "constellation.flagRing.b1",
      "constellation.asteroid.0", "constellation.prop.0",
      "constellation.bounds",
    ]));
    // Arena work wants the real arena behind it; a staged subject does not.
    expect(calls.setArenaVisible).toHaveBeenLastCalledWith(true);
    expect(viewport.status).toContain("2 spawns");
  });

  it("draws floor and ceiling loops for a boxed arena", async () => {
    const { host, scene } = fakeHost();
    const viewport = new ConstellationViewport(host);

    await viewport.show(arena({ bounds: { shape: "box", width: 100, height: 100, floorY: 0, ceilingY: 30 } }), () => undefined);

    expect(staged(scene)).toEqual(expect.arrayContaining(["constellation.bounds.floor", "constellation.bounds.ceiling"]));
  });

  it("replaces the previous subject rather than accumulating meshes", async () => {
    const { host, scene } = fakeHost();
    const viewport = new ConstellationViewport(host);

    await viewport.show(arena(), () => undefined);
    const first = staged(scene).length;
    await viewport.show(arena(), () => undefined);

    expect(staged(scene)).toHaveLength(first);
  });

  it("clears the stage and reports nothing for a type with no 3D subject", async () => {
    const { host, scene } = fakeHost();
    const viewport = new ConstellationViewport(host);
    await viewport.show(arena(), () => undefined);

    const tuning = { id: "tuning.default", type: "tuning", version: 1 } as unknown as AnyConfig;
    expect(await viewport.show(tuning, () => undefined)).toBe(false);

    expect(staged(scene)).toEqual([]);
    expect(viewport.status).toBe("");
  });

  it("hands the canvas back on dispose", async () => {
    const { host, scene, calls } = fakeHost();
    const viewport = new ConstellationViewport(host);
    await viewport.show(arena(), () => undefined);

    viewport.dispose();

    expect(staged(scene)).toEqual([]);
    expect(calls.setArenaVisible).toHaveBeenLastCalledWith(true);
    expect(calls.setGameVisible).toHaveBeenLastCalledWith(true);
    expect(calls.resumeSim).toHaveBeenCalled();
  });
});

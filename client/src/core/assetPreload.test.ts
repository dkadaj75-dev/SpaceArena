import { describe, expect, it, beforeEach } from "vitest";
import { ConfigService, EventBus, type ConfigEvents } from "@space-arena/shared";
import { arenaModelRenders } from "./assetPreload.js";

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
    spawnPoints: [{ id: "sp-a", team: 0, position: { x: -20, z: 0 }, heading: 0 }],
    zones: [],
  };
}

describe("arenaModelRenders (per-arena GLB preloading)", () => {
  let configs: ConfigService;

  beforeEach(() => {
    const bus = new EventBus<ConfigEvents>();
    configs = new ConfigService(() => Promise.resolve(null), bus);
    for (const cfg of [SMALL_ROCK, SMALL_ROCK_B, PROCEDURAL_ROCK]) {
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
});

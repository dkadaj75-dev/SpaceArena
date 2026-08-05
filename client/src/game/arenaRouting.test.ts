import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ConfigService,
  EventBus,
  type ArenaConfig,
  type ConfigEvents,
  type Snapshot,
  type ThemeConfig,
} from "@space-arena/shared";
import { GameSession } from "./GameSession.js";
import { Minimap } from "./hud/Minimap.js";
import { resolveHudLayout } from "./hud/hudLayout.js";

/**
 * Real content pack, loaded off disk. `shared`'s `loadTestConfigs` resolves it
 * from `import.meta.url`, which is not a file URL under the client's happy-dom
 * environment — so walk up from the cwd for the manifest instead.
 */
function contentDir(): string {
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    if (existsSync(path.join(dir, "content", "manifest.json"))) return path.join(dir, "content");
    dir = path.dirname(dir);
  }
  throw new Error(`content/manifest.json not found above ${process.cwd()}`);
}

async function loadContent(bus: EventBus<ConfigEvents>): Promise<ConfigService> {
  const dir = contentDir();
  const configs = new ConfigService((rel) => Promise.resolve(JSON.parse(readFileSync(path.join(dir, rel), "utf8"))), bus);
  const result = await configs.load("manifest.json");
  expect(result.ok, JSON.stringify(result.errors)).toBe(true);
  return configs;
}

/**
 * FLIGHT.md §6 — arena split-brain guard. The sim resolves the arena from the
 * gamemode/join options; the scene, the camera pan clamp and the minimap must all
 * follow THAT id. These tests use a second arena (different radius) so a
 * re-introduced `arena.ring-nebula` literal fails instead of accidentally passing.
 */
const SECOND_ARENA_ID = "arena.s0-routing-test";
/** Deliberately unlike ring-nebula's 90 (and small enough to dodge the draw clamp). */
const SECOND_ARENA_RADIUS = 50;

let configs: ConfigService;
let bus: EventBus<ConfigEvents>;
beforeAll(async () => {
  bus = new EventBus<ConfigEvents>();
  configs = await loadContent(bus);
  const source = configs.get<ArenaConfig>("arena", "arena.ring-nebula")!;
  const second = {
    ...source,
    id: SECOND_ARENA_ID,
    name: "S0 Routing Test",
    bounds: { shape: "sphere", radius: SECOND_ARENA_RADIUS },
    // The source arena's r≈78 spawns cannot be copied into an r50 test bubble.
    spawnPoints: source.spawnPoints.map((spawn) => ({
      ...spawn,
      position: {
        x: spawn.position.x * 0.5,
        y: (spawn.position.y ?? 0) * 0.5,
        z: spawn.position.z * 0.5,
      },
    })),
  };
  expect(configs.replace(second).ok).toBe(true);
});

describe("GameSession.arenaId", () => {
  it("reports the arena the sim actually resolved", () => {
    const session = new GameSession(configs, SECOND_ARENA_ID, "gamemode.practice-bots-1v1");
    expect(session.arenaId).toBe(SECOND_ARENA_ID);
    expect(session.sim.world.arena.bounds).toEqual({ shape: "sphere", radius: SECOND_ARENA_RADIUS });
  });
});

/**
 * Records every `arc` the minimap draws. happy-dom has no real 2D context, so the
 * prototype is patched for the duration of the test (restored by `restore()`).
 */
function stubCanvas(): { arcs: number[][]; ellipses: number[][]; restore: () => void } {
  const arcs: number[][] = [];
  const ellipses: number[][] = [];
  const ctx = {
    arc: (...args: number[]) => arcs.push(args),
    ellipse: (...args: number[]) => ellipses.push(args),
    setTransform: () => undefined,
    clearRect: () => undefined,
    beginPath: () => undefined,
    stroke: () => undefined,
    fill: () => undefined,
    save: () => undefined,
    restore: () => undefined,
    translate: () => undefined,
    rotate: () => undefined,
    moveTo: () => undefined,
    lineTo: () => undefined,
    closePath: () => undefined,
    strokeStyle: "",
    fillStyle: "",
    lineWidth: 0,
  };
  const proto = HTMLCanvasElement.prototype as unknown as { getContext: unknown };
  const original = proto.getContext;
  proto.getContext = () => ctx;
  return { arcs, ellipses, restore: () => (proto.getContext = original) };
}

const EMPTY_SNAPSHOT: Snapshot = {
  tick: 0,
  elapsed: 0,
  phase: "live",
  countdownRemaining: 0,
  teamScores: [],
  winnerTeam: null,
  ships: [],
  asteroids: [],
  projectiles: [],
  decoys: [],
      flags: [],
};

function bubbleRadiusOf(arenaId: string): number {
  const bounds = configs.get<ArenaConfig>("arena", arenaId)!.bounds;
  if (bounds.shape !== "sphere") throw new Error(`${arenaId} is not a spherical arena`);
  return bounds.radius;
}

describe("Minimap arena resolution", () => {
  const legacyLayout = () =>
    resolveHudLayout(
      { id: "theme.test", type: "theme", version: 1, colors: {}, hud: { minimapSizePx: 128 } } as ThemeConfig,
      { width: 128, height: 256 },
    );
  /**
   * The view range follows the SESSION's arena (the shipped theme deliberately
   * declares no `minimapRangeUnits`, so a radius-90 nebula and a radius-300 deep
   * field each fill the same dial). That makes the plotted position of a known
   * world point the discriminator: the top-down bubble silhouette alone clamps to the dial
   * edge on every arena and would pass against a hardcoded id.
   */
  function plotAsteroidAt(arenaId: string, worldZ: number): number {
    const { arcs, restore } = stubCanvas();
    const session = { arenaId, playerId: 1, playerTeam: 0 } as unknown as GameSession;
    const minimap = new Minimap(document.createElement("div"), configs, bus, session);
    minimap.applyLayout(legacyLayout());
    minimap.update(
      {
        ...EMPTY_SNAPSHOT,
        ships: [{
          id: 1,
          team: 0,
          pos: { x: 0, y: 0, z: 0 },
          heading: 0,
          pitch: 0,
          up: { x: 0, y: 1, z: 0 },
          hull: 100,
          hullMax: 100,
          energy: { cur: 100, max: 100 },
          heat: { cur: 0, capacity: 100 },
          targetId: null,
          throttle: 0,
          lockProgress: 0,
          locked: false,
          modules: [],
        }],
        asteroids: [{ id: 0, configId: "a", pos: { x: 0, y: 0, z: worldZ }, radius: 1, state: "intact" }],
      },
      200,
    );
    minimap.dispose();
    restore();
    expect(arcs.length).toBe(1); // the one asteroid; radar grid uses ellipses
    return arcs[0]![0]!; // asteroid centre x, in canvas px
  }

  it("scales the view to the session's arena, not a hardcoded one", () => {
    const theme = configs.get<ThemeConfig>("theme", "theme.default");
    const half = (theme?.hud?.minimapSizePx ?? 128) / 2;
    expect(theme?.hud?.minimapRangeUnits).toBeUndefined(); // else this proves nothing

    const radarRadius = (theme?.hud?.minimapSizePx ?? 128) * 0.43;
    const scale = radarRadius / SECOND_ARENA_RADIUS;
    // Heading zero faces +X, so world -Z is screen-right on the ship-relative radar.
    expect(plotAsteroidAt(SECOND_ARENA_ID, -25)).toBeCloseTo(half + 25 * scale, 6);
    // Guard: the old hardcoded arena has a different radius, hence a different
    // scale, hence a visibly different dot position for the same world point.
    expect(plotAsteroidAt("arena.ring-nebula", -25)).toBeCloseTo(
      half + 25 * (radarRadius / bubbleRadiusOf("arena.ring-nebula")),
      6,
    );
    expect(plotAsteroidAt(SECOND_ARENA_ID, -25)).not.toBeCloseTo(plotAsteroidAt("arena.ring-nebula", -25), 3);
  });

  it("draws a tilted three-ring sensor disc even before contacts arrive", () => {
    const { ellipses, restore } = stubCanvas();
    const session = { arenaId: SECOND_ARENA_ID, playerId: 1, playerTeam: 0 } as unknown as GameSession;
    const minimap = new Minimap(document.createElement("div"), configs, bus, session);
    minimap.applyLayout(legacyLayout());
    minimap.update(EMPTY_SNAPSHOT, 200);

    const half = (configs.get<ThemeConfig>("theme", "theme.default")?.hud?.minimapSizePx ?? 128) / 2;
    expect(ellipses.length).toBe(3);
    expect(ellipses[0]![0]).toBe(half);
    expect(ellipses[0]![1]).toBeCloseTo((half * 2) * 0.54, 6);
    expect(ellipses[0]![2]).toBeGreaterThan(ellipses[0]![3]!);

    minimap.dispose();
    restore();
  });
});

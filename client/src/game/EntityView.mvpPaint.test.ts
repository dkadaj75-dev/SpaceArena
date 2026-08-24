import { NullEngine, Scene } from "@babylonjs/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConfigService, ShipConfig, Snapshot } from "@space-arena/shared";
import { COSMETICS } from "./__fixtures__/shopContent.js";
import { ViewManager } from "./EntityView.js";

/**
 * The MVP beauty shot wears the paint that pilot actually flew (owner
 * 2026-08-22). It used to instance the RAW authored master, so the results
 * screen showed a default hull for a player who had a skin equipped all match —
 * and it did so for the LOCAL player too, whose cosmetic the client has known
 * since spawn.
 *
 * Assertion shape: the hero must instance from the SAME painted master the
 * in-match hull did. That is the whole contract (§5) — one master per
 * (hull, cosmetic), shared by every view — and it survives any change to how a
 * paint is actually applied to that master.
 */

const HULL: ShipConfig = {
  id: "ship.interceptor",
  type: "ship",
  version: 1,
  name: "Interceptor",
  class: "light",
  render: { recipe: "procedural.arrowhead" },
  collider: { shape: "circle", radius: 1 },
  sockets: [],
  // Wired so a paint has a surface to change; an unwired hull would legitimately
  // resolve back to the base master and the test would pass for the wrong reason.
  skin: { body: ["SHELL"], wings: ["WING"] },
} as unknown as ShipConfig;

const CONFIGS = {
  get: (type: string, id: string) => {
    if (type === "ship" && id === HULL.id) return HULL;
    if (type === "cosmetic") return COSMETICS.find((c) => c.id === id);
    return undefined;
  },
  getAll: (type: string) => {
    if (type === "tuning") return [{ projectilePoolSize: 1, beamFadeMs: 120 }];
    // `cosmeticById` reads the whole catalogue, not `get` — the paint bank is
    // unreachable without this.
    if (type === "cosmetic") return COSMETICS;
    return [];
  },
} as unknown as ConfigService;

const QUALITY = {
  projectiles: { useInstances: true },
  particles: { enabled: false, budgetMultiplier: 0, maxEmitterCapacity: 0 },
  asteroids: { lodMediumDistance: 0, lodLowDistance: 0, lodCullDistance: 0 },
};

const MVP_ID = 7;

function snapshot(cosmeticId: string | null, ships = true): Snapshot {
  return {
    tick: 1,
    elapsed: 1,
    phase: ships ? "live" : "ended",
    countdownRemaining: 0,
    teamScores: [],
    winnerTeam: null,
    ships: ships
      ? [{
          id: MVP_ID,
          team: 0,
          pos: { x: 0, y: 0, z: 0 },
          heading: 0,
          pitch: 0,
          up: { x: 0, y: 1, z: 0 },
          hull: 1,
          hullMax: 1,
          targetId: null,
          throttle: 0,
          lockProgress: 0,
          locked: false,
          cosmeticId,
          modules: [],
        }]
      : [],
    asteroids: [],
    projectiles: [],
    decoys: [],
    flags: [],
  } as unknown as Snapshot;
}

let engine: NullEngine;
let scene: Scene;
let view: ViewManager;

beforeEach(() => {
  engine = new NullEngine();
  scene = new Scene(engine);
  view = new ViewManager(scene, CONFIGS, () => HULL.id, QUALITY);
});

afterEach(() => {
  view.dispose();
  scene.dispose();
  engine.dispose();
});

/** The master an instance was created from, by name. */
function sourceNameOf(name: string): string | undefined {
  const mesh = scene.meshes.find((m) => m.name === name);
  return (mesh as { sourceMesh?: { name: string } } | undefined)?.sourceMesh?.name;
}

describe("MVP showcase paint", () => {
  it("stages the hero in the paint the MVP flew, not the authored hull", () => {
    const live = snapshot("cosmetic.paint-interceptor-crimson");
    view.render(live, live, 1, 16);
    const matchMaster = sourceNameOf(`ship.${MVP_ID}`);
    expect(matchMaster).toContain("paint.cosmetic.paint-interceptor-crimson");

    expect(view.showMvp(MVP_ID)).toBe(true);
    expect(sourceNameOf("mvp.hero")).toBe(matchMaster);
  });

  it("still knows the paint after the MVP's ship has left the board", () => {
    // The showcase is staged on `phase: "ended"`, by which point a winner who
    // died on the last exchange has no ship view left to read a cosmetic off.
    const live = snapshot("cosmetic.paint-interceptor-crimson");
    view.render(live, live, 1, 16);
    const matchMaster = sourceNameOf(`ship.${MVP_ID}`);

    const over = snapshot(null, false);
    view.render(over, over, 1, 16);
    expect(scene.meshes.some((m) => m.name === `ship.${MVP_ID}`)).toBe(false);

    expect(view.showMvp(MVP_ID)).toBe(true);
    expect(sourceNameOf("mvp.hero")).toBe(matchMaster);
  });

  it("keeps the authored look for a pilot flying no paint at all", () => {
    const live = snapshot(null);
    view.render(live, live, 1, 16);
    const matchMaster = sourceNameOf(`ship.${MVP_ID}`);
    expect(matchMaster).not.toContain("paint.");

    expect(view.showMvp(MVP_ID)).toBe(true);
    expect(sourceNameOf("mvp.hero")).toBe(matchMaster);
  });
});

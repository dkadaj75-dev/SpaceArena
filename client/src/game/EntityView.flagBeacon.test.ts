import { NullEngine, Scene, StandardMaterial } from "@babylonjs/core";
import { describe, expect, it } from "vitest";
import type { ConfigService, FlagSnapshot, Snapshot } from "@space-arena/shared";
import { ViewManager } from "./EntityView.js";
import { BEACON_DEFAULT_RADIUS } from "./flagBeacon.js";

const configs = {
  get: () => undefined,
  getAll: (type: string) => (type === "tuning" ? [{ projectilePoolSize: 1, beamFadeMs: 120 }] : []),
} as unknown as ConfigService;

function flag(id: number, over: Partial<FlagSnapshot> = {}): FlagSnapshot {
  return {
    id,
    team: 0,
    state: "home",
    carrierId: null,
    pos: { x: 0, y: 0, z: 0 },
    home: { x: -72, y: 3, z: 40 },
    baseRadius: 16,
    dropRemaining: 0,
    trail: [],
    ...over,
  };
}

function snapshot(flags: FlagSnapshot[]): Snapshot {
  return {
    tick: 1,
    elapsed: 1,
    phase: "live",
    countdownRemaining: 0,
    teamScores: [],
    winnerTeam: null,
    ships: [],
    asteroids: [],
    projectiles: [],
    decoys: [],
    flags,
  } satisfies Snapshot;
}

function makeView(): { scene: Scene; engine: NullEngine; view: ViewManager } {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const view = new ViewManager(scene, configs, () => undefined, {
    projectiles: { useInstances: true },
    particles: { enabled: false, budgetMultiplier: 0, maxEmitterCapacity: 0 },
    asteroids: { lodMediumDistance: 0, lodLowDistance: 0, lodCullDistance: 0, thinInstances: false },
  });
  return { scene, engine, view };
}

const beaconsIn = (scene: Scene) => scene.meshes.filter((m) => m.name.startsWith("flagBeacon."));
const beaconMatsIn = (scene: Scene) =>
  scene.materials.filter((m) => m.name.startsWith("mat.flagBeacon."));

describe("flag base beacons (owner 2026-08-01)", () => {
  it("stands one translucent shell on each base, sized by the capture radius", () => {
    const { scene, engine, view } = makeView();
    view.render(snapshot([flag(1)]), snapshot([flag(1)]), 1, 16);

    const beacons = beaconsIn(scene);
    expect(beacons).toHaveLength(1);
    const beacon = beacons[0]!;
    // On the BASE, not on the flag.
    expect(beacon.position.asArray()).toEqual([-72, 3, 40]);
    expect(beacon.isPickable).toBe(false);
    const mat = beacon.material as StandardMaterial;
    expect(mat.alpha).toBeGreaterThan(0);
    expect(mat.alpha).toBeLessThan(1);
    expect(mat.disableDepthWrite).toBe(true);
    expect(mat.emissiveFresnelParameters?.isEnabled).toBe(true);
    // Radius 16 ⇒ a 32-wide shell, and the pulse only nudges it.
    expect(beacon.getBoundingInfo().boundingBox.extendSize.x).toBeCloseTo(16, 3);
    expect(Math.abs(beacon.scaling.x - 1)).toBeLessThan(0.1);

    view.dispose();
    scene.dispose();
    engine.dispose();
  });

  it("still shows a beacon when the base authored no radius", () => {
    const { scene, engine, view } = makeView();
    const snap = snapshot([flag(2, { baseRadius: 0 })]);
    view.render(snap, snap, 1, 16);

    const beacon = beaconsIn(scene)[0]!;
    expect(beacon.getBoundingInfo().boundingBox.extendSize.x).toBeCloseTo(BEACON_DEFAULT_RADIUS, 3);

    view.dispose();
    scene.dispose();
    engine.dispose();
  });

  it("marks the base whatever the flag is doing, and breathes off the clock", () => {
    const { scene, engine, view } = makeView();
    const home = snapshot([flag(3)]);
    view.render(home, home, 1, 16);
    const beacon = beaconsIn(scene)[0]!;
    const mat = beacon.material as StandardMaterial;
    const firstScale = beacon.scaling.x;

    // A carried flag is far from home; the beacon does not follow it.
    const carried = snapshot([
      flag(3, { state: "carried", carrierId: 9, pos: { x: 500, y: 0, z: 500 } }),
    ]);
    view.render(carried, carried, 1, 850);
    expect(beaconsIn(scene)).toHaveLength(1);
    expect(beacon.position.asArray()).toEqual([-72, 3, 40]);
    // A quarter of a breath later it has visibly moved, but only just.
    expect(beacon.scaling.x).not.toBeCloseTo(firstScale, 4);
    expect(Math.abs(beacon.scaling.x - 1)).toBeLessThan(0.1);
    expect(mat.alpha).toBeGreaterThan(0.1);
    expect(mat.alpha).toBeLessThan(0.5);

    view.dispose();
    scene.dispose();
    engine.dispose();
  });

  it("takes the beacon and its material with the flag when the mode changes", () => {
    const { scene, engine, view } = makeView();
    const withFlags = snapshot([flag(4), flag(5, { team: 1 })]);
    view.render(withFlags, withFlags, 1, 16);
    expect(beaconsIn(scene)).toHaveLength(2);
    expect(beaconMatsIn(scene)).toHaveLength(2);
    const meshes = beaconsIn(scene);
    const mats = beaconMatsIn(scene);

    const empty = snapshot([]);
    view.render(empty, empty, 1, 16);
    expect(beaconsIn(scene)).toHaveLength(0);
    expect(beaconMatsIn(scene)).toHaveLength(0);
    expect(meshes.every((m) => m.isDisposed())).toBe(true);
    expect(mats).toHaveLength(2); // …and they left `scene.materials` above.

    view.dispose();
    scene.dispose();
    engine.dispose();
  });

  it("disposes beacons with the view itself", () => {
    const { scene, engine, view } = makeView();
    const snap = snapshot([flag(6)]);
    view.render(snap, snap, 1, 16);
    const beacon = beaconsIn(scene)[0]!;

    view.dispose();
    expect(beacon.isDisposed()).toBe(true);
    expect(beaconMatsIn(scene)).toHaveLength(0);

    scene.dispose();
    engine.dispose();
  });
});

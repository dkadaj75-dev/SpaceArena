import { FreeCamera, NullEngine, Scene, StandardMaterial, Vector3, VertexBuffer } from "@babylonjs/core";
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
    asteroids: { lodMediumDistance: 0, lodLowDistance: 0, lodCullDistance: 0 },
  });
  return { scene, engine, view };
}

const beaconsIn = (scene: Scene) => scene.meshes.filter((m) => m.name.startsWith("flagBeacon."));
const beaconMatsIn = (scene: Scene) =>
  scene.materials.filter((m) => m.name.startsWith("mat.flagBeacon."));
const flagBannersIn = (scene: Scene) => scene.meshes.filter((m) => m.name.startsWith("flagBanner."));
const flagMatsIn = (scene: Scene) => scene.materials.filter((m) => m.name.startsWith("mat.flag"));

describe("flag base beacons (owner 2026-08-01)", () => {
  it("draws each team as a real pole-mounted blue/red waving banner", () => {
    const { scene, engine, view } = makeView();
    const snap = snapshot([flag(11), flag(12, { team: 1 })]);
    view.render(snap, snap, 1, 16);

    const banners = flagBannersIn(scene);
    expect(banners).toHaveLength(2);
    expect(scene.meshes.filter((m) => m.name.startsWith("flagPole."))).toHaveLength(2);
    expect(scene.meshes.filter((m) => m.name.startsWith("flagStand."))).toHaveLength(2);
    const blue = banners[0]!.material as StandardMaterial;
    const red = banners[1]!.material as StandardMaterial;
    expect(blue.emissiveColor.b).toBeGreaterThan(blue.emissiveColor.r);
    expect(red.emissiveColor.r).toBeGreaterThan(red.emissiveColor.b);
    expect(blue.backFaceCulling).toBe(false);

    const before = Array.from(banners[0]!.getVerticesData(VertexBuffer.PositionKind)!);
    view.render(snap, snap, 2, 40);
    const after = Array.from(banners[0]!.getVerticesData(VertexBuffer.PositionKind)!);
    expect(after).not.toEqual(before);

    view.dispose();
    scene.dispose();
    engine.dispose();
  });

  it("poses the flag upright at home, compact when carried, and tilted when dropped", () => {
    const { scene, engine, view } = makeView();
    const home = snapshot([flag(13)]);
    view.render(home, home, 1, 16);
    const root = scene.transformNodes.find((n) => n.name === "flag.13")!;
    const stand = scene.meshes.find((m) => m.name === "flagStand.13")!;
    expect(root.rotation.z).toBe(0);
    expect(stand.isEnabled()).toBe(true);

    const carried = snapshot([flag(13, { state: "carried", carrierId: 4 })]);
    view.render(carried, carried, 2, 1000);
    expect(root.scaling.x).toBeCloseTo(0.68, 2);
    expect(root.position.y).toBeCloseTo(3.6, 4);
    expect(stand.isEnabled()).toBe(false);

    const dropped = snapshot([flag(13, { state: "dropped", pos: { x: 7, y: 2, z: 3 } })]);
    view.render(dropped, dropped, 3, 1000);
    expect(root.rotation.z).toBeCloseTo(1.08, 2);
    expect(root.position.asArray()).toEqual([7, 2, 3]);

    view.dispose();
    scene.dispose();
    engine.dispose();
  });

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
    expect(beacon.getTotalIndices() / 3).toBeLessThanOrEqual(576);

    view.dispose();
    scene.dispose();
    engine.dispose();
  });

  it("culls the Medium beacon shell beyond 180 units but preserves the near landmark", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const camera = new FreeCamera("beacon.camera", new Vector3(-72, 3, 260), scene);
    camera.setTarget(new Vector3(-72, 3, 40));
    camera.computeWorldMatrix();
    scene.activeCamera = camera;
    const view = new ViewManager(scene, configs, () => undefined, {
      projectiles: { useInstances: true },
      particles: { enabled: false, budgetMultiplier: 0, maxEmitterCapacity: 0 },
      asteroids: { lodMediumDistance: 0, lodLowDistance: 0, lodCullDistance: 0 },
      scene: { skyboxEnabled: true, boundaryShieldShader: false, starfieldPoints: 0, spawnMarkers: false, transparentShellCullDistance: 180 },
    });
    const snap = snapshot([flag(21)]);
    view.render(snap, snap, 1, 16);
    const beacon = beaconsIn(scene)[0]!;
    expect(beacon.isEnabled()).toBe(false);

    camera.position.set(-72, 3, 100);
    camera.computeWorldMatrix();
    view.render(snap, snap, 1, 16);
    expect(beacon.isEnabled()).toBe(true);
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

  it("disposes every physical-flag material when a flag leaves the match", () => {
    const { scene, engine, view } = makeView();
    const withFlag = snapshot([flag(14)]);
    view.render(withFlag, withFlag, 1, 16);
    expect(flagMatsIn(scene)).toHaveLength(3); // pole, banner, base beacon

    const empty = snapshot([]);
    view.render(empty, empty, 2, 16);
    expect(flagBannersIn(scene)).toHaveLength(0);
    expect(flagMatsIn(scene)).toHaveLength(0);

    view.dispose();
    scene.dispose();
    engine.dispose();
  });
});

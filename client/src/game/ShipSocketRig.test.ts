import { FreeCamera, MeshBuilder, NullEngine, Scene, TransformNode, Vector3 } from "@babylonjs/core";
import { afterEach, describe, expect, it } from "vitest";
import type { ConfigService, EffectConfig, ModuleConfig, ShipConfig, ShipSnapshot } from "@space-arena/shared";
import { AssetRegistry } from "../core/AssetRegistry.js";
import { ShipSocketRig, shouldBuildShipEmitter } from "./ShipSocketRig.js";

const MODULES: ModuleConfig[] = [
  moduleConfig("module.laser", "laser"),
  moduleConfig("module.shield", "shield"),
];

function moduleConfig(id: string, family: ModuleConfig["family"]): ModuleConfig {
  return {
    id,
    type: "module",
    version: 1,
    name: id,
    family,
    level: 1,
    activation: { deployTime: 0, retractTime: 0 },
    heat: { capacity: 1, coolingPerSec: 1, perSecondActive: 0, perShot: 6, rearmBelow: 0.25 },
    ui: { icon: family, label: family },
    price: 0,
    requiresLevel: 1,
  };
}

const SHIP = {
  id: "ship.mount-test",
  type: "ship",
  version: 1,
  name: "Mount Test",
  class: "test",
  core: {
    hull: { base: 1, resists: { kinetic: 0, energy: 0 } },
    engine: { nominalSpeed: 1, accel: 1, turnRate: 1 },
    power: { capacity: 15 },
    efficiency: { energyDraw: 1, heatGen: 1 },
    cooling: { multiplier: 1 },
    recharge: { multiplier: 1 },
    heatStore: { multiplier: 1 },
    energyStore: { multiplier: 1 },
    sensors: { lockRange: 1, lockTimeSec: 1, coneDeg: 1 },
  },
  upgradeTracks: { hull: "u.h", engine: "u.e", energy: "u.c", heat: "u.t" },
  sockets: [
    {
      id: "left",
      kind: "hardpoint",
      accepts: ["laser"],
      transform: { pos: [1.25, -0.5, 2.75], rot: [0.1, 0.2, 0.3], scale: 1.4 },
    },
    {
      id: "trail",
      kind: "emitter",
      effect: "fx.none",
      bindings: [],
      transform: { pos: [0, 0, -2] },
    },
    {
      id: "right",
      kind: "hardpoint",
      accepts: ["shield"],
      transform: { pos: [-1.5, 0.25, 1], rot: [-0.2, 0.4, -0.1], scale: 0.65 },
    },
  ],
  defaultFitting: ["module.laser", "module.shield"],
  render: { recipe: "procedural.arrowhead" },
  collider: { shape: "circle", radius: 1 },
} satisfies ShipConfig;

const engines: NullEngine[] = [];

afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
});

describe("ShipSocketRig fitted module mounts", () => {
  it("mounts one non-pickable module per hardpoint at the exact local socket transform", () => {
    const engine = new NullEngine();
    engines.push(engine);
    const scene = new Scene(engine);
    const parent = new TransformNode("ship", scene);
    const configs = {
      get: (_type: string, id: string) => MODULES.find((module) => module.id === id),
    } as unknown as ConfigService;
    const assets = new AssetRegistry(scene);
    const rig = new ShipSocketRig(
      scene,
      configs,
      assets,
      SHIP,
      parent,
      SHIP.defaultFitting,
      { enabled: false, budgetMultiplier: 0, maxEmitterCapacity: 0 },
    );

    const mounts = scene.transformNodes
      .filter((node) => node.name.startsWith("hp.ship.mount-test."))
      .sort((a, b) => a.name.localeCompare(b.name));
    expect(mounts).toHaveLength(2);
    expect(mounts[0]!.name).toContain("left");
    expect(mounts[0]!.position.asArray()).toEqual([1.25, -0.5, 2.75]);
    expect(mounts[0]!.rotation.asArray()).toEqual([0.1, 0.2, 0.3]);
    expect(mounts[0]!.scaling.asArray()).toEqual([1.4, 1.4, 1.4]);
    expect(mounts[1]!.name).toContain("right");
    expect(mounts[1]!.position.asArray()).toEqual([-1.5, 0.25, 1]);
    expect(mounts[1]!.rotation.asArray()).toEqual([-0.2, 0.4, -0.1]);
    expect(mounts[1]!.scaling.asArray()).toEqual([0.65, 0.65, 0.65]);

    const moduleMeshes = scene.meshes.filter((mesh) => mesh.name.startsWith("hpmesh."));
    expect(moduleMeshes).toHaveLength(2);
    expect(moduleMeshes.every((mesh) => !mesh.isPickable)).toBe(true);

    rig.dispose();
    expect(mounts.every((node) => node.isDisposed())).toBe(true);
    expect(moduleMeshes.every((mesh) => mesh.isDisposed())).toBe(true);
    assets.dispose();
    scene.dispose();
  });
});

describe("ship effect budget decisions", () => {
  it("builds dormant zero-rate systems in the stopped state", () => {
    const engine = new NullEngine();
    engines.push(engine);
    const scene = new Scene(engine);
    const camera = new FreeCamera("camera", new Vector3(0, 0, -10), scene);
    camera.setTarget(Vector3.Zero());
    scene.activeCamera = camera;
    const parent = MeshBuilder.CreateBox("ship", { size: 1 }, scene);
    const effect = {
      id: "fx.none", type: "effect", version: 1, name: "None",
      base: { capacity: 10, emitRate: 0, lifeMin: 0.1, lifeMax: 0.2, sizeMin: 0.1, sizeMax: 0.2, speedMin: 1, speedMax: 2, color1: "#ffffff", color2: "#ffffff" },
      params: ["emitRate"],
    } satisfies EffectConfig;
    const configs = { get: (type: string) => type === "effect" ? effect : undefined } as unknown as ConfigService;
    const rig = new ShipSocketRig(scene, configs, new AssetRegistry(scene), SHIP, parent, [], {
      enabled: true, budgetMultiplier: 0.35, maxEmitterCapacity: 40, shipEffectCullDistance: 180,
    });
    rig.updateEmitters({ modules: [] } as unknown as ShipSnapshot, undefined, 100);
    expect(scene.particleSystems).toHaveLength(1);
    expect(scene.particleSystems[0]!.emitRate).toBe(0);
    expect(scene.particleSystems[0]!.isStarted()).toBe(false);
    rig.dispose();
    scene.dispose();
  });

  it("keeps all local systems but caps each Low/Medium remote ship to its primary thruster", () => {
    const kept = (isLocal: boolean, emitterIndex: number) => shouldBuildShipEmitter({
      isLocal,
      emitterIndex,
      primaryEmitterIndex: 0,
      maxRemoteShipSystems: 1,
      distance: 80,
      cullDistance: 180,
      inFrustum: true,
    });
    expect([0, 1, 2, 3].filter((i) => kept(true, i))).toHaveLength(4);
    expect([0, 1, 2, 3].filter((i) => kept(false, i))).toEqual([0]);
    // One four-socket local hull plus nine capped remotes.
    expect(4 + 9 * 1).toBe(13);
  });

  it("rejects offscreen and beyond-threshold systems", () => {
    const base = {
      isLocal: false,
      emitterIndex: 0,
      primaryEmitterIndex: 0,
      maxRemoteShipSystems: 1,
      cullDistance: 180,
    };
    expect(shouldBuildShipEmitter({ ...base, distance: 181, inFrustum: true })).toBe(false);
    expect(shouldBuildShipEmitter({ ...base, distance: 20, inFrustum: false })).toBe(false);
  });
});

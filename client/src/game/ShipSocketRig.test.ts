import { NullEngine, Scene, TransformNode } from "@babylonjs/core";
import { afterEach, describe, expect, it } from "vitest";
import type { ConfigService, ModuleConfig, ShipConfig } from "@space-arena/shared";
import { AssetRegistry } from "../core/AssetRegistry.js";
import { ShipSocketRig } from "./ShipSocketRig.js";

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
    energy: { drawIdle: 0, drawActive: 0 },
    heat: { perSecondActive: 0, overheatThreshold: 1, overheatCooldown: 0, overheatSelfDamage: 0 },
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
    energy: { capacitor: 1, regen: 0 },
    heat: { capacity: 1, dissipation: 0, criticalDamagePerSec: 0 },
    power: { capacity: 15 },
    efficiency: { energyDraw: 1, heatGen: 1 },
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

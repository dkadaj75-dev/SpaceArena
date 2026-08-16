import { NullEngine, Scene } from "@babylonjs/core";
import { describe, expect, it } from "vitest";
import type { ConfigService, ModuleConfig, ShipConfig, Snapshot } from "@space-arena/shared";
import { ViewManager } from "./EntityView.js";

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

describe("EntityView fitted module integration", () => {
  it("creates one exact socket mount per fitted hardpoint and disposes them with the view", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const modules = [moduleConfig("module.a", "laser"), moduleConfig("module.b", "utility")];
    const ship = {
      id: "ship.entity-mount",
      render: { recipe: "procedural.arrowhead" },
      collider: { shape: "circle", radius: 1 },
      sockets: [
        { id: "a", kind: "hardpoint", accepts: ["laser"], transform: { pos: [1, 2, 3], rot: [0.1, 0.2, 0.3], scale: 1.2 } },
        { id: "fx", kind: "emitter", effect: "fx.missing", bindings: [], transform: { pos: [0, 0, -1] } },
        { id: "b", kind: "hardpoint", accepts: ["utility"], transform: { pos: [-3, -2, -1], rot: [-0.3, -0.2, -0.1], scale: 0.8 } },
      ],
    } as unknown as ShipConfig;
    const configs = {
      get: (type: string, id: string) => {
        if (type === "ship" && id === ship.id) return ship;
        if (type === "module") return modules.find((module) => module.id === id);
        return undefined;
      },
      getAll: (type: string) => type === "tuning" ? [{ projectilePoolSize: 1, beamFadeMs: 120 }] : [],
    } as unknown as ConfigService;
    const view = new ViewManager(
      scene,
      configs,
      () => ship.id,
      {
        projectiles: { useInstances: true },
        particles: { enabled: false, budgetMultiplier: 0, maxEmitterCapacity: 0 },
        asteroids: { lodMediumDistance: 0, lodLowDistance: 0, lodCullDistance: 0 },
      },
    );
    const snapshot = {
      tick: 1,
      elapsed: 1,
      phase: "live",
      countdownRemaining: 0,
      teamScores: [],
      winnerTeam: null,
      ships: [{
        id: 7,
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
        modules: modules.map((module, hardpointIndex) => ({
          moduleId: module.id,
          hardpointIndex,
          state: "active",
          heat: 0,
          heatCapacity: 0,
          energy: 0,
          energyCapacity: 0,
          stateTimer: 0,
          cycleTimer: 0,
          channeling: false,
          shieldPool: 0,
        })),
      }],
      asteroids: [],
      projectiles: [],
      decoys: [],
      flags: [],
    } satisfies Snapshot;

    view.render(snapshot, snapshot, 1, 16);
    const mounts = scene.transformNodes
      .filter((node) => node.name.startsWith("hp.ship.entity-mount."))
      .sort((a, b) => a.name.localeCompare(b.name));
    expect(mounts).toHaveLength(2);
    expect(mounts[0]!.position.asArray()).toEqual([1, 2, 3]);
    expect(mounts[0]!.rotation.asArray()).toEqual([0.1, 0.2, 0.3]);
    expect(mounts[0]!.scaling.asArray()).toEqual([1.2, 1.2, 1.2]);
    expect(mounts[1]!.position.asArray()).toEqual([-3, -2, -1]);
    expect(mounts[1]!.rotation.asArray()).toEqual([-0.3, -0.2, -0.1]);
    expect(mounts[1]!.scaling.asArray()).toEqual([0.8, 0.8, 0.8]);
    expect(scene.meshes.filter((mesh) => mesh.name.startsWith("hpmesh."))).toHaveLength(2);

    view.dispose();
    expect(mounts.every((mount) => mount.isDisposed())).toBe(true);
    scene.dispose();
    engine.dispose();
  });
});

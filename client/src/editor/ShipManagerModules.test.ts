import { MeshBuilder, NullEngine, Scene } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfigService, ModuleConfig, ShipConfig } from "@space-arena/shared";
import type { EditorHost } from "./EditorShell.js";

vi.mock("./ShipManager.js", () => ({
  ShipManager: class {
    readonly element = document.createElement("div");
    dispose(): void {}
  },
}));

import { ShipManagerModules } from "./ShipManagerModules.js";

const engines: NullEngine[] = [];

afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
});

describe("ShipManager fitted-module toggle", () => {
  it("defaults on and hides/remounts the default fitting without removing the hull", () => {
    const engine = new NullEngine();
    engines.push(engine);
    const scene = new Scene(engine);
    const module = {
      id: "module.laser",
      type: "module",
      version: 1,
      name: "Laser",
      family: "laser",
      level: 1,
      activation: { deployTime: 0, retractTime: 0 },
      ui: { icon: "laser", label: "Laser" },
      price: 0,
      requiresLevel: 1,
    } satisfies ModuleConfig;
    const ship = {
      id: "ship.test",
      render: { recipe: "procedural.arrowhead" },
      defaultFitting: [module.id],
      sockets: [{
        id: "gun",
        kind: "hardpoint",
        accepts: ["laser"],
        transform: { pos: [1, 2, 3], rot: [0.1, 0.2, 0.3], scale: 0.75 },
      }],
    } as unknown as ShipConfig;
    const configs = {
      get: (type: string, id: string) => type === "ship" && id === ship.id ? ship : type === "module" && id === module.id ? module : undefined,
    } as unknown as ConfigService;
    const host = {
      scene,
      configService: configs,
      bus: { on: vi.fn(() => vi.fn()) },
    } as unknown as EditorHost;
    MeshBuilder.CreateBox(`shipPreviewHull.${ship.id}`, { size: 1 }, scene);

    const panel = new ShipManagerModules(host, vi.fn());
    const toggle = panel.element.querySelector<HTMLButtonElement>(".ed-ship-fitted-toggle")!;
    expect(toggle.textContent).toBe("Show fitted modules");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(scene.meshes.filter((mesh) => mesh.name === "shipPreviewModule.gun")).toHaveLength(1);

    toggle.click();
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(scene.meshes.filter((mesh) => mesh.name === "shipPreviewModule.gun")).toHaveLength(0);
    expect(scene.getMeshByName(`shipPreviewHull.${ship.id}`)).not.toBeNull();

    toggle.click();
    expect(scene.meshes.filter((mesh) => mesh.name === "shipPreviewModule.gun")).toHaveLength(1);
    panel.dispose();
    scene.dispose();
  });
});

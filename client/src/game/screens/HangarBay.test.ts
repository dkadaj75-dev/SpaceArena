import { NullEngine, Scene, TransformNode } from "@babylonjs/core";
import { afterEach, describe, expect, it } from "vitest";
import { HangarBay } from "./HangarBay.js";

describe("HangarBay lifecycle", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);

  afterEach(() => {
    scene.dispose();
  });

  it("scopes its IBL, procedural maps, lights and shadow map to one bay visit", () => {
    const parent = new TransformNode("stage", scene);
    const baseline = {
      materials: scene.materials.length,
      textures: scene.textures.length,
      lights: scene.lights.length,
    };
    const bay = new HangarBay(scene, parent);

    expect(scene.materials.length).toBeGreaterThan(baseline.materials);
    expect(scene.lights.length).toBeGreaterThan(baseline.lights);
    bay.dispose();

    expect(scene.environmentTexture).toBeNull();
    expect(scene.materials).toHaveLength(baseline.materials);
    expect(scene.textures).toHaveLength(baseline.textures);
    expect(scene.lights).toHaveLength(baseline.lights);
    parent.dispose();
  });
});

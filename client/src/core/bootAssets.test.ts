import { NullEngine, Scene, SceneLoader } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssetRegistry } from "./AssetRegistry.js";
import { createBootAssetRegistry } from "./bootAssets.js";

describe("cold boot asset boundary", () => {
  afterEach(() => vi.restoreAllMocks());

  it("creates the shared registry without requesting or importing a GLB", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const ensureModel = vi.spyOn(AssetRegistry.prototype, "ensureModel");
    const importMesh = vi.spyOn(SceneLoader, "ImportMeshAsync");
    createBootAssetRegistry(scene);
    expect(ensureModel).not.toHaveBeenCalled();
    expect(importMesh).not.toHaveBeenCalled();
    scene.dispose();
    engine.dispose();
  });
});

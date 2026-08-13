import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MeshBuilder,
  Mesh,
  FreeCamera,
  NullEngine,
  PBRMaterial,
  Scene,
  SceneLoader,
  StandardMaterial,
  TransformNode,
  Vector3,
  type ISceneLoaderAsyncResult,
} from "@babylonjs/core";
import type { RenderRecipe } from "@space-arena/shared";
import { AssetRegistry, type AsteroidLod } from "./AssetRegistry.js";

const LOD: AsteroidLod = { lodMediumDistance: 85, lodLowDistance: 200, lodCullDistance: 620 };

/** The small-rock render block as authored in content, model included. */
const MODEL_RENDER: RenderRecipe = {
  recipe: "procedural.rock-small",
  palette: { primary: "#5b5148", accent: "#7d7266" },
  model: "asteroids/small_a.glb",
  modelScale: 3.5,
};

const PROCEDURAL_RENDER: RenderRecipe = {
  recipe: "procedural.rock-small",
  palette: { primary: "#5b5148", accent: "#7d7266" },
};

describe("AssetRegistry asteroid masters (§10 5.6)", () => {
  let engine: NullEngine;
  let scene: Scene;

  beforeEach(() => {
    engine = new NullEngine();
    scene = new Scene(engine);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    scene.dispose();
    engine.dispose();
  });

  /**
   * Stands in for the glTF import: one mesh with a fully-metallic PBR material,
   * normalized to max radial extent 1 the way the authored rocks are.
   */
  function stubModelImport(): void {
    vi.spyOn(SceneLoader, "ImportMeshAsync").mockImplementation(() => {
      const mesh = MeshBuilder.CreateSphere("glbRock", { diameter: 2, segments: 4 }, scene);
      const material = new PBRMaterial("glbRock.mat", scene);
      material.metallic = 1;
      material.roughness = 0;
      mesh.material = material;
      return Promise.resolve({
        meshes: [mesh],
        particleSystems: [],
        skeletons: [],
        animationGroups: [],
        transformNodes: [],
        geometries: [],
        lights: [],
      } as unknown as ISceneLoaderAsyncResult);
    });
  }

  it("falls back to the unit-radius procedural master while no model has loaded", () => {
    const assets = new AssetRegistry(scene);
    const { mesh, radiusScale } = assets.getAsteroidMaster(MODEL_RENDER);
    expect(mesh.name).toBe("master.procedural.rock-small");
    // Unit-radius master: instance scaling IS the collider radius.
    expect(radiusScale).toBe(1);
    assets.dispose();
  });

  it("prefers the loaded GLB master and scales instances by radius/modelScale", async () => {
    stubModelImport();
    const assets = new AssetRegistry(scene);
    await assets.ensureModel(MODEL_RENDER);

    const { mesh, radiusScale } = assets.getAsteroidMaster(MODEL_RENDER);
    expect(mesh.name).toBe("master.model.asteroids/small_a.glb");
    // modelScale is baked into the master, so an unscaled placement at the
    // config's own radius comes out at scaling 1.
    expect(radiusScale).toBeCloseTo(1 / 3.5, 6);
    expect(3.5 * radiusScale).toBeCloseTo(1, 6);
    assets.dispose();
  });

  it("refreshes the master's bounding info after baking modelScale (single-part path)", async () => {
    stubModelImport();
    const assets = new AssetRegistry(scene);
    await assets.ensureModel(MODEL_RENDER);
    const { mesh } = assets.getAsteroidMaster(MODEL_RENDER);
    // The stub sphere is unit-radius; modelScale 3.5 must reach the BOUNDS,
    // not just the vertices — stale import bounds mis-cull instances.
    expect(mesh.getBoundingInfo().boundingSphere.radius).toBeGreaterThan(3);
    assets.dispose();
  });

  it("clamps the model's metalness so the rock is not black without an IBL", async () => {
    stubModelImport();
    const assets = new AssetRegistry(scene);
    await assets.ensureModel(MODEL_RENDER);
    const material = assets.getAsteroidMaster(MODEL_RENDER).mesh.material;
    expect(material).toBeInstanceOf(PBRMaterial);
    expect((material as PBRMaterial).metallic).toBeLessThanOrEqual(0.25);
    expect((material as PBRMaterial).roughness).toBeGreaterThanOrEqual(0.5);
    assets.dispose();
  });

  it("restores authored PBR metalness only while the hangar IBL is active", async () => {
    stubModelImport();
    const assets = new AssetRegistry(scene);
    await assets.ensureModel(MODEL_RENDER);
    const material = assets.getAsteroidMaster(MODEL_RENDER).mesh.material as PBRMaterial;
    expect(material.metallic).toBe(0.25);
    expect(material.roughness).toBe(0.5);

    assets.setHangarMaterialMode(true);
    expect(material.metallic).toBe(1);
    expect(material.roughness).toBe(0);

    assets.setHangarMaterialMode(false);
    expect(material.metallic).toBe(0.25);
    expect(material.roughness).toBe(0.5);
    assets.dispose();
  });

  it("gives a procedural master medium/low stand-ins plus a cull level", () => {
    const assets = new AssetRegistry(scene);
    assets.setAsteroidLod(LOD);
    const { mesh } = assets.getAsteroidMaster(PROCEDURAL_RENDER);
    const levels = mesh.getLODLevels();
    expect(levels.map((l) => l.distanceOrScreenCoverage)).toEqual([620, 200, 85]);
    // The cull level draws nothing; the two stand-ins share the master material.
    expect(levels[0]?.mesh).toBeNull();
    expect(levels[1]?.mesh?.material).toBe(mesh.material);
    expect(levels[2]?.mesh?.material).toBe(mesh.material);
    assets.dispose();
  });

  it("gives a MODEL master the same ladder, with palette-matched stand-ins baked to modelScale", async () => {
    stubModelImport();
    const assets = new AssetRegistry(scene);
    assets.setAsteroidLod(LOD);
    await assets.ensureModel(MODEL_RENDER);

    const { mesh } = assets.getAsteroidMaster(MODEL_RENDER);
    const levels = mesh.getLODLevels();
    // Distances are authored for a radius-4 rock and scale by modelScale/4
    // (3.5/4 = 0.875 here), so every rock swaps at the same on-screen size.
    expect(levels.map((l) => l.distanceOrScreenCoverage)).toEqual([620 * 0.875, 200 * 0.875, 85 * 0.875]);
    const medium = levels[2]?.mesh;
    expect(medium).toBeTruthy();
    // NOT the GLB's PBR material: its albedo is baked against the GLB's own UVs.
    expect(medium?.material).toBeInstanceOf(StandardMaterial);
    expect(medium?.material).not.toBe(mesh.material);
    // Baked to the master's modelScale so one instance scaling fits both.
    expect(medium!.getBoundingInfo().boundingSphere.radius).toBeCloseTo(
      mesh.getBoundingInfo().boundingSphere.radius,
      0,
    );
    assets.dispose();
  });

  it("holds a big rock's GLB proportionally farther out than a small one's", async () => {
    stubModelImport();
    const assets = new AssetRegistry(scene);
    assets.setAsteroidLod(LOD);
    const bigRender: RenderRecipe = {
      recipe: "procedural.rock-large",
      palette: { primary: "#463b34", accent: "#8a5a3c" },
      model: "asteroids/large_a.glb",
      modelScale: 8,
    };
    await assets.ensureModel(bigRender);

    const { mesh } = assets.getAsteroidMaster(bigRender);
    // radius 8 / reference 4 = 2× the authored distances.
    expect(mesh.getLODLevels().map((l) => l.distanceOrScreenCoverage)).toEqual([1240, 400, 170]);
    assets.dispose();
  });

  it("re-applies the ladder on a tier switch without stacking cull levels", () => {
    const assets = new AssetRegistry(scene);
    assets.setAsteroidLod(LOD);
    const { mesh } = assets.getAsteroidMaster(PROCEDURAL_RENDER);
    assets.setAsteroidLod({ ...LOD, lodLowDistance: 0 });
    expect(mesh.getLODLevels().map((l) => l.distanceOrScreenCoverage)).toEqual([620, 85]);
    assets.setAsteroidLod(null);
    expect(mesh.getLODLevels()).toHaveLength(0);
    assets.dispose();
  });

  it("draws the procedural rock when the tier opts out of models", async () => {
    stubModelImport();
    const assets = new AssetRegistry(scene);
    assets.setAsteroidLod({ ...LOD, proceduralOnly: true });
    await assets.ensureModel(MODEL_RENDER);

    const { mesh, radiusScale } = assets.getAsteroidMaster(MODEL_RENDER);
    expect(mesh.name).toBe("master.procedural.rock-small");
    expect(radiusScale).toBe(1);
    assets.dispose();
  });

  it("never applies the asteroid procedural-only quality gate to ship GLBs", async () => {
    stubModelImport();
    const assets = new AssetRegistry(scene);
    assets.setAsteroidLod({ ...LOD, proceduralOnly: true });
    await assets.ensureModel(MODEL_RENDER);

    expect(assets.getShipMaster(MODEL_RENDER).name).toBe("master.model.asteroids/small_a.glb");
    // The same render used as an asteroid still respects the low-tier gate.
    expect(assets.getAsteroidMaster(MODEL_RENDER).mesh.name).toBe("master.procedural.rock-small");
    assets.dispose();
  });

  it("detaches its LOD levels from the shared model master on dispose", async () => {
    stubModelImport();
    const assets = new AssetRegistry(scene);
    assets.setAsteroidLod(LOD);
    await assets.ensureModel(MODEL_RENDER);
    const { mesh } = assets.getAsteroidMaster(MODEL_RENDER);
    expect(mesh.getLODLevels()).toHaveLength(3);

    // The model master is cached per SCENE, not per registry, so it survives —
    // a dangling LOD level would break the next registry on the same scene.
    assets.dispose();
    expect(mesh.isDisposed()).toBe(false);
    expect(mesh.getLODLevels()).toHaveLength(0);

    const second = new AssetRegistry(scene);
    second.setAsteroidLod(LOD);
    expect(second.getAsteroidMaster(MODEL_RENDER).mesh).toBe(mesh);
    expect(mesh.getLODLevels()).toHaveLength(3);
    second.dispose();
  });

  it("keeps no-merge visual parts separate, drops COL_ meshes, and separates the cache variant", async () => {
    const importSpy = vi.spyOn(SceneLoader, "ImportMeshAsync").mockImplementation(() => {
      const root = new Mesh("__root__", scene);
      const left = MeshBuilder.CreateBox("left", { size: 1 }, scene);
      const right = MeshBuilder.CreateBox("right", { size: 1 }, scene);
      const collider = MeshBuilder.CreateBox("COL_wall", { size: 1 }, scene);
      left.parent = root;
      right.parent = root;
      collider.parent = root;
      return Promise.resolve({ meshes: [root, left, right, collider] } as unknown as ISceneLoaderAsyncResult);
    });
    const assets = new AssetRegistry(scene);
    const merged = await assets.ensureModel(MODEL_RENDER);
    const unmerged = await assets.ensureModel(MODEL_RENDER, { mergeParts: false });

    expect(merged).not.toBe(unmerged);
    expect(unmerged).toBeInstanceOf(TransformNode);
    expect(unmerged!.getChildMeshes(true).map((mesh) => mesh.name)).toEqual(["left", "right"]);
    expect(scene.getMeshByName("COL_wall")).toBeNull();
    expect(importSpy).toHaveBeenCalledTimes(2);
    expect(await assets.ensureModel(MODEL_RENDER, { mergeParts: false })).toBe(unmerged);
    expect(importSpy).toHaveBeenCalledTimes(2);
    assets.dispose();
  });

  it("adds authored LOD levels per unmerged part with placement distance scaling", async () => {
    vi.spyOn(SceneLoader, "ImportMeshAsync").mockImplementation((_names, _rootUrl, fileName) => {
      const suffix = String(fileName).includes("lod") ? "lod" : "base";
      const root = new Mesh(`root.${suffix}`, scene);
      const a = MeshBuilder.CreateBox(`a.${suffix}`, { size: 1 }, scene);
      const b = MeshBuilder.CreateBox(`b.${suffix}`, { size: 1 }, scene);
      a.parent = root;
      b.parent = root;
      return Promise.resolve({ meshes: [root, a, b] } as unknown as ISceneLoaderAsyncResult);
    });
    const assets = new AssetRegistry(scene);
    const master = await assets.ensureModel(MODEL_RENDER, { mergeParts: false });
    await assets.applyModelLods(master!, [{ model: "asteroids/rock_lod.glb", distance: 80 }], 0.5);

    const parts = master!.getChildMeshes(true);
    expect(parts).toHaveLength(2);
    for (const part of parts) {
      expect((part as Mesh).getLODLevels().map((level) => level.distanceOrScreenCoverage)).toEqual([40]);
    }
    assets.dispose();
  });

  it("renders an authored LOD through a distant instance without rendering its hidden master", async () => {
    vi.spyOn(SceneLoader, "ImportMeshAsync").mockImplementation((_names, _rootUrl, fileName) => {
      const suffix = String(fileName).includes("lod") ? "lod" : "base";
      const mesh = MeshBuilder.CreateBox(`terrain.${suffix}`, { size: 1 }, scene);
      mesh.material = new StandardMaterial(`terrain.${suffix}.mat`, scene);
      return Promise.resolve({ meshes: [mesh] } as unknown as ISceneLoaderAsyncResult);
    });
    const camera = new FreeCamera("lod.camera", new Vector3(0, 0, -100), scene);
    camera.setTarget(Vector3.Zero());
    scene.activeCamera = camera;
    const assets = new AssetRegistry(scene);
    const master = await assets.ensureModel(MODEL_RENDER);
    await assets.applyModelLods(master!, [{ model: "asteroids/rock_lod.glb", distance: 40 }]);
    const variant = master!.getLODLevels()[0]!.mesh!;
    const placement = master!.createInstance("terrain-placement");

    scene.render();

    expect(placement.getLOD(camera)).toBe(variant);
    const activeMeshes = scene.getActiveMeshes().data;
    expect(activeMeshes.includes(placement)).toBe(true);
    expect(variant.isEnabled()).toBe(true);
    expect(variant.isVisible).toBe(false);
    // The substitute is not an independently-rendered origin mesh; it only
    // enters rendering through the instance selected above.
    expect(activeMeshes.includes(variant)).toBe(false);
    placement.dispose();
    assets.dispose();
  });
});

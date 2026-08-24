import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  AbstractMesh,
  Material,
  MeshBuilder,
  Mesh,
  FreeCamera,
  NullEngine,
  PBRMaterial,
  Quaternion,
  Scene,
  SceneLoader,
  ImportMeshAsync,
  StandardMaterial,
  Texture,
  TransformNode,
  Vector3,
  VertexBuffer,
  type ISceneLoaderAsyncResult,
} from "@babylonjs/core";
import "@babylonjs/loaders/glTF";
import type { RenderRecipe } from "@space-arena/shared";
import { AssetRegistry, type AsteroidLod } from "./AssetRegistry.js";
import { pinInstanceLod0 } from "./modelLod.js";

const CONTENT_DIR = path.resolve(import.meta.dirname, "../../../content");

const LOD: AsteroidLod = { lodMediumDistance: 85, lodLowDistance: 200, lodCullDistance: 620 };

/** The small-rock render block as authored in content, model included. */
const MODEL_RENDER: RenderRecipe = {
  recipe: "procedural.rock-small",
  palette: { primary: "#5b5148", accent: "#7d7266" },
  model: "fixtures/rock-a.glb",
  modelScale: 3.5,
};

const PROCEDURAL_RENDER: RenderRecipe = {
  recipe: "procedural.rock-small",
  palette: { primary: "#5b5148", accent: "#7d7266" },
};

describe("AssetRegistry imported PBR material canonicalization", () => {
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

  it("shares same-named same-albedo slots but keeps a different albedo distinct", async () => {
    vi.spyOn(SceneLoader, "ImportMeshAsync").mockImplementation((_names, _root, file) => {
      const filename = typeof file === "string" ? file : "";
      const mesh = MeshBuilder.CreateBox(`part.${filename}`, { size: 1 }, scene);
      const material = new PBRMaterial("RIFT_FLOOR", scene);
      material.albedoTexture = new Texture(
        filename.includes("other") ? "textures/other.webp" : "textures/rift.webp",
        scene,
      );
      mesh.material = material;
      return Promise.resolve({ meshes: [mesh] } as unknown as ISceneLoaderAsyncResult);
    });
    const assets = new AssetRegistry(scene);
    const render = (model: string): RenderRecipe => ({ recipe: "model.static", model });
    const first = await assets.ensureModel(render("props/one.glb"), { mergeParts: false });
    const same = await assets.ensureModel(render("props/two.glb"), { mergeParts: false });
    const different = await assets.ensureModel(render("props/other.glb"), { mergeParts: false });

    const firstMaterial = first!.getChildMeshes(false)[0]!.material;
    expect(same!.getChildMeshes(false)[0]!.material).toBe(firstMaterial);
    expect(different!.getChildMeshes(false)[0]!.material).not.toBe(firstMaterial);
    expect(scene.materials.filter((material) => material.name === "RIFT_FLOOR")).toHaveLength(2);
    assets.dispose();
  });

  it("reduces all 16 lunar-rift chunks and LOD variants to two RIFT materials", async () => {
    vi.spyOn(SceneLoader, "ImportMeshAsync").mockImplementation((_names, _root, file) => {
      const floor = MeshBuilder.CreateBox(`floor.${file}`, { size: 1 }, scene);
      const wall = MeshBuilder.CreateBox(`wall.${file}`, { size: 1 }, scene);
      const floorMaterial = new PBRMaterial("RIFT_FLOOR", scene);
      floorMaterial.albedoTexture = new Texture("textures/rift-floor.webp", scene);
      const wallMaterial = new PBRMaterial("RIFT_WALL", scene);
      wallMaterial.albedoTexture = new Texture("textures/rift-wall.webp", scene);
      floor.material = floorMaterial;
      wall.material = wallMaterial;
      return Promise.resolve({ meshes: [floor, wall] } as unknown as ISceneLoaderAsyncResult);
    });
    const assets = new AssetRegistry(scene);
    await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        Promise.all(
          ["", "_lod1"].map((suffix) =>
            assets.ensureModel(
              { recipe: "model.static", model: `props/lunar-rift-chunk-${index}${suffix}.glb` },
              { mergeParts: false },
            ),
          ),
        ),
      ),
    );

    expect(scene.materials.filter((material) => /^RIFT_(FLOOR|WALL)$/.test(material.name))).toHaveLength(2);
    assets.dispose();
  });

  it("keeps canonical materials alive when a later load's finalize fails", async () => {
    vi.spyOn(SceneLoader, "ImportMeshAsync").mockImplementation((_names, _root, file) => {
      const left = MeshBuilder.CreateBox(`left.${file}`, { size: 1 }, scene);
      const right = MeshBuilder.CreateBox(`right.${file}`, { size: 1 }, scene);
      const material = new PBRMaterial("RIFT_FLOOR", scene);
      material.albedoTexture = new Texture("textures/rift.webp", scene);
      left.material = material;
      right.material = material;
      return Promise.resolve({ meshes: [left, right] } as unknown as ISceneLoaderAsyncResult);
    });
    const assets = new AssetRegistry(scene);
    const render = (model: string): RenderRecipe => ({ recipe: "model.static", model });
    const first = await assets.ensureModel(render("props/one.glb"), { mergeParts: false });
    const canonical = first!.getChildMeshes(false)[0]!.material!;

    vi.spyOn(Mesh, "MergeMeshes").mockReturnValueOnce(null);
    const failed = await assets.ensureModel(render("props/two.glb"), { mergeParts: true });

    expect(failed).toBeNull();
    // The failed load's cleanup must not dispose the shared canonical (or its
    // textures) out from under every mesh already rendering with it — but the
    // failing load's own private duplicate must not leak into the scene either.
    expect(scene.materials).toContain(canonical);
    expect(scene.materials.filter((material) => material.name === "RIFT_FLOOR")).toHaveLength(1);
    const third = await assets.ensureModel(render("props/three.glb"), { mergeParts: false });
    expect(third!.getChildMeshes(false)[0]!.material).toBe(canonical);
    assets.dispose();
  });
});

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
    expect(mesh.name).toBe("master.model.fixtures/rock-a.glb");
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
      model: "fixtures/rock-large.glb",
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

    expect(assets.getShipMaster(MODEL_RENDER).name).toBe("master.model.fixtures/rock-a.glb");
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

  it("preserves upward-facing geometry and lighting through the no-merge glTF root bake", async () => {
    const importedRoots: Mesh[] = [];
    const bakedDeterminants: number[] = [];
    const upwardReferences: UpwardTriangleReference[] = [];
    const authoredUvs: number[][] = [];
    const authoredColors: number[][] = [];
    vi.spyOn(SceneLoader, "ImportMeshAsync").mockImplementation(() => {
      const root = new Mesh("__root__", scene);
      root.rotationQuaternion = new Quaternion(0, 1, 0, 0);
      root.scaling.set(1, 1, -1);
      importedRoots.push(root);

      const floor = MeshBuilder.CreateGround("crater.floor", { width: 4, height: 4 }, scene);
      const colors = Array.from({ length: floor.getTotalVertices() }, () => [0.2, 0.4, 0.6, 1]).flat();
      floor.setVerticesData(
        VertexBuffer.ColorKind,
        colors,
      );
      floor.material = new StandardMaterial("crater.floor.mat", scene);
      floor.sideOrientation = Material.ClockWiseSideOrientation;
      floor.parent = root;
      bakedDeterminants.push(floor.computeWorldMatrix(true).determinant());
      upwardReferences.push(upwardTriangleReference(floor));
      authoredUvs.push(Array.from(floor.getVerticesData(VertexBuffer.UVKind)!));
      authoredColors.push(colors);
      return Promise.resolve({ meshes: [root, floor] } as unknown as ISceneLoaderAsyncResult);
    });
    const assets = new AssetRegistry(scene);
    const master = await assets.ensureModel(
      { ...MODEL_RENDER, modelScale: 1 },
      { mergeParts: false },
    );
    const part = master!.getChildMeshes(true)[0] as Mesh;
    expect(part.computeWorldMatrix().determinant()).toBeCloseTo(1);
    const placed = master!.instantiateHierarchy(null, { doNotInstantiate: false })!;
    expect(placed.getChildMeshes(true)[0]!.computeWorldMatrix(true).determinant()).toBeCloseTo(1);
    placed.dispose();
    await assets.applyModelLods(master!, [{ model: "terrain/crater_floor_lod.glb", distance: 20 }]);
    const lodVariant = part.getLODLevels()[0]!.mesh!;
    expect(importedRoots.map((root) => root.scaling.asArray())).toEqual([[1, 1, -1], [1, 1, -1]]);
    expect(importedRoots.map((root) => root.rotationQuaternion!.asArray())).toEqual([
      [0, 1, 0, 0],
      [0, 1, 0, 0],
    ]);
    expect(bakedDeterminants).toEqual([-1, -1]);
    expect(upwardFaceOracle(part, part, upwardReferences[0]!).frontFacesUp).toBe(true);
    expect(upwardFaceOracle(lodVariant, lodVariant, upwardReferences[1]!).frontFacesUp).toBe(true);
    const normals = part.getVerticesData(VertexBuffer.NormalKind)!;
    expect(Vector3.Dot(Vector3.FromArray(normals), Vector3.Up())).toBeGreaterThan(0);
    const lodNormals = lodVariant.getVerticesData(VertexBuffer.NormalKind)!;
    expect(Vector3.Dot(Vector3.FromArray(lodNormals), Vector3.Up())).toBeGreaterThan(0);
    expect(Array.from(part.getVerticesData(VertexBuffer.UVKind)!)).toEqual(authoredUvs[0]);
    expect(Array.from(part.getVerticesData(VertexBuffer.ColorKind)!)).toEqual(authoredColors[0]);
    expect(Array.from(lodVariant.getVerticesData(VertexBuffer.UVKind)!)).toEqual(authoredUvs[1]);
    expect(Array.from(lodVariant.getVerticesData(VertexBuffer.ColorKind)!)).toEqual(authoredColors[1]);
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
    await assets.applyModelLods(master!, [
      { model: "ships/ship_lod1.glb", distance: 40 },
      { model: "ships/ship_lod2.glb", distance: 90 },
      { model: "ships/ship_lod3.glb", distance: 180 },
    ]);
    const variant = master!.getLODLevels()[0]!.mesh!;
    const placement = master!.createInstance("terrain-placement");
    const preview = master!.createInstance("hangar-preview");
    pinInstanceLod0(preview);

    const distantVariant = master!.getLODLevels()[1]!.mesh! as Mesh;
    const variantRegisters = vi.spyOn(
      distantVariant as unknown as { _registerInstanceForRenderId(instance: unknown, renderId: number): void },
      "_registerInstanceForRenderId",
    );
    const masterRegisters = vi.spyOn(
      master as unknown as { _registerInstanceForRenderId(instance: unknown, renderId: number): void },
      "_registerInstanceForRenderId",
    );
    scene.render();

    expect(placement.getLOD(camera)).toBe(master!.getLODLevels()[1]!.mesh);
    expect(preview.getLOD(camera)).toBe(master);
    // getLOD's return value alone is not proof of drawing: _activate only
    // registers an instance into a render batch through _currentLOD, so a pin
    // that skips that assignment passes the getLOD checks yet draws nothing.
    expect(variantRegisters).toHaveBeenCalledWith(placement, expect.any(Number));
    expect(masterRegisters).toHaveBeenCalledWith(preview, expect.any(Number));
    const activeMeshes = scene.getActiveMeshes().data;
    expect(activeMeshes.includes(placement)).toBe(true);
    expect(variant.isEnabled()).toBe(true);
    expect(variant.isVisible).toBe(false);
    // The substitute is not an independently-rendered origin mesh; it only
    // enters rendering through the instance selected above.
    expect(activeMeshes.includes(variant)).toBe(false);
    placement.dispose();
    preview.dispose();
    assets.dispose();
  });

  it("renders enabled hidden authored LOD parts through a distant no-merge prop hierarchy", async () => {
    vi.spyOn(SceneLoader, "ImportMeshAsync").mockImplementation((_names, _rootUrl, fileName) => {
      const suffix = String(fileName).includes("lod") ? "lod" : "base";
      const root = new Mesh(`root.${suffix}`, scene);
      const left = MeshBuilder.CreateBox(`left.${suffix}`, { size: 1 }, scene);
      const right = MeshBuilder.CreateBox(`right.${suffix}`, { size: 1 }, scene);
      left.material = new StandardMaterial(`left.${suffix}.mat`, scene);
      right.material = new StandardMaterial(`right.${suffix}.mat`, scene);
      left.parent = root;
      right.parent = root;
      return Promise.resolve({ meshes: [root, left, right] } as unknown as ISceneLoaderAsyncResult);
    });
    const camera = new FreeCamera("prop.lod.camera", new Vector3(0, 0, -228), scene);
    camera.setTarget(Vector3.Zero());
    scene.activeCamera = camera;
    const assets = new AssetRegistry(scene);
    const master = await assets.ensureModel(MODEL_RENDER, { mergeParts: false });
    await assets.applyModelLods(master!, [{ model: "terrain/prop_lod1.glb", distance: 190 }]);
    const root = new TransformNode("prop.root", scene);
    const placement = master!.instantiateHierarchy(root, { doNotInstantiate: false });
    const baseParts = master!.getChildMeshes(true).filter((mesh): mesh is Mesh => mesh instanceof Mesh);
    const instanceParts = placement!.getChildMeshes(true).filter((mesh): mesh is Mesh => mesh instanceof Mesh);
    const variants = baseParts.map((part) => part.getLODLevels()[0]!.mesh!);
    const renderSpies = variants.map((variant) =>
      vi.spyOn(variant as unknown as { _renderWithInstances: () => void }, "_renderWithInstances"),
    );

    for (const variant of variants) expect(variant.isEnabled()).toBe(true);

    scene.render();

    for (let index = 0; index < instanceParts.length; index++) {
      const variant = variants[index]!;
      expect(instanceParts[index]!.getLOD(camera)).toBe(variant);
      expect(variant.isEnabled()).toBe(true);
      expect(variant.isVisible).toBe(false);
      expect(variant.getTotalVertices()).toBeGreaterThan(0);
      expect(renderSpies[index]).toHaveBeenCalled();
    }
    // Variants only render as substitutes. Without a selected instance they
    // must stay out of the scene's active-mesh list at the cached origin.
    root.dispose(false, true);
    scene.render();
    for (const variant of variants) expect(scene.getActiveMeshes().data.includes(variant)).toBe(false);
    assets.dispose();
  });
});

interface OrientationOracleResult {
  diskCrossY: number;
  bakedDeterminant: number;
  worldDeterminant: number;
  effectiveSideOrientation: number;
  overrideMaterialSideOrientation: number | null | undefined;
  materialSideOrientation: number | null | undefined;
  frontFacesUp: boolean;
}

interface UpwardTriangleReference {
  triangleOffset: number;
  diskCrossY: number;
  diskNormal: Vector3;
  bakedDeterminant: number;
}

/** Select an indexed triangle whose unbaked, primitive-local winding faces +Y. */
function upwardTriangleReference(geometry: Mesh): UpwardTriangleReference {
  const positions = geometry.getVerticesData(VertexBuffer.PositionKind)!;
  const indices = geometry.getIndices()!;
  const diskToBabylon = geometry.computeWorldMatrix(true);
  const handedness = Math.sign(diskToBabylon.determinant()) || 1;
  let triangleOffset = -1;
  let diskCrossY = -Infinity;
  let diskNormal = Vector3.Zero();
  for (let offset = 0; offset < indices.length; offset += 3) {
    const points = [0, 1, 2].map((corner) =>
      Vector3.TransformCoordinates(
        Vector3.FromArray(positions, indices[offset + corner]! * 3),
        diskToBabylon,
      ),
    );
    const candidateNormal = Vector3.Cross(
      points[1]!.subtract(points[0]!),
      points[2]!.subtract(points[0]!),
    ).normalize().scale(handedness);
    const candidateY = candidateNormal.y;
    if (candidateY > diskCrossY) {
      triangleOffset = offset;
      diskCrossY = candidateY;
      diskNormal = candidateNormal;
    }
  }
  expect(triangleOffset).toBeGreaterThanOrEqual(0);
  return {
    triangleOffset,
    diskCrossY,
    diskNormal,
    bakedDeterminant: diskToBabylon.determinant(),
  };
}

/** Model Babylon's culling decision for one specific upward-authored triangle. */
function upwardFaceOracle(
  mesh: AbstractMesh,
  geometry: Mesh,
  reference: UpwardTriangleReference,
): OrientationOracleResult {
  const positions = geometry.getVerticesData(VertexBuffer.PositionKind)!;
  const indices = geometry.getIndices()!;
  const world = mesh.computeWorldMatrix(true);
  const worldDeterminant = world.determinant();
  const points = [0, 1, 2].map((corner) =>
    Vector3.TransformCoordinates(
      Vector3.FromArray(positions, indices[reference.triangleOffset + corner]! * 3),
      world,
    ),
  );
  const indexedNormal = Vector3.Cross(points[1]!.subtract(points[0]!), points[2]!.subtract(points[0]!)).normalize();
  const override = geometry.overrideMaterialSideOrientation;
  const materialOrientation = geometry.material?.sideOrientation;
  let effectiveSideOrientation = override ?? materialOrientation ?? Material.CounterClockWiseSideOrientation;
  if (worldDeterminant < 0) {
    effectiveSideOrientation =
      effectiveSideOrientation === Material.ClockWiseSideOrientation
        ? Material.CounterClockWiseSideOrientation
        : Material.ClockWiseSideOrientation;
  }
  // Babylon's LH CW front uses the indexed cross-normal. CCW uses its opposite.
  const frontNormal = indexedNormal.scale(
    effectiveSideOrientation === Material.ClockWiseSideOrientation ? 1 : -1,
  );
  return {
    diskCrossY: reference.diskCrossY,
    bakedDeterminant: reference.bakedDeterminant,
    worldDeterminant,
    effectiveSideOrientation,
    overrideMaterialSideOrientation: override,
    materialSideOrientation: materialOrientation,
    frontFacesUp: Vector3.Dot(frontNormal, reference.diskNormal) > 0.25,
  };
}

const ORIENTATION_FIXTURES = [
  ...Array.from({ length: 16 }, (_, index) => `props/lunar-rift-chunk-${index}.glb`),
  "props/lunar-rift-flagpad.glb",
  "props/lunar-rift-boulder-a.glb",
  "ships/human_medium_lod0.glb",
];

describe("AssetRegistry shipped glTF face orientation", () => {
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

  async function importRealGlb(relativePath: string, targetScene = scene): Promise<ISceneLoaderAsyncResult> {
    const bytes = await readFile(path.join(CONTENT_DIR, relativePath));
    return ImportMeshAsync(bytes, targetScene, {
      meshNames: "",
      pluginExtension: ".glb",
      // The Blender terrain references shipped external JPEGs. Its culling
      // state lives on the primitive override, so omit only those textures;
      // the other fixtures load their real glTF materials as well.
      pluginOptions: {
        gltf: {
          skipMaterials: false,
          // Preserve the authored/shared material objects (including their
          // culling state) without making the Node test fetch external JPEGs.
          preprocessUrlAsync: async () =>
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mNk+M/wHwAF/gL+Xw4mAAAAAElFTkSuQmCC",
        },
      },
    });
  }

  function geometricMeshes(result: ISceneLoaderAsyncResult): Mesh[] {
    return result.meshes.filter(
      (mesh): mesh is Mesh =>
        mesh instanceof Mesh && mesh.getTotalVertices() > 0 && !/(^|_)COL_/.test(mesh.name),
    );
  }

  it("validates the culling oracle on the plain known-good shipped ship glTF", async () => {
    const result = await importRealGlb("ships/human_medium_lod0.glb");
    const meshes = geometricMeshes(result);
    const rows = meshes.map((mesh, primitive) => ({
      primitive,
      mesh: mesh.name,
      ...upwardFaceOracle(mesh, mesh, upwardTriangleReference(mesh)),
    }));
    console.log("ORIENTATION ORACLE VALIDATION (plain Babylon glTF, no finalize)");
    console.table(rows);
    expect(meshes.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.frontFacesUp)).toBe(true);
  });

  it("keeps every shipped fixture primitive front-facing through every no-merge rendering path", async () => {
    const matrix: Array<
      OrientationOracleResult & { file: string; path: string; primitive: number; mesh: string }
    > = [];
    const referencesByFile = new Map<string, UpwardTriangleReference[]>();
    for (const relativePath of ORIENTATION_FIXTURES) {
      const raw = await importRealGlb(relativePath);
      const rawParts = geometricMeshes(raw);
      referencesByFile.set(relativePath, rawParts.map(upwardTriangleReference));
      for (const mesh of raw.meshes) mesh.dispose(false, true);
    }

    const importedMaterialOrientations = new Map<Material, number | null>();
    vi.spyOn(SceneLoader, "ImportMeshAsync").mockImplementation(
      async (_meshNames, rootUrl, fileName, targetScene) => {
        const requested = `${rootUrl}${String(fileName)}`;
        const contentRelative = requested.slice(requested.indexOf("content/") + "content/".length);
        const result = await importRealGlb(contentRelative, targetScene ?? scene);
        for (const mesh of geometricMeshes(result)) {
          if (mesh.material && !importedMaterialOrientations.has(mesh.material)) {
            importedMaterialOrientations.set(mesh.material, mesh.material.sideOrientation);
          }
        }
        return result;
      },
    );
    const assets = new AssetRegistry(scene);
    const masters = new Map<string, TransformNode>();
    for (const relativePath of ORIENTATION_FIXTURES) {
      const recipe: RenderRecipe = { recipe: "model.static", model: relativePath };
      masters.set(relativePath, (await assets.ensureModel(recipe, { mergeParts: false }))!);
    }
    for (const [material, importedOrientation] of importedMaterialOrientations) {
      expect(material.sideOrientation, material.name).toBe(importedOrientation);
    }

    for (const relativePath of ORIENTATION_FIXTURES) {
      const references = referencesByFile.get(relativePath)!;
      const partsMaster = masters.get(relativePath)!;
      const parts = partsMaster.getChildMeshes(true).filter((mesh): mesh is Mesh => mesh instanceof Mesh);
      expect(parts).toHaveLength(references.length);
      for (let primitive = 0; primitive < parts.length; primitive++) {
        const part = parts[primitive]!;
        matrix.push({
          file: relativePath,
          path: "no-merge",
          primitive,
          mesh: part.name,
          ...upwardFaceOracle(part, part, references[primitive]!),
        });
      }

      const placementRoot = new TransformNode(`placement.${relativePath}`, scene);
      const placement = partsMaster.instantiateHierarchy(placementRoot, { doNotInstantiate: false })!;
      const instances = placement.getChildMeshes(true);
      expect(instances).toHaveLength(parts.length);
      for (let primitive = 0; primitive < instances.length; primitive++) {
        matrix.push({
          file: relativePath,
          path: "no-merge instance",
          primitive,
          mesh: instances[primitive]!.name,
          ...upwardFaceOracle(instances[primitive]!, parts[primitive]!, references[primitive]!),
        });
      }

      await assets.applyModelLods(partsMaster, [{ model: relativePath, distance: 10 }]);
      for (let primitive = 0; primitive < parts.length; primitive++) {
        const variant = parts[primitive]!.getLODLevels()[0]!.mesh!;
        matrix.push({
          file: relativePath,
          path: "authored-LOD variant clone",
          primitive,
          mesh: variant.name,
          ...upwardFaceOracle(variant, variant, references[primitive]!),
        });
      }
    }
    assets.dispose();
    console.log("SHIPPED PRIMITIVE ORIENTATION SUMMARY");
    console.table(
      ORIENTATION_FIXTURES.map((file) => {
        const rows = matrix.filter((row) => row.file === file);
        return {
          file,
          primitives: referencesByFile.get(file)!.length,
          paths: new Set(rows.map((row) => row.path)).size,
          passed: rows.filter((row) => row.frontFacesUp).length,
          rows: rows.length,
        };
      }),
    );
    console.log("SHIPPED PROP ORIENTATION MATRIX");
    console.table(matrix);
    const chunkOneFloor = matrix.filter(
      (row) => row.file === "props/lunar-rift-chunk-1.glb" && row.primitive === 0,
    );
    expect(chunkOneFloor).toHaveLength(3);
    expect(chunkOneFloor.every((row) => row.frontFacesUp)).toBe(true);
    // RIFT_WALL deliberately contains near-vertical faces; it has no reliable
    // upward-facing oracle triangle. Validate the terrain floor primitive and
    // retain the aggregate orientation assertion for every other fixture.
    expect(
      matrix
        .filter((row) => !row.file.startsWith("props/lunar-rift-chunk-") || row.primitive === 0)
        .every((row) => row.frontFacesUp),
    ).toBe(true);
  }, 30_000);
});

/**
 * `moduleRenderRecipe` mints `procedural.module.<family>` for every module that
 * ships no `render` block, across the WHOLE family vocabulary — including the
 * five with no bespoke silhouette yet. Those are a known placeholder, and the
 * log said so five times on every re-sync, which is how a real mistyped recipe
 * id gets skipped over.
 */
describe("AssetRegistry module recipe fallback", () => {
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

  it("gives an unmodelled module family the generic module box, silently", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const assets = new AssetRegistry(scene);

    for (const family of ["engine", "generator", "hull", "countermeasure", "sensors"]) {
      expect(assets.getMesh(`procedural.module.${family}`).name).toBe(`master.procedural.module.${family}`);
    }
    expect(warn).not.toHaveBeenCalled();

    assets.dispose();
  });

  it("still warns for a recipe id outside any authored fallback", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const assets = new AssetRegistry(scene);

    expect(assets.getMesh("procedural.nonsense").name).toBe("master.placeholder.procedural.nonsense");
    expect(warn).toHaveBeenCalledWith("[AssetRegistry]", expect.stringContaining('unknown render recipe "procedural.nonsense"'));

    assets.dispose();
  });

  it("keeps a family that HAS a silhouette on its own builder", () => {
    const assets = new AssetRegistry(scene);
    // The laser barrel is a cylinder, not the utility box the tail would build.
    expect(assets.getMesh("procedural.module.laser").getTotalVertices()).not.toBe(
      assets.getMesh("procedural.module.engine").getTotalVertices(),
    );
    assets.dispose();
  });
});

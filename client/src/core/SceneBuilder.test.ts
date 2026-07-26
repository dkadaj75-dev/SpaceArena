import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Color3, NullEngine, Scene, ShaderMaterial, StandardMaterial, type Mesh } from "@babylonjs/core";
import { ConfigService, EventBus, type ConfigEvents } from "@space-arena/shared";
import { BOUNDARY_FRAGMENT, SceneBuilder, type SceneQuality } from "./SceneBuilder.js";

const ARENA = {
  id: "arena.test",
  type: "arena",
  version: 1,
  name: "Test Arena",
  bounds: { shape: "sphere", radius: 90 },
  asteroidPlacements: [],
  spawnPoints: [
    { id: "sp-a", team: 0, position: { x: -20, z: 0 }, heading: 0 },
    { id: "sp-b", team: 1, position: { x: 20, z: 0 }, heading: 3.14 },
  ],
  lighting: { ambientColor: "#1a2233", ambientIntensity: 0.4, directionalIntensity: 0.9 },
  render: {
    skybox: { texture: "skyboxes/test.webp", intensity: 0.8, tint: "#ffffff" },
    boundaryShield: {
      baseOpacity: 0.02,
      glowStartDistance: 30,
      redTransitionDistance: 10,
      warnDistance: 20,
      blueColor: "#39bfff",
      redColor: "#ff405c",
      hexDensity: 30,
      warningNotification: "notification.boundary-warning",
    },
  },
  zones: [],
} satisfies Record<string, unknown>;

function quality(overrides: Partial<SceneQuality> = {}): SceneQuality {
  return {
    glow: { enabled: true, intensity: 0.5 },
    // Zero starfield points: the PointsCloudSystem builds its mesh
    // asynchronously and would land after a test finishes.
    scene: {
      skyboxEnabled: true,
      boundaryShieldShader: true,
      starfieldPoints: 0,
      spawnMarkers: true,
    },
    render: { hardwareScalingMultiplier: 1, maxDevicePixelRatio: 2, freezeStatics: true },
    ...overrides,
  };
}

/** Every static arena mesh except the skybox, which is deliberately never frozen. */
function freezableMeshes(scene: Scene): Mesh[] {
  return scene.meshes.filter((m): m is Mesh => m.name !== "skybox" && "isWorldMatrixFrozen" in m);
}

describe("SceneBuilder static freezing (§10 5.6)", () => {
  let engine: NullEngine;
  let scene: Scene;
  let configs: ConfigService;
  let bus: EventBus<ConfigEvents>;

  beforeEach(async () => {
    engine = new NullEngine();
    scene = new Scene(engine);
    bus = new EventBus<ConfigEvents>();
    configs = new ConfigService(() => Promise.resolve(null), bus);
    expect(
      configs.replace({
        id: "notification.boundary-warning",
        type: "notification",
        version: 1,
        text: "Boundary",
        style: "critical",
        durationMs: 1000,
      }).ok,
    ).toBe(true);
    expect(configs.replace(ARENA).ok).toBe(true);
    await Promise.resolve();
  });

  afterEach(() => {
    scene.dispose();
    engine.dispose();
  });

  it("freezes world matrices and materials once the arena is built", () => {
    const builder = new SceneBuilder(scene, configs, bus, quality());
    builder.buildArena("arena.test");

    expect(builder.staticsFrozen).toBe(true);
    const meshes = freezableMeshes(scene);
    expect(meshes.length).toBeGreaterThan(0);
    for (const mesh of meshes) expect(mesh.isWorldMatrixFrozen).toBe(true);
    for (const mesh of meshes) {
      if (mesh.material && mesh.name !== "boundsShell") expect(mesh.material.isFrozen).toBe(true);
    }

    builder.dispose();
  });

  it("never freezes the skybox — infiniteDistance re-derives it from the camera", () => {
    const builder = new SceneBuilder(scene, configs, bus, quality());
    builder.buildArena("arena.test");

    const skybox = scene.getMeshByName("skybox");
    expect(skybox).not.toBeNull();
    expect(skybox!.isWorldMatrixFrozen).toBe(false);

    builder.dispose();
  });

  it("wires the arena panorama through the /content path", () => {
    const builder = new SceneBuilder(scene, configs, bus, quality());
    builder.buildArena("arena.test");

    const material = scene.getMeshByName("skybox")!.material as StandardMaterial;
    expect(material.emissiveTexture?.name).toBe("/content/skyboxes/test.webp");
    // BLACK until the panorama's onLoad fires: an emissive-only material with
    // an unready non-blocking texture renders its raw emissiveColor as a
    // full-sky wash (and freezing can bake that in). The tint*intensity is
    // applied by the texture's onLoad callback, never at build time.
    expect(material.emissiveColor.r).toBe(0);
    expect(material.emissiveColor.g).toBe(0);
    expect(material.emissiveColor.b).toBe(0);
    expect(material.disableDepthWrite).toBe(true);
    expect(material.emissiveTexture?.isBlocking).toBe(false);
    builder.dispose();
  });

  it("leaves statics unfrozen when the tier says not to", () => {
    const builder = new SceneBuilder(
      scene,
      configs,
      bus,
      quality({ render: { hardwareScalingMultiplier: 1, maxDevicePixelRatio: 2, freezeStatics: false } }),
    );
    builder.buildArena("arena.test");

    expect(builder.staticsFrozen).toBe(false);
    for (const mesh of freezableMeshes(scene)) expect(mesh.isWorldMatrixFrozen).toBe(false);

    builder.dispose();
  });

  it("thaws on hide and re-freezes on show — the editor's arenaRoot toggle", () => {
    const builder = new SceneBuilder(scene, configs, bus, quality());
    builder.buildArena("arena.test");
    const meshes = freezableMeshes(scene);

    // The dev editor hides the arena and stages its own lit content. A frozen
    // material would never recompile for the new light set, so hiding thaws.
    builder.setVisible(false);
    expect(builder.staticsFrozen).toBe(false);
    for (const mesh of meshes) expect(mesh.isWorldMatrixFrozen).toBe(false);
    for (const mesh of meshes) if (mesh.material) expect(mesh.material.isFrozen).toBe(false);
    expect(scene.getTransformNodeByName("arenaRoot")!.isEnabled()).toBe(false);

    builder.setVisible(true);
    expect(builder.staticsFrozen).toBe(true);
    for (const mesh of meshes) expect(mesh.isWorldMatrixFrozen).toBe(true);
    expect(scene.getTransformNodeByName("arenaRoot")!.isEnabled()).toBe(true);

    builder.dispose();
  });

  it("re-freezes a rebuilt arena and keeps the latched visibility", () => {
    const builder = new SceneBuilder(scene, configs, bus, quality());
    builder.buildArena("arena.test");
    builder.setVisible(false);

    // Arena hot-reload while the editor has it hidden.
    expect(configs.replace({ ...ARENA, version: 2 }).ok).toBe(true);
    expect(builder.staticsFrozen).toBe(false);
    expect(scene.getTransformNodeByName("arenaRoot")!.isEnabled()).toBe(false);

    builder.setVisible(true);
    expect(builder.staticsFrozen).toBe(true);
    for (const mesh of freezableMeshes(scene)) expect(mesh.isWorldMatrixFrozen).toBe(true);

    builder.dispose();
  });

  it("drops the glow layer entirely on a tier that disables it", () => {
    const builder = new SceneBuilder(scene, configs, bus, quality());
    builder.buildArena("arena.test");
    expect(scene.effectLayers.length).toBe(1);

    builder.setQuality(quality({ glow: { enabled: false, intensity: 0 } }));
    expect(scene.effectLayers.length).toBe(0);

    builder.setQuality(quality({ glow: { enabled: true, intensity: 0.2 } }));
    expect(scene.effectLayers.length).toBe(1);

    builder.dispose();
  });

  it("rebuilds when a tier changes geometry-baked decoration", () => {
    const builder = new SceneBuilder(scene, configs, bus, quality());
    builder.buildArena("arena.test");
    expect(scene.getMeshByName("spawnMarker.sp-a")).not.toBeNull();

    builder.setQuality(
      quality({
        scene: {
          skyboxEnabled: false,
          boundaryShieldShader: false,
          starfieldPoints: 0,
          spawnMarkers: false,
        },
      }),
    );
    expect(scene.getMeshByName("spawnMarker.sp-a")).toBeNull();
    expect(builder.staticsFrozen).toBe(true);

    builder.dispose();
  });

  /**
   * BUBBLE.md §C: the arena floor is gone. What used to be an equatorial ring
   * (and, before that, a grid disc at y=0) is now a shell around the whole
   * bubble, because a ship can approach the boundary at any latitude.
   */
  it("builds a bounds SHELL at the bubble's radius, not a ring or a floor", () => {
    const builder = new SceneBuilder(scene, configs, bus, quality());
    builder.buildArena("arena.test");

    const shell = scene.getMeshByName("boundsShell");
    expect(shell).not.toBeNull();
    // The shell spans the arena in y as well as x/z — a ring would be flat.
    const extent = shell!.getBoundingInfo().boundingBox.extendSize;
    expect(extent.x).toBeCloseTo(90, 4);
    expect(extent.y).toBeCloseTo(90, 4);
    expect(extent.z).toBeCloseTo(90, 4);

    // Retired with the floor; the invisible pick plane the Map editor needs stays.
    expect(scene.getMeshByName("groundDisc")).toBeNull();
    expect(scene.getMeshByName("boundsRing")).toBeNull();
    expect(scene.getMeshByName("groundPlane")).not.toBeNull();
    expect(scene.getMeshByName("groundPlane")!.isVisible).toBe(false);

    builder.dispose();
  });

  it("uses the hex shader normally and the live plain-shell fallback on low", () => {
    const shaderBuilder = new SceneBuilder(scene, configs, bus, quality());
    shaderBuilder.buildArena("arena.test");
    expect(scene.getMeshByName("boundsShell")!.material).toBeInstanceOf(ShaderMaterial);
    shaderBuilder.dispose();

    expect(configs.replace({
      ...ARENA,
      version: 2,
      render: {
        ...ARENA.render,
        boundaryShield: {
          ...ARENA.render.boundaryShield,
          redTransitionDistance: 18,
        },
      },
    }).ok).toBe(true);
    const lowBuilder = new SceneBuilder(
      scene,
      configs,
      bus,
      quality({
        scene: {
          skyboxEnabled: true,
          boundaryShieldShader: false,
          starfieldPoints: 0,
          spawnMarkers: false,
        },
      }),
    );
    lowBuilder.buildArena("arena.test");
    const material = scene.getMeshByName("boundsShell")!.material as StandardMaterial;
    expect(material).toBeInstanceOf(StandardMaterial);
    expect(lowBuilder.updatePlayerPosition(0, 0, 0)).toBe(90);
    expect(material.alpha).toBeCloseTo(0.02);
    expect(lowBuilder.updatePlayerPosition(89, 0, 0)).toBe(1);
    expect(material.alpha).toBeGreaterThan(0.9);
    expect(material.emissiveColor.r).toBeGreaterThan(material.emissiveColor.b);

    // Exact operator report: at distance 10 with an 18-unit transition the
    // fallback must already be visibly mixed, not remain pure authored blue.
    expect(lowBuilder.updatePlayerPosition(80, 0, 0)).toBe(10);
    const pureBlue = Color3.FromHexString(ARENA.render.boundaryShield.blueColor);
    expect(material.emissiveColor.equals(pureBlue)).toBe(false);
    expect(material.emissiveColor.r).toBeGreaterThan(pureBlue.r);
    lowBuilder.dispose();
  });
});

describe("boundary shader float32 safety contract", () => {
  it("wraps local UV before bounded cell math and clamps pattern before opacity", () => {
    expect(BOUNDARY_FRAGMENT).toContain("precision highp float");
    expect(BOUNDARY_FRAGMENT).toContain("vec2 unitDomain = fract(vUV)");
    expect(BOUNDARY_FRAGMENT).toContain("clamp(hexDensity, 1.0, 128.0)");
    expect(BOUNDARY_FRAGMENT).not.toMatch(/world(Pos|Position)|vWorld/i);
    expect(BOUNDARY_FRAGMENT).toContain("float safePattern = clamp(");
    expect(BOUNDARY_FRAGMENT).toContain("float safeOpacity = clamp(opacity, 0.0, 1.0)");
    expect(BOUNDARY_FRAGMENT).toContain("safePattern * safeOpacity");
  });
});

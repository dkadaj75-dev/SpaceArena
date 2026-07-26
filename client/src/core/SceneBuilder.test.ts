import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  Color3,
  DirectionalLight,
  HemisphericLight,
  NullEngine,
  Scene,
  ShaderMaterial,
  StandardMaterial,
  type Mesh,
} from "@babylonjs/core";
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

/** The boundary notification `ARENA.render.boundaryShield` references. */
const BOUNDARY_NOTIFICATION = {
  id: "notification.boundary-warning",
  type: "notification",
  version: 1,
  text: "Boundary",
  style: "critical",
  durationMs: 1000,
} satisfies Record<string, unknown>;

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
    expect(configs.replace(BOUNDARY_NOTIFICATION).ok).toBe(true);
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

/**
 * The skybox panoramas have a star painted into them, and `render.skybox.sun`
 * promotes it to the arena's real key light (parallel rays along -dir).
 */
describe("SceneBuilder sun key light", () => {
  let engine: NullEngine;
  let scene: Scene;
  let configs: ConfigService;
  let bus: EventBus<ConfigEvents>;

  beforeEach(() => {
    engine = new NullEngine();
    scene = new Scene(engine);
    bus = new EventBus<ConfigEvents>();
    configs = new ConfigService(async () => ({}), bus);
    expect(configs.replace(BOUNDARY_NOTIFICATION).ok).toBe(true);
  });

  afterEach(() => {
    scene.dispose();
    engine.dispose();
  });

  function build(sun: unknown): { dir: DirectionalLight; hemi: HemisphericLight; builder: SceneBuilder } {
    expect(
      configs.replace({
        ...ARENA,
        render: { ...ARENA.render, skybox: { ...ARENA.render.skybox, ...(sun ? { sun } : {}) } },
      }).ok,
    ).toBe(true);
    const builder = new SceneBuilder(scene, configs, bus, quality());
    builder.buildArena("arena.test");
    return {
      dir: scene.getLightByName("arenaDirLight") as DirectionalLight,
      hemi: scene.getLightByName("arenaHemiLight") as HemisphericLight,
      builder,
    };
  }

  it("shines the key light ALONG -dir with the authored colour and intensity", () => {
    // The shipped deep-field star.
    const { dir, builder } = build({ dir: [0.777, 0.309, 0.55], color: "#ffecc8", intensity: 1.1 });
    expect(dir).toBeInstanceOf(DirectionalLight);
    // Parallel rays travelling the opposite way to the bearing of the star, so a
    // lit face points back at it.
    // Re-normalized defensively, so a hand-authored vector 0.1% off unit length
    // (as the shipped one is) does not become a 0.1% intensity error.
    expect(dir.direction.length()).toBeCloseTo(1, 6);
    expect(dir.direction.x).toBeCloseTo(-0.777, 2);
    expect(dir.direction.y).toBeCloseTo(-0.309, 2);
    expect(dir.direction.z).toBeCloseTo(-0.55, 2);
    expect(dir.intensity).toBeCloseTo(1.1, 6);
    const authored = Color3.FromHexString("#ffecc8");
    expect(dir.diffuse.r).toBeCloseTo(authored.r, 4);
    expect(dir.diffuse.g).toBeCloseTo(authored.g, 4);
    expect(dir.diffuse.b).toBeCloseTo(authored.b, 4);
    builder.dispose();
  });

  it("keeps a soft ambient fill, leaning toward the star, so shadows are not black", () => {
    const { hemi, builder } = build({ dir: [-0.677, -0.208, -0.706], color: "#dce4ff", intensity: 1 });
    expect(hemi).toBeInstanceOf(HemisphericLight);
    expect(hemi.intensity).toBeCloseTo(ARENA.lighting.ambientIntensity, 6);
    expect(hemi.intensity).toBeGreaterThan(0);
    // Sky side of the fill faces the star, rather than fighting it from world-up.
    expect(hemi.direction.x).toBeCloseTo(-0.677, 3);
    expect(hemi.direction.y).toBeCloseTo(-0.208, 3);
    builder.dispose();
  });

  it("falls back to the generic rig for an arena with no authored sun", () => {
    const { dir, hemi, builder } = build(null);
    // The pre-sun default rig, unchanged: fixed direction, arena-authored
    // intensity, and world-up ambient.
    expect(dir.intensity).toBeCloseTo(ARENA.lighting.directionalIntensity, 6);
    expect(dir.direction.y).toBeCloseTo(-1, 6);
    expect(hemi.direction.y).toBeCloseTo(1, 6);
    builder.dispose();
  });
});

describe("SceneBuilder spawn markers + editor override", () => {
  let engine: NullEngine;
  let scene: Scene;
  let configs: ConfigService;
  let bus: EventBus<ConfigEvents>;

  beforeEach(() => {
    engine = new NullEngine();
    scene = new Scene(engine);
    bus = new EventBus<ConfigEvents>();
    configs = new ConfigService(async () => ({}), bus);
    expect(configs.replace(BOUNDARY_NOTIFICATION).ok).toBe(true);
    expect(configs.replace(ARENA).ok).toBe(true);
  });

  afterEach(() => {
    scene.dispose();
    engine.dispose();
  });

  /** The shipped tiers all set `spawnMarkers: false` (players must not see them). */
  function shippedQuality(): SceneQuality {
    return quality({
      scene: { skyboxEnabled: true, boundaryShieldShader: true, starfieldPoints: 0, spawnMarkers: false },
    });
  }

  it("draws no spawn gizmos on a shipped tier", () => {
    const builder = new SceneBuilder(scene, configs, bus, shippedQuality());
    builder.buildArena("arena.test");
    expect(scene.getMeshByName("spawnMarker.sp-a")).toBeNull();
    expect(scene.getMeshByName("spawnMarker.sp-b")).toBeNull();
    builder.dispose();
  });

  it("the editor override brings them back, and releasing it hides them again", () => {
    const builder = new SceneBuilder(scene, configs, bus, shippedQuality());
    builder.buildArena("arena.test");

    builder.setSpawnMarkerOverride(true);
    expect(scene.getMeshByName("spawnMarker.sp-a")).not.toBeNull();
    expect(scene.getMeshByName("spawnMarker.sp-b")).not.toBeNull();

    builder.setSpawnMarkerOverride(null);
    expect(scene.getMeshByName("spawnMarker.sp-a")).toBeNull();
    builder.dispose();
  });

  it("survives a quality swap while the editor override is held", () => {
    const builder = new SceneBuilder(scene, configs, bus, shippedQuality());
    builder.buildArena("arena.test");
    builder.setSpawnMarkerOverride(true);
    // A tier change rebuilds the arena; the override must outlive the rebuild or
    // the Quality panel would silently blind the Map editor.
    builder.setQuality(
      quality({
        scene: { skyboxEnabled: false, boundaryShieldShader: false, starfieldPoints: 0, spawnMarkers: false },
      }),
    );
    expect(scene.getMeshByName("spawnMarker.sp-a")).not.toBeNull();
    builder.dispose();
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

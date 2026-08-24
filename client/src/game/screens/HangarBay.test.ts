import { NullEngine, PointLight, Scene, SpotLight, TransformNode } from "@babylonjs/core";
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

  /**
   * Owner 2026-08-22: "more light in the hangar 3D view". The hazard was that
   * brightening a screen that shares the MAIN scene with the arena brightens the
   * arena too, so this pins the containment rather than the numbers: every light
   * hangs off the bay's own root and is range-clamped to it, and the one genuinely
   * scene-wide value the bay touches — the ambient/IBL gain — is handed back on
   * dispose. (The menu diorama sets that gain and does NOT restore it, which is
   * how the hangar came to inherit a night sky's ambient in the first place.)
   */
  it("keeps its brighter rig on the stage, and hands the scene's ambient gain back", () => {
    const parent = new TransformNode("stage", scene);
    // Stand in for what the menu diorama leaves behind on the way in.
    scene.environmentIntensity = 0.35;
    const bay = new HangarBay(scene, parent, { padRadius: 6 });

    // The bay OWNS the ambient for the visit rather than inheriting it.
    expect(scene.environmentIntensity).toBeGreaterThan(1);

    const bayLights = scene.lights.filter((light) => light.parent === bay.root);
    // Four, and not five: the material default is maxSimultaneousLights = 4, so
    // a fifth would evict one rather than add anything.
    expect(bayLights).toHaveLength(4);
    for (const light of bayLights) {
      expect(light instanceof PointLight || light instanceof SpotLight).toBe(true);
      // Range-clamped well inside the ~200-unit gap to the arena, so none of
      // this rig can reach a match staged in the same scene.
      const range = (light as PointLight | SpotLight).range;
      expect(range).toBeGreaterThan(0);
      expect(range).toBeLessThan(100);
      expect(light.intensity).toBeGreaterThan(0);
    }
    // The key must still be the brightest of the two side lights, or the hull
    // stops being SHAPED and just gets flatter.
    const named = (name: string): number => bayLights.find((l) => l.name === name)!.intensity;
    expect(named("hangarBay.key")).toBeGreaterThan(named("hangarBay.rim"));
    expect(named("hangarBay.rim")).toBeGreaterThan(named("hangarBay.bounce"));

    bay.dispose();
    expect(scene.environmentIntensity).toBe(0.35);
    parent.dispose();
  });
});

/**
 * Degraded-context self-heal (2026-08-23). A WebGL1/software/low-uniform
 * context cannot be trusted with the full rig — four punctual lights at the
 * `maxSimultaneousLights` ceiling, PBR+IBL, an ESM shadow map needing a
 * float-renderable target, and a GlowLayer is the permutation most likely to
 * blow `MAX_FRAGMENT_UNIFORM_VECTORS`. Babylon does not complain when a shader
 * fails to link: `Effect.isReady()` stays false and the draw is skipped, so the
 * frame comes out clear-coloured — indistinguishable from a dead renderer.
 *
 * The deliverable is a rig that DRAWS, not a warning.
 */
describe("HangarBay on a degraded context", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);

  afterEach(() => {
    scene.dispose();
  });

  it("clamps the light rig to two and skips the shadow map", () => {
    const parent = new TransformNode("stage", scene);
    const bayLights = () => scene.lights.filter((l) => l.name.startsWith("hangarBay."));

    const full = new HangarBay(scene, parent, { degraded: false });
    expect(bayLights()).toHaveLength(4);
    expect(scene.lights.some((l) => l.getShadowGenerator() !== null)).toBe(true);
    full.dispose();

    const reduced = new HangarBay(scene, parent, { degraded: true });
    expect(bayLights()).toHaveLength(2);
    // Key + overhead: the two that make the hull read at all.
    expect(bayLights().map((l) => l.name).sort()).toEqual(["hangarBay.key", "hangarBay.overhead"]);
    expect(scene.lights.every((l) => l.getShadowGenerator() === null)).toBe(true);
    reduced.dispose();
    parent.dispose();
  });

  it("skips the shadow map when no float render target exists, rig intact", () => {
    // An exponential shadow map REQUIRES a float/half-float renderable target.
    // Asking for one anyway is how a whole material permutation stops linking.
    const parent = new TransformNode("stage", scene);
    const bay = new HangarBay(scene, parent, { floatRenderTargets: false });
    expect(scene.lights.filter((l) => l.name.startsWith("hangarBay."))).toHaveLength(4);
    expect(scene.lights.every((l) => l.getShadowGenerator() === null)).toBe(true);
    bay.dispose();
    parent.dispose();
  });

  it("still disposes cleanly when it never built a shadow generator", () => {
    const parent = new TransformNode("stage", scene);
    const baseline = { materials: scene.materials.length, lights: scene.lights.length };
    const bay = new HangarBay(scene, parent, { degraded: true });
    expect(() => bay.dispose()).not.toThrow();
    expect(scene.materials).toHaveLength(baseline.materials);
    expect(scene.lights).toHaveLength(baseline.lights);
    parent.dispose();
  });
});

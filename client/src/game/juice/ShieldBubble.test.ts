import { NullEngine, Scene, TransformNode, type Mesh, type StandardMaterial } from "@babylonjs/core";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_JUICE_SETTINGS } from "./juiceSettings.js";
import { ShieldBubble } from "./ShieldBubble.js";
import { shieldPanelCount } from "./shieldPanels.js";

/**
 * The hex-panel shield shell (owner rework 2026-08-23), driven on a NullEngine
 * scene. What the panels LOOK like is pixels and untestable; what is pinned
 * here is the machinery around them — one draw call's worth of thin instances,
 * a mesh that only exists once a ship actually raises a shield, and the buffer
 * discipline that keeps ten shells affordable on the low tier.
 */

const settings = DEFAULT_JUICE_SETTINGS.shieldRipple;
const engines: NullEngine[] = [];

afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
});

function makeBubble(over: Partial<typeof settings> = {}, budget = 1): {
  bubble: ShieldBubble;
  scene: Scene;
  mesh: () => Mesh | null;
} {
  const engine = new NullEngine();
  engines.push(engine);
  const scene = new Scene(engine);
  const parent = new TransformNode("ship", scene);
  const bubble = new ShieldBubble(scene, parent, 3, { ...settings, ...over }, "test", budget);
  return { bubble, scene, mesh: () => scene.getMeshByName("shieldbubble.test") as Mesh | null };
}

describe("ShieldBubble", () => {
  it("builds nothing until a ship actually raises a shield", () => {
    const { bubble, mesh } = makeBubble();
    bubble.update(false, 16);
    expect(mesh()).toBeNull();
    expect(bubble.isVisible).toBe(false);
    bubble.dispose();
  });

  it("draws the whole shell as thin instances of ONE hexagon", () => {
    const { bubble, mesh } = makeBubble();
    bubble.update(true, 16);
    const m = mesh()!;
    expect(m).not.toBeNull();
    expect(m.thinInstanceCount).toBe(bubble.panelCount);
    expect(m.isEnabled()).toBe(true);
    // One mesh, so one draw call however many panels the theme asks for.
    expect(m.getTotalVertices()).toBeLessThan(40);
    bubble.dispose();
  });

  it("spends the quality tier's budget on panels", () => {
    const { bubble: full } = makeBubble({}, 1);
    const { bubble: lean } = makeBubble({}, 0.5);
    expect(full.panelCount).toBe(shieldPanelCount(settings.panelCount, 1));
    expect(lean.panelCount).toBe(shieldPanelCount(settings.panelCount, 0.5));
    expect(lean.panelCount).toBeLessThan(full.panelCount);
    full.dispose();
    lean.dispose();
  });

  it("assembles, holds, and hides again on a clean stand-down", () => {
    const { bubble, mesh } = makeBubble();
    bubble.update(true, 16);
    expect(bubble.phase).toBe("assembling");
    for (let t = 0; t < settings.assembleMs; t += 16) bubble.update(true, 16);
    expect(bubble.phase).toBe("up");

    bubble.update(false, 16);
    expect(bubble.phase).toBe("standingDown");
    expect(mesh()!.isEnabled()).toBe(true); // still drawing itself away
    for (let t = 0; t < settings.assembleMs; t += 16) bubble.update(false, 16);
    expect(bubble.phase).toBe("down");
    expect(mesh()!.isEnabled()).toBe(false);
    bubble.dispose();
  });

  it("SHATTERS instead when the reservoir was shot flat", () => {
    const { bubble, mesh } = makeBubble();
    for (let t = 0; t <= settings.assembleMs; t += 16) bubble.update(true, 16);
    bubble.update(false, 16, true);
    expect(bubble.phase).toBe("shattering");
    // The blast outlives a stand-down, and keeps drawing while it runs.
    for (let t = 0; t < settings.assembleMs; t += 16) bubble.update(false, 16, true);
    expect(mesh()!.isEnabled()).toBe(true);
    for (let t = 0; t < settings.shatterMs; t += 16) bubble.update(false, 16, true);
    expect(bubble.phase).toBe("down");
    bubble.dispose();
  });

  it("keeps the theme's transparency and paints the side the ship flies for", () => {
    const { bubble, mesh } = makeBubble();
    bubble.update(true, 16);
    const material = mesh()!.material as StandardMaterial;
    // Same near-invisible idle band the sphere shell was tuned to.
    expect(material.alpha).toBeLessThanOrEqual(settings.impactAlpha);
    const friendlyBlue = material.emissiveColor.b;
    bubble.setRelation("hostile");
    expect(bubble.shownRelation).toBe("hostile");
    bubble.update(true, 16);
    expect(material.emissiveColor.b).toBeLessThan(friendlyBlue);
    expect(material.emissiveColor.r).toBeGreaterThan(0.5);
    bubble.dispose();
  });

  it("flashes brighter the instant an absorb lands", () => {
    const { bubble, mesh } = makeBubble();
    for (let t = 0; t <= settings.assembleMs; t += 16) bubble.update(true, 16);
    const material = mesh()!.material as StandardMaterial;
    const idle = material.alpha;
    bubble.impact();
    bubble.update(true, 16);
    expect(material.alpha).toBeGreaterThan(idle);
    bubble.dispose();
  });

  it("takes a world impact point without blowing up on a bubble that has no mesh yet", () => {
    const { bubble } = makeBubble();
    expect(() => bubble.impact(1, 2, 3)).not.toThrow();
    bubble.update(true, 16);
    expect(() => bubble.impact(1, 2, 3)).not.toThrow();
    bubble.dispose();
  });

  it("draws nothing at all when the theme turns the shell off", () => {
    const { bubble, mesh } = makeBubble({ enabled: false });
    bubble.update(true, 16);
    expect(mesh()).toBeNull();
    bubble.dispose();
  });

  it("rebuilds on a hot-reloaded panel count instead of writing past its buffer", () => {
    const { bubble, mesh } = makeBubble();
    bubble.update(true, 16);
    expect(mesh()!.thinInstanceCount).toBe(bubble.panelCount);
    bubble.setSettings({ ...settings, panelCount: 48 });
    expect(mesh()).toBeNull(); // dropped; the next shield-up builds the new shell
    bubble.update(true, 16);
    expect(bubble.panelCount).toBe(48);
    expect(mesh()!.thinInstanceCount).toBe(48);
    bubble.dispose();
  });

  it("takes its mesh and material with it on dispose", () => {
    const { bubble, mesh } = makeBubble();
    bubble.update(true, 16);
    expect(mesh()).not.toBeNull();
    bubble.dispose();
    expect(mesh()).toBeNull();
  });
});

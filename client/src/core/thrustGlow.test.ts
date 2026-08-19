import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  Color3,
  MeshBuilder,
  MultiMaterial,
  NullEngine,
  PBRMaterial,
  RawTexture,
  Scene,
  type Mesh,
} from "@babylonjs/core";
import {
  applyThrustGlowToMesh,
  mirrorThrustGlow,
  setThrustGlow,
  THRUST_GLOW_ATTRIBUTE,
  THRUST_GLOW_IDLE,
  thrustGlowLevel,
} from "./thrustGlow.js";

describe("thrustGlowLevel", () => {
  it("maps signal 0 → 10% and signal 1 → 100%, clamped", () => {
    expect(thrustGlowLevel(0)).toBeCloseTo(THRUST_GLOW_IDLE);
    expect(thrustGlowLevel(1)).toBeCloseTo(1);
    expect(thrustGlowLevel(0.5)).toBeCloseTo(THRUST_GLOW_IDLE + (1 - THRUST_GLOW_IDLE) * 0.5);
    expect(thrustGlowLevel(-2)).toBeCloseTo(THRUST_GLOW_IDLE);
    expect(thrustGlowLevel(7)).toBeCloseTo(1);
    expect(thrustGlowLevel(undefined)).toBeCloseTo(THRUST_GLOW_IDLE);
  });
});

describe("applyThrustGlowToMesh", () => {
  let engine: NullEngine;
  let scene: Scene;

  beforeEach(() => {
    engine = new NullEngine();
    scene = new Scene(engine);
  });

  afterEach(() => {
    scene.dispose();
    engine.dispose();
  });

  function hullWithSlots(): { mesh: Mesh; hull: PBRMaterial; glow: PBRMaterial } {
    const mesh = MeshBuilder.CreateBox("hull", { size: 1 }, scene);
    const hull = new PBRMaterial("HULL_BODY", scene);
    const glow = new PBRMaterial("ENGINE_GLOW", scene);
    glow.albedoTexture = RawTexture.CreateRGBATexture(new Uint8Array([12, 12, 12, 255]), 1, 1, scene);
    const multi = new MultiMaterial("hull.multi", scene);
    multi.subMaterials = [hull, glow];
    mesh.material = multi;
    return { mesh, hull, glow };
  }

  it("wires the configured slot: albedo as emissive, plugin, instanced buffer with full-glow default", () => {
    const { mesh, hull, glow } = hullWithSlots();
    applyThrustGlowToMesh(mesh, { material: "ENGINE_GLOW" });

    expect(glow.emissiveTexture).toBe(glow.albedoTexture);
    expect(glow.emissiveColor.equals(Color3.White())).toBe(true);
    expect(glow.emissiveIntensity).toBeGreaterThan(1);
    expect(glow.pluginManager?.getPlugin("ThrustGlow")).toBeTruthy();
    expect(hull.pluginManager?.getPlugin("ThrustGlow") ?? null).toBeNull();
    expect(mesh.instancedBuffers[THRUST_GLOW_ATTRIBUTE]).toBe(1);

    // Instances default to full glow (hangar/editor previews) until a sim signal writes them.
    const instance = mesh.createInstance("i0");
    expect(instance.instancedBuffers[THRUST_GLOW_ATTRIBUTE]).toBe(1);
    setThrustGlow(instance, 0);
    expect(instance.instancedBuffers[THRUST_GLOW_ATTRIBUTE]).toBeCloseTo(THRUST_GLOW_IDLE);
    setThrustGlow(instance, 1);
    expect(instance.instancedBuffers[THRUST_GLOW_ATTRIBUTE]).toBeCloseTo(1);
  });

  it("is idempotent and clears a deselected slot without touching never-wired ones", () => {
    const { mesh, glow } = hullWithSlots();
    applyThrustGlowToMesh(mesh, { material: "ENGINE_GLOW" });
    applyThrustGlowToMesh(mesh, { material: "ENGINE_GLOW" });
    expect(glow.pluginManager?.getPlugin("ThrustGlow")).toBeTruthy();

    // None: the previously wired slot goes back to no emissive light.
    applyThrustGlowToMesh(mesh, undefined);
    expect(glow.emissiveTexture).toBeNull();
    expect(glow.emissiveColor.equals(Color3.Black())).toBe(true);
    expect(glow.emissiveIntensity).toBe(1);
  });

  it("does nothing for a hull whose config names no slot", () => {
    const { mesh, glow } = hullWithSlots();
    applyThrustGlowToMesh(mesh, undefined);
    expect(glow.pluginManager?.getPlugin("ThrustGlow") ?? null).toBeNull();
    expect(mesh.instancedBuffers).toBeUndefined();
    // A ship without glow ignores per-frame writes.
    const instance = mesh.createInstance("i0");
    expect(() => setThrustGlow(instance, 1)).not.toThrow();
  });

  it("mirrors wiring onto a paint clone (fresh materials, fresh buffer storage)", () => {
    const { mesh } = hullWithSlots();
    applyThrustGlowToMesh(mesh, { material: "ENGINE_GLOW" });

    const clone = mesh.clone("hull.paint", null, true);
    const multiClone = (mesh.material as MultiMaterial).clone("hull.multi.paint");
    multiClone.subMaterials = (mesh.material as MultiMaterial).subMaterials.map(
      (sub) => sub?.clone(`${sub.name}.paint`) ?? null,
    );
    clone.material = multiClone;

    mirrorThrustGlow(clone, mesh);
    const clonedGlow = multiClone.subMaterials[1] as PBRMaterial;
    expect(clonedGlow.pluginManager?.getPlugin("ThrustGlow")).toBeTruthy();
    expect(clone.instancedBuffers[THRUST_GLOW_ATTRIBUTE]).toBe(1);
  });
});

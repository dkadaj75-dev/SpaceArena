import { Color3, NullEngine, Scene, type BaseTexture } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applySkinAlbedo,
  applySkinEmissive,
  loadSkinTexture,
  resetSkinTextureWarnings,
  warnMissingSkinTexture,
  type TextureSlot,
} from "./skinTexture.js";

/** A stand-in for the image a loader hands back; identity is all that is asserted. */
const IMAGE = { name: "authored" } as unknown as BaseTexture;
const OTHER = { name: "another" } as unknown as BaseTexture;

/** A PBR slot as a glTF hull exposes it: albedo + emissive, no diffuse. */
function pbr(): TextureSlot {
  return {
    name: "SS_Body",
    albedoColor: new Color3(0.6, 0.2, 0.2),
    emissiveColor: new Color3(0, 0, 0),
    albedoTexture: null,
    emissiveTexture: null,
  };
}

afterEach(() => resetSkinTextureWarnings());

describe("applying an authored albedo", () => {
  it("puts the image on whichever colour channel the material has", () => {
    const slot = pbr();
    applySkinAlbedo(slot, IMAGE);
    expect(slot.albedoTexture).toBe(IMAGE);

    const standard: TextureSlot = { diffuseColor: new Color3(1, 0, 0), diffuseTexture: null };
    applySkinAlbedo(standard, IMAGE);
    expect(standard.diffuseTexture).toBe(IMAGE);
  });

  it("neutralises the base-colour factor the map already carries", () => {
    // The Interceptor's plates are tinted by FACTOR with no map at all; left in
    // place it would multiply the owner's repaint into mud.
    const slot = pbr();
    applySkinAlbedo(slot, IMAGE);
    expect(slot.albedoColor!.toHexString().toLowerCase()).toBe("#ffffff");
  });

  it("carries a thrust glow onto the new paint instead of leaving it on the old", () => {
    // render.emissiveGlow wires a slot by setting emissiveTexture = albedoTexture
    // (core/thrustGlow.ts). A repainted nozzle must not glow in the old colour.
    const slot = pbr();
    slot.albedoTexture = OTHER;
    slot.emissiveTexture = OTHER;
    applySkinAlbedo(slot, IMAGE);
    expect(slot.emissiveTexture).toBe(IMAGE);
  });

  it("leaves an INDEPENDENT emissive map alone", () => {
    const slot = pbr();
    slot.albedoTexture = OTHER;
    slot.emissiveTexture = IMAGE;
    applySkinAlbedo(slot, OTHER);
    expect(slot.emissiveTexture).toBe(IMAGE);
  });
});

describe("applying an emissive light map", () => {
  it("lifts a black emissive to white, or the map would emit nothing", () => {
    const slot = pbr();
    applySkinEmissive(slot, IMAGE);
    expect(slot.emissiveTexture).toBe(IMAGE);
    expect(slot.emissiveColor!.toHexString().toLowerCase()).toBe("#ffffff");
  });

  it("keeps an artist's coloured emissive as the map's tint", () => {
    const slot = pbr();
    slot.emissiveColor = new Color3(0.25, 0.6, 1);
    applySkinEmissive(slot, IMAGE);
    expect(slot.emissiveColor!.b).toBeCloseTo(1, 5);
    expect(slot.emissiveColor!.r).toBeCloseTo(0.25, 5);
  });

  it("is inert on a material with no emissive channel at all", () => {
    const flat: TextureSlot = { diffuseColor: new Color3(1, 1, 1) };
    applySkinEmissive(flat, IMAGE);
    expect(flat.emissiveTexture).toBeUndefined();
  });
});

describe("missing files", () => {
  it("reports one path once, however many ships wear it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    warnMissingSkinTexture("ships/textures/talon/ash/body.png");
    warnMissingSkinTexture("ships/textures/talon/ash/body.png");
    warnMissingSkinTexture("ships/textures/talon/ash/wings.png");
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]![0]).toContain("ships/textures/talon/ash/body.png");
    warn.mockRestore();
  });
});

describe("loading", () => {
  it("matches the glTF loader's UV orientation, or the repaint lands upside down", async () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const applied: unknown[] = [];
    const texture = loadSkinTexture(scene, "ships/textures/talon/standard/body.png", (t) => applied.push(t));

    // glTF's UV origin is top-left and Babylon's glTF loader creates its
    // textures with invertY: false; a default Texture would flip the image
    // against the very UVs the owner painted it on.
    expect(texture.invertY).toBe(false);
    // A bespoke unwrap, never a tiling plate.
    expect(texture.wrapU).toBe(0);

    // NullEngine resolves its fake load on a macrotask.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(applied).toEqual([texture]);

    scene.dispose();
    engine.dispose();
  });
});

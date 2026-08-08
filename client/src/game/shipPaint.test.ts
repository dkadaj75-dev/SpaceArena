import { Color3, NullEngine, Scene, StandardMaterial, MeshBuilder } from "@babylonjs/core";
import { describe, expect, it } from "vitest";
import type { ShipSnapshot } from "@space-arena/shared";
import { shopConfigs } from "./__fixtures__/shopContent.js";
import { cosmeticIdOf, paintSlotOf, ShipPaintBank, tintMaterial } from "./shipPaint.js";

const CRIMSON = { primary: "#7a1f2b", accent: "#e0546a", emissive: "#ff8a3d" };

/** A material stand-in with only the channels a tint touches. */
function mockMaterial(over: Partial<Record<"diffuseColor" | "albedoColor" | "emissiveColor", Color3>> = {}) {
  return {
    name: "mat.mock",
    diffuseColor: over.diffuseColor ?? new Color3(0.18, 0.44, 0.72),
    emissiveColor: over.emissiveColor ?? new Color3(0.05, 0.13, 0.15),
    ...(over.albedoColor ? { albedoColor: over.albedoColor } : {}),
  };
}

describe("paint slot roles", () => {
  it("reads engine/trim intent from the material name, index as the fallback", () => {
    expect(paintSlotOf("mat.hull", 0)).toBe("hull");
    expect(paintSlotOf("HUM_LGT_engine_glow", 0)).toBe("glow");
    expect(paintSlotOf("mat.trim", 0)).toBe("trim");
    // A merged hull's first slot is its body; anything after it is detail.
    expect(paintSlotOf("mat.unnamed", 2)).toBe("trim");
  });
});

describe("paint application", () => {
  it("tints albedo on the hull slot and keeps the authored glow STRENGTH", () => {
    const mat = mockMaterial({ emissiveColor: new Color3(0.1, 0.1, 0.1) });
    tintMaterial(mat, "hull", CRIMSON);
    expect(mat.diffuseColor.toHexString().toLowerCase()).toBe("#7a1f2b");
    // #ff8a3d at 0.1 strength — recoloured, not brightened.
    expect(mat.emissiveColor.r).toBeCloseTo(0.1, 5);
    expect(mat.emissiveColor.b).toBeLessThan(mat.emissiveColor.r);
  });

  it("puts the accent on trim slots and the emissive on glow slots", () => {
    const trim = mockMaterial();
    tintMaterial(trim, "trim", CRIMSON);
    expect(trim.diffuseColor.toHexString().toLowerCase()).toBe("#e0546a");

    const glow = mockMaterial({ emissiveColor: new Color3(1, 1, 1) });
    const before = glow.diffuseColor.toHexString();
    tintMaterial(glow, "glow", CRIMSON);
    expect(glow.emissiveColor.toHexString().toLowerCase()).toBe("#ff8a3d");
    // A glow slot recolours light, never the plate under it.
    expect(glow.diffuseColor.toHexString()).toBe(before);
  });

  it("falls back to the accent when a paint authors no emissive", () => {
    const mat = mockMaterial({ emissiveColor: new Color3(1, 1, 1) });
    tintMaterial(mat, "glow", { primary: "#7a1f2b", accent: "#e0546a" });
    expect(mat.emissiveColor.toHexString().toLowerCase()).toBe("#e0546a");
  });

  it("tints a PBR albedo slot as readily as a standard diffuse one", () => {
    const mat = mockMaterial({ albedoColor: new Color3(1, 1, 1) });
    tintMaterial(mat, "hull", CRIMSON);
    expect(mat.albedoColor!.toHexString().toLowerCase()).toBe("#7a1f2b");
  });

  it("ignores a malformed colour rather than blanking the hull", () => {
    const mat = mockMaterial();
    const before = mat.diffuseColor.toHexString();
    tintMaterial(mat, "hull", { primary: "red", accent: "#e0546a" });
    expect(mat.diffuseColor.toHexString()).toBe(before);
  });
});

describe("painted masters", () => {
  function bank(): { bank: ShipPaintBank; scene: Scene; master: ReturnType<typeof MeshBuilder.CreateBox> } {
    const scene = new Scene(new NullEngine());
    const master = MeshBuilder.CreateBox("master.procedural.arrowhead", { size: 1 }, scene);
    const mat = new StandardMaterial("mat.arrowhead", scene);
    mat.diffuseColor = new Color3(0.18, 0.44, 0.72);
    mat.emissiveColor = new Color3(0.05, 0.13, 0.15);
    master.material = mat;
    master.setEnabled(false);
    return { bank: new ShipPaintBank(scene, shopConfigs()), scene, master };
  }

  it("hands the base master back for an absent or unknown cosmetic", () => {
    const { bank: paint, master } = bank();
    expect(paint.masterFor(master, null)).toBe(master);
    expect(paint.masterFor(master, "cosmetic.paint-nope")).toBe(master);
    expect(paint.size).toBe(0);
  });

  it("paints a CLONE and never the base master", () => {
    const { bank: paint, master } = bank();
    const painted = paint.masterFor(master, "cosmetic.paint-crimson");
    expect(painted).not.toBe(master);
    expect((painted.material as StandardMaterial).diffuseColor.toHexString().toLowerCase()).toBe("#7a1f2b");
    // Removal is structural: the unpainted hull is the untouched original.
    expect((master.material as StandardMaterial).diffuseColor.toHexString().toLowerCase()).toBe("#2e70b8");
  });

  it("reuses one master per (hull, paint) so ten ships share one draw batch", () => {
    const { bank: paint, master } = bank();
    const a = paint.masterFor(master, "cosmetic.paint-crimson");
    const b = paint.masterFor(master, "cosmetic.paint-crimson");
    const c = paint.masterFor(master, "cosmetic.paint-lance");
    expect(a).toBe(b);
    expect(c).not.toBe(a);
    expect(paint.size).toBe(2);
  });

  it("disposes every clone and leaves the base master alive", () => {
    const { bank: paint, master, scene } = bank();
    const painted = paint.masterFor(master, "cosmetic.paint-crimson");
    const paintedMaterial = painted.material!;
    paint.dispose();
    expect(painted.isDisposed()).toBe(true);
    // A disposed material leaves the scene registry; the base's stays.
    expect(scene.materials).not.toContain(paintedMaterial);
    expect(master.isDisposed()).toBe(false);
    expect(scene.materials).toContain(master.material);
    expect(paint.size).toBe(0);
  });
});

describe("snapshot cosmetic id", () => {
  it("reads the replicated id and treats absent/blank as standard", () => {
    expect(cosmeticIdOf({ id: 1, cosmeticId: "cosmetic.paint-crimson" } as unknown as ShipSnapshot)).toBe(
      "cosmetic.paint-crimson",
    );
    expect(cosmeticIdOf({ id: 1 } as unknown as ShipSnapshot)).toBeNull();
    expect(cosmeticIdOf({ id: 1, cosmeticId: "" } as unknown as ShipSnapshot)).toBeNull();
  });
});

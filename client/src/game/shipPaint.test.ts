import { Color3, MultiMaterial, NullEngine, Scene, StandardMaterial, MeshBuilder, type BaseTexture, type Mesh } from "@babylonjs/core";
import { describe, expect, it } from "vitest";
import type { ShipSnapshot } from "@space-arena/shared";
import { COSMETICS, shopConfigs, TARGETED_COSMETICS } from "./__fixtures__/shopContent.js";
import { cosmeticIdOf, paintSlotOf, ShipPaintBank, slotPlanFor, tintMaterial } from "./shipPaint.js";

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
    return { bank: new ShipPaintBank(scene, shopConfigs([...COSMETICS, ...TARGETED_COSMETICS])), scene, master };
  }

  it("hands the base master back for an absent or unknown cosmetic", () => {
    const { bank: paint, master } = bank();
    expect(paint.masterFor(master, null)).toBe(master);
    expect(paint.masterFor(master, "cosmetic.paint-nope")).toBe(master);
    expect(paint.masterFor(master, "cosmetic.paint-interceptor-standard")).toBe(master);
    expect(paint.size).toBe(0);
  });

  it("paints a CLONE and never the base master", () => {
    const { bank: paint, master } = bank();
    const painted = paint.masterFor(master, "cosmetic.paint-interceptor-crimson");
    expect(painted).not.toBe(master);
    expect((painted.material as StandardMaterial).diffuseColor.toHexString().toLowerCase()).toBe("#7a1f2b");
    // Removal is structural: the unpainted hull is the untouched original.
    expect((master.material as StandardMaterial).diffuseColor.toHexString().toLowerCase()).toBe("#2e70b8");
  });

  it("reuses one master per (hull, paint) so ten ships share one draw batch", () => {
    const { bank: paint, master } = bank();
    const a = paint.masterFor(master, "cosmetic.paint-interceptor-crimson");
    const b = paint.masterFor(master, "cosmetic.paint-interceptor-crimson");
    const c = paint.masterFor(master, "cosmetic.paint-interceptor-lance");
    expect(a).toBe(b);
    expect(c).not.toBe(a);
    expect(paint.size).toBe(2);
  });

  it("preserves the authored LOD ladder on painted masters", () => {
    const { bank: paint, master, scene } = bank();
    const lod = MeshBuilder.CreateBox("ship.lod2", { size: 0.5 }, scene);
    lod.material = master.material;
    lod.setEnabled(true);
    lod.isVisible = false;
    master.addLODLevel(90, lod);
    const painted = paint.masterFor(master, "cosmetic.paint-interceptor-crimson");
    expect(painted.getLODLevels().map((level) => level.distanceOrScreenCoverage)).toEqual([90]);
    expect(painted.getLODLevels()[0]!.mesh).not.toBe(lod);
    paint.dispose();
  });

  it("disposes every clone and leaves the base master alive", () => {
    const { bank: paint, master, scene } = bank();
    const painted = paint.masterFor(master, "cosmetic.paint-interceptor-crimson");
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
    expect(cosmeticIdOf({ id: 1, cosmeticId: "cosmetic.paint-interceptor-crimson" } as unknown as ShipSnapshot)).toBe(
      "cosmetic.paint-interceptor-crimson",
    );
    expect(cosmeticIdOf({ id: 1 } as unknown as ShipSnapshot)).toBeNull();
    expect(cosmeticIdOf({ id: 1, cosmeticId: "" } as unknown as ShipSnapshot)).toBeNull();
  });
});

describe("authored material targeting", () => {
  const targeted = {
    materials: [
      { material: "SHELL_WHITE", channel: "primary" as const },
      { material: "trim_plate", channel: "accent" as const, patterned: true },
    ],
  };

  it("reads the channel off the authored list, not off the material name", () => {
    // "trim_plate" would be trim by name anyway; "SHELL_WHITE" would NOT be
    // primary by index if it landed anywhere but slot 0. The list decides.
    expect(slotPlanFor(targeted, "SHELL_WHITE", 4)).toEqual({ slot: "hull", patterned: false });
    expect(slotPlanFor(targeted, "trim_plate", 0)).toEqual({ slot: "trim", patterned: true });
  });

  it("matches material names case-insensitively", () => {
    expect(slotPlanFor(targeted, "shell_white", 0).slot).toBe("hull");
  });

  it("leaves every material the list does not name completely alone", () => {
    expect(slotPlanFor(targeted, "CANOPY_GLASS", 0)).toEqual({ slot: "none", patterned: false });
    expect(slotPlanFor(targeted, "ENGINE_GLOW", 1)).toEqual({ slot: "none", patterned: false });
    // An EMPTY list is still a list: it paints nothing at all.
    expect(slotPlanFor({ materials: [] }, "SHELL_WHITE", 0).slot).toBe("none");
  });

  it("falls back to the name heuristics when a paint names no materials", () => {
    expect(slotPlanFor({}, "HUM_engine_glow", 0)).toEqual({ slot: "glow", patterned: false });
    expect(slotPlanFor({}, "mat.hull", 0)).toEqual({ slot: "hull", patterned: false });
  });

  it("is a no-op on an untargeted slot", () => {
    const mat = mockMaterial();
    const before = { diffuse: mat.diffuseColor.toHexString(), emissive: mat.emissiveColor.toHexString() };
    tintMaterial(mat, "none", CRIMSON);
    expect(mat.diffuseColor.toHexString()).toBe(before.diffuse);
    expect(mat.emissiveColor.toHexString()).toBe(before.emissive);
  });

  it("keeps an authored hull tint out of the emissive channel", () => {
    // The glow bleed exists for one-slot procedural recipes. A paint that NAMES
    // its materials means that plate and nothing else — including its glow.
    const mat = mockMaterial({ emissiveColor: new Color3(0.4, 0.4, 0.4) });
    tintMaterial(mat, "hull", CRIMSON, { bleedGlow: false });
    expect(mat.diffuseColor.toHexString().toLowerCase()).toBe("#7a1f2b");
    expect(mat.emissiveColor.toHexString()).toBe(new Color3(0.4, 0.4, 0.4).toHexString());
  });
});

describe("painting a multi-material hull", () => {
  /** A merged GLB hull: one MultiMaterial, one slot per authored material. */
  function multiHull(): { bank: ShipPaintBank; master: Mesh; slots: StandardMaterial[] } {
    const scene = new Scene(new NullEngine());
    const master = MeshBuilder.CreateBox("master.human_light", { size: 1 }, scene);
    const names = ["SHELL_WHITE", "CANOPY_GLASS", "ENGINE_GLOW"];
    const slots = names.map((name, index) => {
      const mat = new StandardMaterial(name, scene);
      mat.diffuseColor = new Color3(0.8, 0.8, 0.8);
      mat.emissiveColor = index === 2 ? new Color3(0.2, 0.5, 1) : new Color3(0, 0, 0);
      return mat;
    });
    const multi = new MultiMaterial("hull.multi", scene);
    multi.subMaterials = slots;
    master.material = multi;
    master.setEnabled(false);
    return { bank: new ShipPaintBank(scene, shopConfigs([...COSMETICS, ...TARGETED_COSMETICS])), master, slots };
  }

  it("tints only the named material and SHARES the untouched ones with the base", () => {
    const { bank, master, slots } = multiHull();
    const painted = bank.masterFor(master, "cosmetic.paint-interceptor-shellonly");
    const subs = (painted.material as MultiMaterial).subMaterials as StandardMaterial[];

    expect(subs[0]!.diffuseColor.toHexString().toLowerCase()).toBe("#c81f2b");
    // Not a tinted copy, not a copy at all: the canopy and the engine bloom are
    // the very same material objects the unpainted hull draws with.
    expect(subs[1]).toBe(slots[1]);
    expect(subs[2]).toBe(slots[2]);
    // And the base master's own shell is untouched.
    expect(slots[0]!.diffuseColor.toHexString().toLowerCase()).toBe("#cccccc");
    bank.dispose();
  });

  it("never lets an authored paint brighten an untargeted engine glow", () => {
    const { bank, master, slots } = multiHull();
    const before = slots[2]!.emissiveColor.toHexString();
    const painted = bank.masterFor(master, "cosmetic.paint-interceptor-shellonly");
    const subs = (painted.material as MultiMaterial).subMaterials as StandardMaterial[];
    expect(subs[2]!.emissiveColor.toHexString()).toBe(before);
    bank.dispose();
  });

  it("still colours the targeted plate when a patterned paint cannot draw its texture", () => {
    // Headless hosts have no 2D canvas, so the zebra stripes cannot be drawn.
    // A skin that degrades to its flat primary is duller; a hull that renders
    // untinted (or not at all) is a bug.
    const { bank, master } = multiHull();
    const painted = bank.masterFor(master, "cosmetic.paint-interceptor-zebra");
    const subs = (painted.material as MultiMaterial).subMaterials as StandardMaterial[];
    const shell = subs[0]!;
    const drewStripes = shell.diffuseTexture !== null;
    expect(shell.diffuseColor.toHexString().toLowerCase()).toBe(drewStripes ? "#ffffff" : "#f2f2f0");
    bank.dispose();
  });
});

describe("surface finish", () => {
  const LACQUER = { primary: "#e00d1e", accent: "#ff8a6a", finish: { gloss: 0.9, metallic: 0.3, clearcoat: 0.8 } };

  /** A PBR stand-in: the channels a glTF hull actually exposes. */
  function pbr() {
    return {
      name: "SHELL",
      albedoColor: new Color3(0.82, 0.83, 0.84),
      emissiveColor: new Color3(0, 0, 0),
      roughness: 0.38,
      metallic: 0,
      clearCoat: { isEnabled: true, intensity: 0.2, roughness: 0.1 },
    };
  }

  it("turns gloss into roughness and drives metal and lacquer", () => {
    const mat = pbr();
    tintMaterial(mat, "hull", LACQUER, { bleedGlow: false });
    expect(mat.roughness).toBeCloseTo(0.1, 5);
    expect(mat.metallic).toBeCloseTo(0.3, 5);
    expect(mat.clearCoat.intensity).toBeCloseTo(0.8, 5);
    // The coat is glass whatever the colour under it does — that is the streak.
    expect(mat.clearCoat.roughness).toBeLessThan(0.1);
  });

  it("keeps the artist's surface for a paint that authors no finish", () => {
    const mat = pbr();
    tintMaterial(mat, "hull", { primary: "#e00d1e", accent: "#ff8a6a" }, { bleedGlow: false });
    expect(mat.albedoColor.toHexString().toLowerCase()).toBe("#e00d1e");
    expect(mat.roughness).toBe(0.38);
    expect(mat.metallic).toBe(0);
    expect(mat.clearCoat.intensity).toBe(0.2);
  });

  it("leaves an unmentioned channel alone rather than zeroing it", () => {
    const mat = pbr();
    tintMaterial(mat, "hull", { primary: "#e00d1e", accent: "#ff8a6a", finish: { gloss: 0.5 } }, { bleedGlow: false });
    expect(mat.roughness).toBeCloseTo(0.5, 5);
    expect(mat.metallic).toBe(0);
    expect(mat.clearCoat.intensity).toBe(0.2);
  });

  it("gives a StandardMaterial the equivalent specular, since it has no roughness", () => {
    const mat = { name: "mat.arrowhead", diffuseColor: new Color3(1, 1, 1), specularColor: new Color3(0, 0, 0), specularPower: 32 };
    tintMaterial(mat, "hull", LACQUER, { bleedGlow: false });
    expect(mat.specularPower).toBeGreaterThan(150);
    expect(mat.specularColor.r).toBeGreaterThan(0.8);
  });

  it("applies under a pattern too — corrosion has to be able to read as matte", () => {
    const mat = { ...pbr(), albedoTexture: null as BaseTexture | null };
    const stripes = { name: "rust" } as unknown as BaseTexture;
    tintMaterial(mat, "hull", { primary: "#9a6b4a", accent: "#4a3325", finish: { gloss: 0.12 } }, {
      bleedGlow: false,
      texture: stripes,
    });
    expect(mat.albedoTexture).toBe(stripes);
    expect(mat.roughness).toBeCloseTo(0.88, 5);
  });
});

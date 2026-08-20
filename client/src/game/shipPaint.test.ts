import { Color3, MultiMaterial, NullEngine, Scene, StandardMaterial, MeshBuilder, type Mesh } from "@babylonjs/core";
import { describe, expect, it } from "vitest";
import type { ShipConfig, ShipSnapshot } from "@space-arena/shared";
import { COSMETICS, RENDER_COSMETICS, shopConfigs } from "./__fixtures__/shopContent.js";
import { applyElementStyle, cosmeticIdOf, propulsionEffectFor, ShipPaintBank } from "./shipPaint.js";

const CANDY = { color: "#c81f2b", finish: { gloss: 0.9, metallic: 0.3, clearcoat: 0.8, glow: 0.2 } };

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

/**
 * The hull the element tests wire: the Interceptor's real material set, with
 * only its shell plates declared as `body`. Canopy and bloom are wired to their
 * own elements — reachable, but only if a skin fills them in.
 */
const WIRED: Pick<ShipConfig, "skin"> = {
  skin: {
    body: ["SHELL_WHITE"],
    canopy: ["CANOPY_GLASS"],
    emissive: ["ENGINE_GLOW"],
    propulsion: ["eng-l", "eng-r"],
  },
};

describe("element style application", () => {
  it("tints the albedo and gives the plate its surface", () => {
    const mat = pbr();
    applyElementStyle(mat, CANDY);
    expect(mat.albedoColor.toHexString().toLowerCase()).toBe("#c81f2b");
    expect(mat.roughness).toBeCloseTo(0.1, 5);
    expect(mat.metallic).toBeCloseTo(0.3, 5);
    expect(mat.clearCoat.intensity).toBeCloseTo(0.8, 5);
    // The coat is glass whatever the colour under it does — that is the streak.
    expect(mat.clearCoat.roughness).toBeLessThan(0.1);
  });

  it("lights the plate in its OWN hue, at the authored strength", () => {
    const mat = pbr();
    applyElementStyle(mat, CANDY);
    // #c81f2b at 0.2 — the paint's colour, not the model's dead emissive.
    expect(mat.emissiveColor.r).toBeGreaterThan(mat.emissiveColor.g);
    expect(mat.emissiveColor.r).toBeCloseTo(Color3.FromHexString("#c81f2b").r * 0.2, 5);
  });

  it("keeps the artist's surface for a style that authors no finish", () => {
    const mat = pbr();
    applyElementStyle(mat, { color: "#c81f2b" });
    expect(mat.albedoColor.toHexString().toLowerCase()).toBe("#c81f2b");
    expect(mat.roughness).toBe(0.38);
    expect(mat.metallic).toBe(0);
    expect(mat.clearCoat.intensity).toBe(0.2);
    expect(mat.emissiveColor.toHexString()).toBe(new Color3(0, 0, 0).toHexString());
  });

  it("leaves an unmentioned finish channel alone rather than zeroing it", () => {
    const mat = pbr();
    applyElementStyle(mat, { color: "#c81f2b", finish: { gloss: 0.5 } });
    expect(mat.roughness).toBeCloseTo(0.5, 5);
    expect(mat.metallic).toBe(0);
    expect(mat.clearCoat.intensity).toBe(0.2);
  });

  it("gives a StandardMaterial the equivalent specular, since it has no roughness", () => {
    const mat = { name: "mat.arrowhead", diffuseColor: new Color3(1, 1, 1), specularColor: new Color3(0, 0, 0), specularPower: 32 };
    applyElementStyle(mat, CANDY);
    expect(mat.specularPower).toBeGreaterThan(150);
    expect(mat.specularColor.r).toBeGreaterThan(0.8);
  });

  it("neutralises the tint under an albedo map, which already carries its colours", () => {
    const mat = { ...pbr(), albedoTexture: null as unknown as never };
    const map = { name: "stripes" } as unknown as never;
    applyElementStyle(mat, { color: "#c81f2b" }, { albedo: map });
    expect(mat.albedoTexture).toBe(map);
    expect(mat.albedoColor.toHexString().toLowerCase()).toBe("#ffffff");
  });

  it("ignores a malformed colour rather than blanking the hull", () => {
    const mat = pbr();
    const before = mat.albedoColor.toHexString();
    applyElementStyle(mat, { color: "red" });
    expect(mat.albedoColor.toHexString()).toBe(before);
  });
});

describe("painted masters", () => {
  /** A merged GLB hull: one MultiMaterial, one slot per authored material. */
  function multiHull(): { bank: ShipPaintBank; master: Mesh; slots: StandardMaterial[]; scene: Scene } {
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
    return { bank: new ShipPaintBank(scene, shopConfigs([...COSMETICS, ...RENDER_COSMETICS])), master, slots, scene };
  }

  it("hands the base master back for an absent, unknown or standard skin", () => {
    const { bank, master } = multiHull();
    expect(bank.masterFor(master, WIRED, null)).toBe(master);
    expect(bank.masterFor(master, WIRED, "cosmetic.paint-nope")).toBe(master);
    expect(bank.masterFor(master, WIRED, "cosmetic.paint-interceptor-standard")).toBe(master);
    expect(bank.size).toBe(0);
  });

  it("paints only the wired element and SHARES every other material with the base", () => {
    const { bank, master, slots } = multiHull();
    const painted = bank.masterFor(master, WIRED, "cosmetic.paint-interceptor-shellonly");
    const subs = (painted.material as MultiMaterial).subMaterials as StandardMaterial[];

    expect(subs[0]!.diffuseColor.toHexString().toLowerCase()).toBe("#c81f2b");
    // Not a tinted copy, not a copy at all: the canopy and the engine bloom are
    // the very same material objects the unpainted hull draws with, because
    // this skin fills neither element in.
    expect(subs[1]).toBe(slots[1]);
    expect(subs[2]).toBe(slots[2]);
    // And the base master's own shell is untouched.
    expect(slots[0]!.diffuseColor.toHexString().toLowerCase()).toBe("#cccccc");
    bank.dispose();
  });

  it("refuses to paint a hull that wires nothing, however full the skin is", () => {
    // The gate that makes the Ship tool meaningful: a skin cannot reach a hull
    // whose elements are unwired, and the master comes back untouched.
    const { bank, master } = multiHull();
    expect(bank.masterFor(master, { skin: undefined }, "cosmetic.paint-interceptor-shellonly")).toBe(master);
    expect(bank.masterFor(master, { skin: { body: [] } }, "cosmetic.paint-interceptor-shellonly")).toBe(master);
    expect(bank.size).toBe(0);
  });

  it("matches wired material names case-insensitively", () => {
    const { bank, master } = multiHull();
    const painted = bank.masterFor(master, { skin: { body: ["shell_white"] } }, "cosmetic.paint-interceptor-shellonly");
    expect(painted).not.toBe(master);
    bank.dispose();
  });

  it("never lets a skin brighten an element it does not fill in", () => {
    const { bank, master, slots } = multiHull();
    const before = slots[2]!.emissiveColor.toHexString();
    const painted = bank.masterFor(master, WIRED, "cosmetic.paint-interceptor-shellonly");
    const subs = (painted.material as MultiMaterial).subMaterials as StandardMaterial[];
    expect(subs[2]!.emissiveColor.toHexString()).toBe(before);
    bank.dispose();
  });

  it("reuses one master per (hull, skin) so ten ships share one draw batch", () => {
    const { bank, master } = multiHull();
    const a = bank.masterFor(master, WIRED, "cosmetic.paint-interceptor-shellonly");
    const b = bank.masterFor(master, WIRED, "cosmetic.paint-interceptor-shellonly");
    const c = bank.masterFor(master, WIRED, "cosmetic.paint-interceptor-crimson");
    expect(a).toBe(b);
    expect(c).not.toBe(a);
    expect(bank.size).toBe(2);
    bank.dispose();
  });

  it("still colours the plate when a patterned skin cannot draw its texture", () => {
    // Headless hosts have no 2D canvas, so the stripes cannot be drawn. A skin
    // that degrades to its flat colour is duller; a hull that renders untinted
    // (or not at all) is a bug.
    const { bank, master } = multiHull();
    const painted = bank.masterFor(master, WIRED, "cosmetic.paint-interceptor-zebra");
    const shell = ((painted.material as MultiMaterial).subMaterials as StandardMaterial[])[0]!;
    const drewStripes = shell.diffuseTexture !== null;
    expect(shell.diffuseColor.toHexString().toLowerCase()).toBe(drewStripes ? "#ffffff" : "#f2f2f0");
    bank.dispose();
  });

  it("preserves the authored LOD ladder on painted masters", () => {
    const { bank, master, scene } = multiHull();
    const lod = MeshBuilder.CreateBox("ship.lod2", { size: 0.5 }, scene);
    lod.material = master.material;
    lod.setEnabled(true);
    lod.isVisible = false;
    master.addLODLevel(90, lod);
    const painted = bank.masterFor(master, WIRED, "cosmetic.paint-interceptor-shellonly");
    expect(painted.getLODLevels().map((level) => level.distanceOrScreenCoverage)).toEqual([90]);
    expect(painted.getLODLevels()[0]!.mesh).not.toBe(lod);
    bank.dispose();
  });

  it("disposes every clone and leaves the base master alive", () => {
    const { bank, master, slots, scene } = multiHull();
    const painted = bank.masterFor(master, WIRED, "cosmetic.paint-interceptor-shellonly");
    const paintedMaterial = painted.material!;
    bank.dispose();
    expect(painted.isDisposed()).toBe(true);
    // A disposed material leaves the scene registry; the base's stays.
    expect(scene.materials).not.toContain(paintedMaterial);
    expect(master.isDisposed()).toBe(false);
    // A merged hull's material is a MultiMaterial, which Babylon keeps in its
    // own registry rather than in scene.materials.
    expect(scene.multiMaterials).toContain(master.material);
    expect(scene.materials).toEqual(expect.arrayContaining(slots));
    expect(bank.size).toBe(0);
  });

  it("invalidates one skin's masters so the editor's preview re-stages", () => {
    const { bank, master } = multiHull();
    bank.masterFor(master, WIRED, "cosmetic.paint-interceptor-shellonly");
    bank.masterFor(master, WIRED, "cosmetic.paint-interceptor-crimson");
    bank.invalidate("cosmetic.paint-interceptor-shellonly");
    expect(bank.size).toBe(1);
    bank.dispose();
  });
});

describe("propulsion swap", () => {
  const skin = { elements: { propulsion: { effect: "fx.boost-trail" } } };

  it("replaces the effect on the sockets this hull wires to propulsion", () => {
    expect(propulsionEffectFor(WIRED, skin, "eng-l")).toBe("fx.boost-trail");
    expect(propulsionEffectFor(WIRED, skin, "eng-r")).toBe("fx.boost-trail");
  });

  it("leaves every other emitter alone — damage smoke is not propulsion", () => {
    expect(propulsionEffectFor(WIRED, skin, "smoke-hull")).toBeNull();
    expect(propulsionEffectFor(WIRED, skin, "boost-plume")).toBeNull();
  });

  it("is inert for a skin with no propulsion, or a hull that wires none", () => {
    expect(propulsionEffectFor(WIRED, { elements: {} }, "eng-l")).toBeNull();
    expect(propulsionEffectFor({ skin: undefined }, skin, "eng-l")).toBeNull();
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

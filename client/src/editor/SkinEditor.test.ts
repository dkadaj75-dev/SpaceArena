import { NullEngine, Scene } from "@babylonjs/core";
import { describe, expect, it, vi } from "vitest";
import type { ConfigService, CosmeticConfig, ShipConfig } from "@space-arena/shared";
import type { EditorHost } from "./EditorShell.js";
import { materialRows, newSkinFor, SkinEditor, withMaterialChannel, withMaterialPatterned } from "./SkinEditor.js";

const SHIP = {
  id: "ship.interceptor",
  type: "ship",
  version: 3,
  name: "Interceptor",
  class: "light",
  sockets: [],
  defaultFitting: [],
  render: { recipe: "procedural.arrowhead", palette: { primary: "#2f6fb8", accent: "#57d8ff" } },
} as unknown as ShipConfig;

function skin(over: Partial<CosmeticConfig> = {}): CosmeticConfig {
  return {
    id: "cosmetic.paint-interceptor-zebra",
    type: "cosmetic",
    version: 2,
    name: "Zebra",
    kind: "paint",
    price: 0,
    target: "ship.interceptor",
    paint: { primary: "#f2f2f0", accent: "#1b1c20", pattern: "zebra", patternColor: "#16171b" },
    materials: [{ material: "HUM_LGT_Shell_White", channel: "primary", patterned: true }],
    ...over,
  } as CosmeticConfig;
}

const MODEL_MATERIALS = ["HUM_LGT_Shell_White", "HUM_LGT_Canopy_Glass", "HUM_LGT_Emissive_Blue"];

describe("material rows", () => {
  it("lists every material of the model, painted or not", () => {
    expect(materialRows(skin(), MODEL_MATERIALS)).toEqual([
      { material: "HUM_LGT_Shell_White", channel: "primary", patterned: true, missing: false },
      { material: "HUM_LGT_Canopy_Glass", channel: null, patterned: false, missing: false },
      { material: "HUM_LGT_Emissive_Blue", channel: null, patterned: false, missing: false },
    ]);
  });

  it("surfaces a target the model no longer has rather than dropping it silently", () => {
    const rows = materialRows(skin({ materials: [{ material: "OLD_HULL", channel: "primary" }] }), MODEL_MATERIALS);
    expect(rows.at(-1)).toEqual({ material: "OLD_HULL", channel: "primary", patterned: false, missing: true });
  });

  it("shows an untargeted paint as painting nothing, whatever its names suggest", () => {
    // `materials` absent = the old name-guessing fallback. The table must not
    // pretend the guesses are authored assignments.
    const rows = materialRows(skin({ materials: undefined }), MODEL_MATERIALS);
    expect(rows.every((row) => row.channel === null)).toBe(true);
  });
});

describe("editing material targets", () => {
  it("assigns a channel and leaves every other material alone", () => {
    const next = withMaterialChannel(skin(), "HUM_LGT_Canopy_Glass", "accent");
    expect(next.materials).toEqual([
      { material: "HUM_LGT_Shell_White", channel: "primary", patterned: true },
      { material: "HUM_LGT_Canopy_Glass", channel: "accent" },
    ]);
  });

  it("re-channels a material in place, keeping its pattern flag", () => {
    const next = withMaterialChannel(skin(), "hum_lgt_shell_white", "accent");
    expect(next.materials).toEqual([{ material: "hum_lgt_shell_white", channel: "accent", patterned: true }]);
  });

  it("clearing a channel drops the material from the list entirely", () => {
    expect(withMaterialChannel(skin(), "HUM_LGT_Shell_White", null).materials).toEqual([]);
  });

  it("turns an untargeted paint into an explicit one on the first assignment", () => {
    const next = withMaterialChannel(skin({ materials: undefined }), "HUM_LGT_Shell_White", "primary");
    expect(next.materials).toEqual([{ material: "HUM_LGT_Shell_White", channel: "primary" }]);
  });

  it("toggles the pattern only on a material the paint already targets", () => {
    expect(withMaterialPatterned(skin(), "HUM_LGT_Shell_White", false).materials).toEqual([
      { material: "HUM_LGT_Shell_White", channel: "primary" },
    ]);
    const untouched = skin();
    expect(withMaterialPatterned(untouched, "HUM_LGT_Canopy_Glass", true)).toBe(untouched);
  });
});

describe("new skins", () => {
  it("starts targeting nothing, so the designer opts each plate in", () => {
    const fresh = newSkinFor(SHIP, []);
    expect(fresh.materials).toEqual([]);
    expect(fresh.target).toBe("ship.interceptor");
  });

  it("does not collide with an id already in the pack", () => {
    expect(newSkinFor(SHIP, ["cosmetic.paint-interceptor-custom-1"]).id).toBe("cosmetic.paint-interceptor-custom-2");
  });
});

describe("SkinEditor panel", () => {
  function host(cosmetics: CosmeticConfig[]): { host: EditorHost; replace: ReturnType<typeof vi.fn> } {
    const replace = vi.fn(() => ({ ok: true as const, errors: [] }));
    const configService = {
      get: (type: string, id: string) => (type === "ship" && id === SHIP.id ? SHIP : undefined),
      getAll: (type: string) => (type === "ship" ? [SHIP] : type === "cosmetic" ? cosmetics : []),
      replace,
    } as unknown as ConfigService;
    return { host: { scene: new Scene(new NullEngine()), configService } as unknown as EditorHost, replace };
  }

  it("offers a channel dropdown per material and commits the pick", () => {
    const { host: editorHost, replace } = host([skin({ materials: [] })]);
    const panel = new SkinEditor(editorHost, vi.fn());
    // The procedural preview hull has one material slot, so that is the row.
    const rows = panel.element.querySelectorAll<HTMLTableRowElement>("tr[data-material]");
    expect(rows.length).toBeGreaterThan(0);

    const select = rows[0]!.querySelector("select")!;
    expect([...select.options].map((option) => option.value)).toEqual(["", "primary", "accent", "emissive"]);
    select.value = "primary";
    select.dispatchEvent(new Event("change"));

    expect(replace).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "cosmetic.paint-interceptor-zebra",
        materials: [{ material: rows[0]!.dataset["material"], channel: "primary" }],
      }),
    );
    panel.dispose();
  });

  it("warns when a paint has no material list at all", () => {
    const { host: editorHost } = host([skin({ materials: undefined })]);
    const panel = new SkinEditor(editorHost, vi.fn());
    expect(panel.element.querySelector(".ed-warn")?.textContent).toContain("guessing roles from material names");
    panel.dispose();
  });

  it("commits a colour edit through ConfigService", () => {
    const { host: editorHost, replace } = host([skin()]);
    const panel = new SkinEditor(editorHost, vi.fn());
    const color = panel.element.querySelector<HTMLInputElement>('input[type="color"]')!;
    color.value = "#123456";
    color.dispatchEvent(new Event("change"));
    expect(replace).toHaveBeenCalledWith(expect.objectContaining({ paint: expect.objectContaining({ primary: "#123456" }) }));
    panel.dispose();
  });
});

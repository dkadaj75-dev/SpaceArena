import { NullEngine, Scene } from "@babylonjs/core";
import { describe, expect, it, vi } from "vitest";
import type { ConfigService, CosmeticConfig, ShipConfig } from "@space-arena/shared";
import type { EditorHost } from "./EditorShell.js";
import {
  DEFAULT_FINISH,
  elementRows,
  newSkinFor,
  SkinEditor,
  withElementStyle,
  withElementTexture,
  withEmissiveTexture,
  withPropulsionEffect,
} from "./SkinEditor.js";

const SHIP = {
  id: "ship.interceptor",
  type: "ship",
  version: 4,
  name: "Interceptor",
  class: "light",
  sockets: [],
  defaultFitting: [],
  render: { recipe: "procedural.arrowhead", palette: { primary: "#2f6fb8", accent: "#57d8ff" } },
  skin: { body: ["SHELL_WHITE"], propulsion: ["eng-l"] },
} as unknown as ShipConfig;

function skin(over: Partial<CosmeticConfig> = {}): CosmeticConfig {
  return {
    id: "cosmetic.paint-interceptor-tiger",
    type: "cosmetic",
    version: 3,
    name: "Tiger",
    kind: "paint",
    price: 0,
    target: "ship.interceptor",
    textures: {},
    elements: { body: { color: "#f07800", pattern: "tiger" } },
    ...over,
  } as CosmeticConfig;
}

/** The CURRENT pipeline: one authored image on the hull's one wired element. */
function pack(over: Partial<CosmeticConfig> = {}): CosmeticConfig {
  return {
    id: "cosmetic.skin-interceptor-ash",
    type: "cosmetic",
    version: 1,
    name: "Ash",
    kind: "skin",
    price: 0,
    target: "ship.interceptor",
    textures: { body: "ships/textures/interceptor/ash/body.png" },
    elements: {},
    ...over,
  } as CosmeticConfig;
}

describe("element rows", () => {
  it("lists every element, wired or not, with what the hull covers", () => {
    const rows = elementRows(SHIP, skin());
    expect(rows.map((row) => row.element)).toEqual(["body", "canopy", "wings", "emissive", "propulsion"]);
    expect(rows[0]).toMatchObject({ wired: ["SHELL_WHITE"], styled: true, inert: false });
    // Canopies exist on the hull but are unwired — the designer has to SEE that
    // rather than have the row hidden, or the element looks unavailable.
    expect(rows[1]).toMatchObject({ wired: [], styled: false, inert: false });
  });

  it("flags the one state that looks correct but renders nothing", () => {
    // Filled in on the skin, wired to nothing on the hull.
    const rows = elementRows(SHIP, skin({ elements: { canopy: { color: "#112233" } } }));
    expect(rows.find((row) => row.element === "canopy")).toMatchObject({ styled: true, inert: true });
  });

  it("counts a propulsion effect as styling that element", () => {
    const rows = elementRows(SHIP, skin({ elements: { propulsion: { effect: "fx.boost-trail" } } }));
    expect(rows.at(-1)).toMatchObject({ element: "propulsion", wired: ["eng-l"], styled: true });
  });

  it("reports every element unwired for a hull with no skins logic yet", () => {
    const rows = elementRows({ skin: undefined }, skin());
    expect(rows.every((row) => row.wired.length === 0)).toBe(true);
    expect(rows[0]!.inert).toBe(true);
  });
});

describe("editing an element", () => {
  it("patches one field and leaves the rest of the element alone", () => {
    const next = withElementStyle(skin(), "body", { color: "#ff0000" });
    expect(next.elements.body).toEqual({ color: "#ff0000", pattern: "tiger" });
  });

  it("does not touch the other elements", () => {
    const source = skin({ elements: { body: { color: "#f07800" }, wings: { color: "#111111" } } });
    expect(withElementStyle(source, "body", { color: "#ff0000" }).elements.wings).toEqual({ color: "#111111" });
  });

  it("CLEARS a field rather than storing undefined — absent is what the renderer reads", () => {
    const next = withElementStyle(skin(), "body", { pattern: undefined });
    expect(next.elements.body).toEqual({ color: "#f07800" });
    expect(next.elements.body && "pattern" in next.elements.body).toBe(false);
  });

  it("drops an element that has been emptied out entirely", () => {
    const next = withElementStyle(skin(), "body", { color: undefined, pattern: undefined });
    expect(next.elements).not.toHaveProperty("body");
  });

  it("sets and clears the propulsion effect", () => {
    const on = withPropulsionEffect(skin(), "fx.boost-trail");
    expect(on.elements.propulsion).toEqual({ effect: "fx.boost-trail" });
    expect(withPropulsionEffect(on, null).elements).not.toHaveProperty("propulsion");
  });
});

describe("new skins", () => {
  it("starts styling nothing, so the designer fills each element in", () => {
    expect(newSkinFor(SHIP, []).elements).toEqual({});
    expect(newSkinFor(SHIP, []).textures).toEqual({});
    expect(newSkinFor(SHIP, []).target).toBe("ship.interceptor");
  });

  it("starts as a TEXTURE skin — the legacy paint path is reached by duplicating one", () => {
    expect(newSkinFor(SHIP, []).kind).toBe("skin");
    expect(newSkinFor(SHIP, []).id).toBe("cosmetic.skin-interceptor-custom-1");
    expect(newSkinFor(SHIP, [], "paint").id).toBe("cosmetic.paint-interceptor-custom-1");
  });

  it("does not collide with an id already in the pack", () => {
    expect(newSkinFor(SHIP, ["cosmetic.skin-interceptor-custom-1"]).id).toBe("cosmetic.skin-interceptor-custom-2");
    expect(newSkinFor(SHIP, ["cosmetic.paint-interceptor-custom-1"], "paint").id).toBe("cosmetic.paint-interceptor-custom-2");
  });
});

describe("editing a texture skin", () => {
  it("sets one element's authored image and leaves the others alone", () => {
    const next = withElementTexture(pack(), "canopy", "ships/textures/interceptor/ash/canopy.png");
    expect(next.textures).toEqual({
      body: "ships/textures/interceptor/ash/body.png",
      canopy: "ships/textures/interceptor/ash/canopy.png",
    });
  });

  it("CLEARS an element when the box is emptied — absent is what the renderer reads", () => {
    const next = withElementTexture(pack(), "body", "   ");
    expect(next.textures).not.toHaveProperty("body");
  });

  it("sets and clears the livery's own light map", () => {
    const relit = withEmissiveTexture(pack(), "ships/textures/interceptor/ash/lights.png");
    expect(relit.emissive).toBe("ships/textures/interceptor/ash/lights.png");
    expect(withEmissiveTexture(relit, "")).not.toHaveProperty("emissive");
  });

  it("counts an authored image as styling the element, and the hull's map as lighting it", () => {
    const rows = elementRows(SHIP, pack());
    expect(rows[0]).toMatchObject({ element: "body", styled: true });
    expect(rows.find((row) => row.element === "emissive")).toMatchObject({ styled: false });

    const lit = elementRows({ skin: { ...SHIP.skin, emissive: ["GLOW"], emissiveTexture: "ships/textures/i/standard/lights.png" } }, pack());
    expect(lit.find((row) => row.element === "emissive")).toMatchObject({ styled: true, wired: ["GLOW"] });
  });
});

describe("SkinEditor panel", () => {
  function host(
    cosmetics: CosmeticConfig[],
    ship: ShipConfig = SHIP,
  ): { host: EditorHost; replace: ReturnType<typeof vi.fn> } {
    const replace = vi.fn((next: CosmeticConfig) => {
      const at = cosmetics.findIndex((c) => c.id === next.id);
      if (at >= 0) cosmetics[at] = next;
      else cosmetics.push(next);
      return { ok: true as const, errors: [] };
    });
    const configService = {
      get: (type: string, id: string) => (type === "ship" && id === ship.id ? ship : undefined),
      getAll: (type: string) => (type === "ship" ? [ship] : type === "cosmetic" ? cosmetics : []),
      replace,
    } as unknown as ConfigService;
    return { host: { scene: new Scene(new NullEngine()), configService } as unknown as EditorHost, replace };
  }

  it("draws a section per element and shows what the hull wires to each", () => {
    const panel = new SkinEditor(host([skin()]).host, vi.fn());
    const sections = [...panel.element.querySelectorAll("[data-section]")].map((el) => (el as HTMLElement).dataset["section"]);
    expect(sections).toEqual(["body", "canopy", "wings", "emissive", "propulsion"]);
    expect(panel.element.querySelector('[data-section="body"]')?.textContent).toContain("SHELL_WHITE");
    panel.dispose();
  });

  it("warns on an element the skin fills but the hull cannot render", () => {
    const panel = new SkinEditor(host([skin({ elements: { canopy: { color: "#112233" } } })]).host, vi.fn());
    expect(panel.element.querySelector('[data-section="canopy"] .ed-warn')?.textContent).toContain("Not wired");
    panel.dispose();
  });

  it("commits a colour edit into the right element", () => {
    const paints = [skin()];
    const { host: editorHost } = host(paints);
    const panel = new SkinEditor(editorHost, vi.fn());
    const color = panel.element.querySelector<HTMLInputElement>('[data-section="body"] input[type="color"]')!;
    color.value = "#123456";
    color.dispatchEvent(new Event("change"));
    expect(paints[0]!.elements.body).toMatchObject({ color: "#123456" });
    panel.dispose();
  });

  it("turns the surface override on, then edits one knob without resetting the others", () => {
    const paints = [skin()];
    const panel = new SkinEditor(host(paints).host, vi.fn());
    const surface = () => panel.element.querySelector('[data-section="body"]')!;

    const toggles = surface().querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    const finishToggle = toggles[toggles.length - 1]!;
    finishToggle.checked = true;
    finishToggle.dispatchEvent(new Event("change"));
    expect(paints[0]!.elements.body?.finish).toEqual(DEFAULT_FINISH);

    const knobs = surface().querySelectorAll<HTMLInputElement>('input[type="range"]');
    expect(knobs).toHaveLength(4);
    knobs[0]!.value = "0.5";
    knobs[0]!.dispatchEvent(new Event("change"));
    knobs[1]!.value = "0.1";
    knobs[1]!.dispatchEvent(new Event("change"));
    // The second knob must not have undone the first.
    expect(paints[0]!.elements.body?.finish).toMatchObject({ gloss: 0.5, metallic: 0.1, clearcoat: 0.5 });
    panel.dispose();
  });

  it("offers the project's effects on propulsion and commits the pick", () => {
    const paints = [skin()];
    const panel = new SkinEditor(host(paints).host, vi.fn());
    const select = panel.element.querySelector<HTMLSelectElement>('[data-section="propulsion"] select')!;
    select.append(new Option("Boost Trail", "fx.boost-trail"));
    select.value = "fx.boost-trail";
    select.dispatchEvent(new Event("change"));
    expect(paints[0]!.elements.propulsion).toEqual({ effect: "fx.boost-trail" });
    panel.dispose();
  });

  it("warns loudly when the hull has no skins logic at all", () => {
    const bare = { ...SHIP, skin: undefined } as ShipConfig;
    const panel = new SkinEditor(host([skin()], bare).host, vi.fn());
    expect(panel.element.querySelector(".ed-warn")?.textContent).toContain("wires no skin elements");
    panel.dispose();
  });

  it("shows a texture skin as one path box per element, not the paint controls", () => {
    const panel = new SkinEditor(host([pack()]).host, vi.fn());
    const body = panel.element.querySelector('[data-section="body"]')!;

    expect(body.querySelector<HTMLInputElement>('input[type="text"]')!.value).toBe(
      "ships/textures/interceptor/ash/body.png",
    );
    // No colour wheel, no pattern dropdown, no finish knobs: this pipeline has
    // exactly one authored thing per element.
    expect(body.querySelector('input[type="color"]')).toBeNull();
    expect(body.querySelectorAll('input[type="range"]')).toHaveLength(0);
    expect(panel.element.querySelector('[data-kind="skin"]')).not.toBeNull();
    panel.dispose();
  });

  it("commits an edited texture path into the right element", () => {
    const skins = [pack()];
    const panel = new SkinEditor(host(skins).host, vi.fn());
    const input = panel.element.querySelector<HTMLInputElement>('[data-section="canopy"] input[type="text"]')!;
    input.value = "ships/textures/interceptor/ash/canopy.png";
    input.dispatchEvent(new Event("change"));
    expect(skins[0]!.textures).toMatchObject({ canopy: "ships/textures/interceptor/ash/canopy.png" });
    panel.dispose();
  });

  it("offers the light map on the emissive element, and warns when the hull has none", () => {
    const skins = [pack()];
    const panel = new SkinEditor(host(skins).host, vi.fn());
    const emissive = panel.element.querySelector('[data-section="emissive"]')!;

    // Albedo + light map: two paths, because the lit plates have both.
    const boxes = emissive.querySelectorAll<HTMLInputElement>('input[type="text"]');
    expect(boxes).toHaveLength(2);
    // SHIP wires no emissive element at all — the owner's one hard rule, unmet.
    expect(emissive.querySelector(".ed-warn")?.textContent).toContain("nowhere to put an emissive map");

    boxes[1]!.value = "ships/textures/interceptor/ash/lights.png";
    boxes[1]!.dispatchEvent(new Event("change"));
    expect(skins[0]!.emissive).toBe("ships/textures/interceptor/ash/lights.png");
    panel.dispose();
  });

  it("keeps the legacy paint editor for a kind:\"paint\" cosmetic", () => {
    const panel = new SkinEditor(host([skin()]).host, vi.fn());
    const body = panel.element.querySelector('[data-section="body"]')!;
    expect(body.querySelector('input[type="color"]')).not.toBeNull();
    expect(body.querySelectorAll('input[type="range"]')).toHaveLength(4);
    expect(panel.element.querySelector('[data-kind="paint"]')?.textContent).toContain("Legacy paint");
    panel.dispose();
  });

  it("opens every element section folded, and keeps an opened one open across a commit", () => {
    const paints = [skin()];
    const { host: editorHost } = host(paints);
    const panel = new SkinEditor(editorHost, vi.fn());

    const sections = [...panel.element.querySelectorAll<HTMLDetailsElement>("details[data-section]")];
    // Five elements' worth of texture/colour/pattern/surface controls opened at
    // once is more than fits on the phone this editor has to work on.
    expect(sections.map((s) => s.open)).toEqual([false, false, false, false, false]);

    const body = panel.element.querySelector<HTMLDetailsElement>('details[data-section="body"]')!;
    body.open = true;
    body.dispatchEvent(new Event("toggle"));

    const color = panel.element.querySelector<HTMLInputElement>('[data-section="body"] input[type="color"]')!;
    color.value = "#445566";
    color.dispatchEvent(new Event("change"));

    // renderUi() rebuilds the panel, so without the fold memory the section the
    // designer was painting in would shut itself on the first colour they set.
    expect(panel.element.querySelector<HTMLDetailsElement>('details[data-section="body"]')!.open).toBe(true);
    expect(panel.element.querySelector<HTMLDetailsElement>('details[data-section="wings"]')!.open).toBe(false);

    panel.dispose();
  });
});

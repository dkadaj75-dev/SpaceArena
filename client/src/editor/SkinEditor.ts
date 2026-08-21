import { TransformNode, Vector3, type Mesh, type Scene } from "@babylonjs/core";
import {
  allCosmetics,
  cosmeticDisplayName,
  cosmeticsForShip,
  isSurfaceElement,
  paintPattern,
  SKIN_ELEMENT_LABEL,
  SKIN_ELEMENTS,
  styleIsEmpty,
  textureDisplayName,
  wiringFor,
  type CosmeticConfig,
  type EffectConfig,
  type PaintFinish,
  type PaintPattern,
  type ShipConfig,
  type SkinElement,
  type SkinElementStyle,
  type SurfaceElement,
  type TextureConfig,
} from "@space-arena/shared";
import { AssetRegistry } from "../core/AssetRegistry.js";
import { pinCloneHierarchyLod0 } from "../core/modelLod.js";
import { ShipPaintBank } from "../game/shipPaint.js";
import { applicationNotice } from "./applicationScope.js";
import type { EditorHost, EditorPanel } from "./EditorShell.js";
import { saveConfig } from "./saveConfig.js";

/**
 * Skins (F10 → Ships → Skins) — where a livery is authored.
 *
 * A skin is a look per ELEMENT: body, canopies, wings, emissive light,
 * propulsion. It never names the model's materials. WHICH plates of a given
 * hull each element covers is the Ship tool's business (`ship.skin`), and this
 * panel only shows that wiring so a designer can see why an element is or is
 * not landing: an element the hull wires to nothing is inert here, however
 * fully it is filled in.
 *
 * The preview is the real renderer. It stages the hull through the same
 * {@link ShipPaintBank} the match and the Hangar use, so what this tool shows
 * is what a pilot flies.
 */

/** The empty option of every "pick one, or don't" dropdown. */
const NONE = "";

/** What the surface override starts at — the shipped lacquer. Metallic is zero on purpose. */
export const DEFAULT_FINISH: PaintFinish = { gloss: 0.7, metallic: 0, clearcoat: 0.5, glow: 0.14 };

/** The colour a fresh element starts at, so the first paint is visible immediately. */
const DEFAULT_COLOR = "#8a94a6";

/** One element as the panel needs to draw it. */
export interface ElementRow {
  element: SkinElement;
  label: string;
  /** Material names (or, for propulsion, socket ids) this hull wires to it. */
  wired: readonly string[];
  /** The skin says something here. */
  styled: boolean;
  /**
   * Filled in but unreachable: the skin styles this element and the hull wires
   * it to nothing, so the style renders nowhere. The one state worth warning
   * about, because everything looks correct in the JSON.
   */
  inert: boolean;
}

/**
 * Every element, with the hull's wiring and whether the skin fills it. Elements
 * are always ALL listed, wired or not — a designer has to be able to see that
 * canopies exist and are unwired, which a filtered list would hide.
 */
export function elementRows(
  ship: Pick<ShipConfig, "skin"> | undefined,
  cosmetic: Pick<CosmeticConfig, "elements">,
): ElementRow[] {
  return SKIN_ELEMENTS.map((element) => {
    const wired = wiringFor(ship?.skin, element);
    const styled = isSurfaceElement(element)
      ? !styleIsEmpty(cosmetic.elements?.[element])
      : cosmetic.elements?.propulsion?.effect !== undefined;
    return { element, label: SKIN_ELEMENT_LABEL[element], wired, styled, inert: styled && wired.length === 0 };
  });
}

/**
 * `cosmetic` with one surface element patched. An `undefined` value CLEARS that
 * field rather than storing undefined, because "absent" is the renderer's
 * "leave the artist's own" and a present-but-undefined key would serialise as
 * noise into the content file.
 */
export function withElementStyle(
  cosmetic: CosmeticConfig,
  element: SurfaceElement,
  patch: Partial<SkinElementStyle>,
): CosmeticConfig {
  const next: Record<string, unknown> = { ...cosmetic.elements?.[element], ...patch };
  for (const [key, value] of Object.entries(patch)) if (value === undefined) delete next[key];
  const elements = { ...cosmetic.elements, [element]: next as SkinElementStyle };
  if (styleIsEmpty(elements[element])) delete elements[element];
  return { ...cosmetic, elements };
}

/** `cosmetic` with the propulsion effect set, or cleared when `effect` is null. */
export function withPropulsionEffect(cosmetic: CosmeticConfig, effect: string | null): CosmeticConfig {
  const elements = { ...cosmetic.elements };
  if (effect) elements.propulsion = { effect };
  else delete elements.propulsion;
  return { ...cosmetic, elements };
}

/** A fresh skin for `ship`, styling nothing — the designer fills the elements in. */
export function newSkinFor(ship: Pick<ShipConfig, "id">, existingIds: readonly string[]): CosmeticConfig {
  const slug = ship.id.split(".").pop() ?? ship.id;
  let n = 1;
  while (existingIds.includes(`cosmetic.paint-${slug}-custom-${n}`)) n++;
  return {
    id: `cosmetic.paint-${slug}-custom-${n}`,
    type: "cosmetic",
    version: 3,
    name: `Custom ${n}`,
    kind: "paint",
    price: 0,
    target: ship.id,
    elements: {},
  };
}

export class SkinEditor implements EditorPanel {
  readonly element = document.createElement("div");
  private readonly scene: Scene;
  private readonly assets: AssetRegistry;
  private readonly paint: ShipPaintBank;
  private readonly previewRoot: TransformNode;
  private previewMesh: Mesh | null = null;

  private shipId: string;
  private cosmeticId: string;
  private readonly hullLoadKicked = new Set<string>();
  /** Accordion opens by element slug — see {@link SkinEditor.section}. */
  private readonly folds = new Map<string, boolean>();

  constructor(private readonly host: EditorHost, private readonly report: (message: string | null) => void) {
    this.scene = host.scene;
    this.assets = new AssetRegistry(this.scene);
    this.paint = new ShipPaintBank(this.scene, host.configService);
    this.previewRoot = new TransformNode("editorSkinPreview", this.scene);
    this.shipId = host.configService.getAll<ShipConfig>("ship")[0]?.id ?? "";
    this.cosmeticId = this.skins()[0]?.id ?? "";
    this.rebuildPreview();
    this.focusCamera();
    this.renderUi();
  }

  private ship(): ShipConfig | undefined {
    return this.host.configService.get<ShipConfig>("ship", this.shipId);
  }

  private skins(): CosmeticConfig[] {
    return cosmeticsForShip(this.host.configService, this.shipId);
  }

  private cosmetic(): CosmeticConfig | undefined {
    return this.skins().find((skin) => skin.id === this.cosmeticId);
  }

  // ---------------------------------------------------------------- UI ----

  private renderUi(): void {
    this.element.replaceChildren();

    const shipSelect = document.createElement("select");
    for (const ship of this.host.configService.getAll<ShipConfig>("ship")) {
      shipSelect.append(new Option(ship.name ?? ship.id, ship.id, false, ship.id === this.shipId));
    }
    shipSelect.addEventListener("change", () => {
      this.shipId = shipSelect.value;
      this.cosmeticId = this.skins()[0]?.id ?? "";
      this.rebuildPreview();
      this.focusCamera();
      this.renderUi();
    });

    const skinSelect = document.createElement("select");
    for (const skin of this.skins()) {
      skinSelect.append(new Option(cosmeticDisplayName(skin), skin.id, false, skin.id === this.cosmeticId));
    }
    skinSelect.addEventListener("change", () => {
      this.cosmeticId = skinSelect.value;
      this.rebuildPreview();
      this.renderUi();
    });

    this.element.append(
      row(text("Ship "), shipSelect, text(" Skin "), skinSelect),
      row(
        button("New skin", () => this.createSkin()),
        button("Duplicate", () => this.duplicateSkin()),
        primaryButton("Save to disk", () => void this.save()),
      ),
      applicationNotice("cosmetic"),
    );

    const cosmetic = this.cosmetic();
    if (!cosmetic) {
      this.element.append(hint("This hull has no skins yet. “New skin” starts one."));
      return;
    }

    const rows = elementRows(this.ship(), cosmetic);
    if (rows.every((entry) => entry.wired.length === 0)) {
      this.element.append(
        warn("This hull wires no skin elements yet, so nothing authored here can land. Open Ships → Skins logic and assign its materials first."),
      );
    }
    for (const entry of rows) {
      this.element.append(
        entry.element === "propulsion"
          ? this.propulsionSection(cosmetic, entry)
          : this.surfaceSection(cosmetic, entry.element as SurfaceElement, entry),
      );
    }
  }

  /**
   * One element's collapsible section, FOLDED on first render. A hull with five
   * wired elements opened five stacks of texture/colour/pattern/surface
   * controls at once, which is more than fits on the phone this editor has to
   * work on. {@link folds} survives renderUi()'s rebuild so a section the
   * designer opened does not shut itself on the next colour tweak.
   */
  private section(title: string, slug: string): HTMLElement {
    const box = document.createElement("details");
    box.open = this.folds.get(slug) ?? false;
    box.addEventListener("toggle", () => this.folds.set(slug, box.open));
    // Stable hook for tests and the screenshot rig: the headings are prose and
    // will be reworded, the slug is what code is allowed to reach for.
    box.dataset["section"] = slug;
    const summary = document.createElement("summary");
    summary.textContent = title;
    box.append(summary);
    return box;
  }

  /**
   * One surface element: what it covers on this hull, then texture, colour,
   * pattern and surface. Every control is "off" by default, and off means the
   * model keeps what the artist gave it.
   */
  private surfaceSection(cosmetic: CosmeticConfig, element: SurfaceElement, info: ElementRow): HTMLElement {
    const box = this.section(info.label, element);
    const style = cosmetic.elements?.[element] ?? {};
    const patch = (next: Partial<SkinElementStyle>, rerender = false): void => {
      this.replace(withElementStyle(cosmetic, element, next));
      if (rerender) this.renderUi();
    };

    box.append(this.wiringLine(info, "material"));

    // --- texture -------------------------------------------------------
    const textureSelect = document.createElement("select");
    textureSelect.append(new Option("No texture", NONE));
    for (const texture of this.host.configService.getAll<TextureConfig>("texture")) {
      textureSelect.append(new Option(textureDisplayName(texture), texture.id));
    }
    if (style.texture && !textureSelect.querySelector(`option[value="${style.texture}"]`)) {
      textureSelect.append(new Option(`${style.texture} (missing)`, style.texture));
    }
    textureSelect.value = style.texture ?? NONE;
    textureSelect.addEventListener("change", () => patch({ texture: textureSelect.value || undefined }, true));

    // --- colour --------------------------------------------------------
    const colorOn = document.createElement("input");
    colorOn.type = "checkbox";
    colorOn.checked = style.color !== undefined;
    const color = colorInput(style.color ?? DEFAULT_COLOR, (value) => patch({ color: value }));
    color.disabled = !colorOn.checked;
    colorOn.addEventListener("change", () => patch({ color: colorOn.checked ? color.value : undefined }, true));

    box.append(
      row(text("Texture "), textureSelect),
      row(colorOn, text(" Colour "), color),
      hint("A texture and a colour compose: the colour is the plate the texture (and any pattern) is drawn over. Both off leaves this element's own albedo alone."),
    );

    // --- pattern -------------------------------------------------------
    const patternSelect = document.createElement("select");
    patternSelect.append(new Option("No pattern", NONE));
    for (const pattern of paintPattern.options) patternSelect.append(new Option(titleCase(pattern), pattern));
    patternSelect.value = style.pattern ?? NONE;
    patternSelect.addEventListener("change", () =>
      patch({ pattern: (patternSelect.value || undefined) as PaintPattern | undefined }, true),
    );
    const patternColor = colorInput(style.patternColor ?? "#16171b", (value) => patch({ patternColor: value }));
    patternColor.disabled = !style.pattern;
    const scale = numberInput(style.patternScale ?? 3, 0.5, 64, (value) => patch({ patternScale: value }));
    scale.disabled = !style.pattern && !style.texture;

    box.append(row(text("Pattern "), patternSelect, text(" Marks "), patternColor, text(" Repeats "), scale));

    // --- surface -------------------------------------------------------
    const finishOn = document.createElement("input");
    finishOn.type = "checkbox";
    finishOn.checked = style.finish !== undefined;
    finishOn.addEventListener("change", () => patch({ finish: finishOn.checked ? { ...DEFAULT_FINISH } : undefined }, true));

    const knob = (label: string, key: keyof PaintFinish): HTMLElement => {
      const input = document.createElement("input");
      input.type = "range";
      input.min = "0";
      input.max = "1";
      input.step = "0.02";
      input.value = String(style.finish?.[key] ?? 0);
      input.disabled = style.finish === undefined;
      const readout = text((style.finish?.[key] ?? 0).toFixed(2));
      readout.className = "ed-mono";
      input.addEventListener("input", () => (readout.textContent = Number(input.value).toFixed(2)));
      input.addEventListener("change", () => {
        // Read the LIVE finish, not the one captured at render: the knobs share
        // this section and a captured copy would make each undo the one before.
        const live = this.cosmetic()?.elements?.[element]?.finish;
        patch({ finish: { ...live, [key]: Number(input.value) } });
      });
      return row(text(label), input, readout);
    };

    box.append(
      row(finishOn, text(" Surface override")),
      knob("Gloss ", "gloss"),
      knob("Metallic ", "metallic"),
      knob("Clear coat ", "clearcoat"),
      knob("Glow ", "glow"),
      hint("Gloss 1 is a mirror; clear coat adds a lacquer highlight independent of the hue; glow lights the plate in its own colour so it reads in a dark arena. Metallic is a trap here — the arenas' IBL is small and metal turns a bright hue to mud."),
    );
    return box;
  }

  /** Propulsion swaps the whole particle system on the hull's wired emitters. */
  private propulsionSection(cosmetic: CosmeticConfig, info: ElementRow): HTMLElement {
    const box = this.section(info.label, "propulsion");
    box.append(this.wiringLine(info, "emitter socket"));

    const select = document.createElement("select");
    select.append(new Option("Ship's own effect", NONE));
    for (const effect of this.host.configService.getAll<EffectConfig>("effect")) {
      select.append(new Option(effect.name ?? effect.id, effect.id));
    }
    const current = cosmetic.elements?.propulsion?.effect;
    if (current && !select.querySelector(`option[value="${current}"]`)) {
      select.append(new Option(`${current} (missing)`, current));
    }
    select.value = current ?? NONE;
    select.addEventListener("change", () => {
      this.replace(withPropulsionEffect(cosmetic, select.value || null));
      this.renderUi();
    });

    box.append(
      row(text("Effect "), select),
      hint("Any particle effect in the project. It replaces the effect on the emitter sockets this hull wires to propulsion, and leaves every other emitter alone."),
    );
    return box;
  }

  /** What this element covers on this hull — and the loud case where it covers nothing. */
  private wiringLine(info: ElementRow, noun: string): HTMLElement {
    if (info.wired.length === 0) {
      const message = `Not wired on this hull — assign its ${noun}s in Ships → Skins logic. Anything set here will not render.`;
      return info.inert ? warn(message) : hint(message);
    }
    const line = hint(`Covers ${info.wired.length} ${noun}${info.wired.length === 1 ? "" : "s"}: ${info.wired.join(", ")}`);
    line.classList.add("ed-mono");
    return line;
  }

  // ----------------------------------------------------------- editing ----

  /** Commit through ConfigService, then re-stage the preview off the edited skin. */
  private replace(next: CosmeticConfig): void {
    const result = this.host.configService.replace(next);
    if (!result.ok) {
      this.report(result.errors.map((error) => error.message).join("; "));
      return;
    }
    this.report(null);
    this.cosmeticId = next.id;
    this.rebuildPreview();
  }

  private createSkin(): void {
    const ship = this.ship();
    if (!ship) return;
    const skin = newSkinFor(ship, allCosmetics(this.host.configService).map((cosmetic) => cosmetic.id));
    this.replace(skin);
    this.renderUi();
  }

  private duplicateSkin(): void {
    const ship = this.ship();
    const source = this.cosmetic();
    if (!ship || !source) return;
    const skin = newSkinFor(ship, allCosmetics(this.host.configService).map((cosmetic) => cosmetic.id));
    this.replace({ ...structuredClone(source), id: skin.id, name: `${cosmeticDisplayName(source)} copy` });
    this.renderUi();
  }

  async save(): Promise<void> {
    const cosmetic = this.cosmetic();
    if (!cosmetic) return;
    this.report(await saveConfig(cosmetic));
  }

  // ------------------------------------------------------------ preview ----

  /**
   * Stage the hull wearing the edited skin. The bank caches painted masters by
   * (hull, cosmetic), so the edited one has to be invalidated or the preview
   * would keep showing the look the skin had when it was first staged.
   */
  private rebuildPreview(): void {
    this.previewMesh?.dispose();
    this.previewMesh = null;
    const ship = this.ship();
    if (!ship) return;
    if (this.cosmeticId) this.paint.invalidate(this.cosmeticId);

    const hullKey = `${ship.id}:${ship.render.model ?? ""}:s${ship.render.modelScale ?? 1}:r${ship.render.modelRotationY ?? 0}`;
    if (ship.render.model && !this.hullLoadKicked.has(hullKey)) {
      this.hullLoadKicked.add(hullKey);
      void this.assets.ensureModel(ship.render).then((master) => {
        if (master && this.ship()?.id === ship.id) {
          this.rebuildPreview();
          this.renderUi();
        }
      });
    }

    const base = this.assets.getShipMaster(ship.render);
    const master = this.paint.masterFor(base, ship, this.cosmeticId || null);
    const mesh = master.clone(`skinPreview.${ship.id}`);
    pinCloneHierarchyLod0(mesh);
    mesh.setEnabled(true);
    mesh.isPickable = false;
    mesh.parent = this.previewRoot;
    mesh.position.setAll(0);
    this.previewMesh = mesh;
  }

  private focusCamera(): void {
    const cam = this.scene.activeCamera as unknown as { setTarget?: (v: Vector3) => void; radius?: number; beta?: number };
    cam?.setTarget?.(Vector3.Zero());
    if (cam && typeof cam.radius === "number") {
      const hullRadius = this.previewMesh?.getBoundingInfo().boundingSphere.radiusWorld ?? 4;
      cam.radius = Math.max(8, hullRadius * 3.5);
      cam.beta = 1.1;
    }
  }

  dispose(): void {
    this.previewMesh?.dispose();
    this.previewMesh = null;
    // Painted clones first: a bank disposed after its base masters would free
    // meshes whose materials the registry has already taken down.
    this.paint.dispose();
    this.previewRoot.dispose();
    this.assets.dispose();
    this.element.replaceChildren();
  }
}

// ------------------------------------------------------------- widgets ----

function button(label: string, onClick: () => void): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = "ed-btn";
  element.textContent = label;
  element.addEventListener("click", onClick);
  return element;
}

function primaryButton(label: string, onClick: () => void): HTMLButtonElement {
  const element = button(label, onClick);
  element.className = "ed-btn ed-btn--primary";
  return element;
}

function colorInput(value: string, onChange: (value: string) => void): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "color";
  input.className = "ed-input";
  input.value = value;
  input.addEventListener("change", () => onChange(input.value));
  return input;
}

function numberInput(value: number, min: number, max: number, onChange: (value: number) => void): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "number";
  input.className = "ed-input ed-num ed-num--sm";
  input.step = "0.5";
  input.min = String(min);
  input.max = String(max);
  input.value = String(value);
  input.addEventListener("change", () => {
    const next = Number(input.value);
    onChange(Number.isFinite(next) ? Math.min(max, Math.max(min, next)) : min);
  });
  return input;
}

function text(value: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.textContent = value;
  return span;
}

function hint(message: string): HTMLElement {
  const element = document.createElement("p");
  // ed-note, not ed-label: a label refuses to wrap, and these are sentences the
  // inspector column is far too narrow to show on one line.
  element.className = "ed-note";
  element.textContent = message;
  return element;
}

function warn(message: string): HTMLElement {
  const element = document.createElement("p");
  element.className = "ed-warn";
  element.textContent = `⚠ ${message}`;
  return element;
}

function row(...children: Node[]): HTMLDivElement {
  const div = document.createElement("div");
  div.className = "ed-row";
  div.append(...children);
  return div;
}


function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

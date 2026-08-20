import { MultiMaterial, TransformNode, Vector3, type Material, type Mesh, type Scene } from "@babylonjs/core";
import {
  allCosmetics,
  cosmeticDisplayName,
  cosmeticsForShip,
  paintPattern,
  paintTargetFor,
  type CosmeticConfig,
  type PaintChannel,
  type PaintFinish,
  type PaintPattern,
  type ShipConfig,
} from "@space-arena/shared";
import { AssetRegistry } from "../core/AssetRegistry.js";
import { pinCloneHierarchyLod0 } from "../core/modelLod.js";
import { ShipPaintBank } from "../game/shipPaint.js";
import { applicationNotice } from "./applicationScope.js";
import type { EditorHost, EditorPanel } from "./EditorShell.js";
import { saveConfig } from "./saveConfig.js";

/**
 * Skins (F10 → Ships → Skins) — the tool that decides WHICH of a hull's
 * materials a paint is allowed to touch.
 *
 * A paint used to guess its targets from material names, which is how the
 * Interceptor ended up with tinted canopy glass and a recoloured engine bloom:
 * every slot of the model got some channel of the paint whether it was part of
 * the livery or not. Here the designer picks, per material, the channel it
 * wears — or leaves it unpainted, which is the default for a fresh skin and the
 * answer for most slots. The list is exhaustive: what it does not name renders
 * exactly as the artist shipped it, reflections, clearcoat and all.
 *
 * The preview is the real renderer. It stages the hull through the same
 * {@link ShipPaintBank} the match and the Hangar use, so what this tool shows is
 * what a pilot flies — a paint that looks wrong here looks wrong in a match.
 */

/**
 * Every material slot a hull master draws with, root and children, in draw
 * order and de-duplicated. Read off the UNPAINTED master: a painted clone
 * renames the slots it touched (`SHELL.cosmetic.paint-…`) and the table has to
 * show the names the GLB actually authored.
 */
export function slotNamesOf(master: Mesh | null): string[] {
  if (!master) return [];
  const names: string[] = [];
  const collect = (material: Material | null): void => {
    const slots = material instanceof MultiMaterial ? material.subMaterials : [material];
    for (const slot of slots) if (slot && !names.includes(slot.name)) names.push(slot.name);
  };
  collect(master.material);
  for (const child of master.getChildMeshes(false)) collect(child.material);
  return names;
}

/**
 * What the surface override starts at: the shipped lacquer. Metallic is zero on
 * purpose — see the second hint in {@link SkinEditor.surfaceSection}.
 */
const DEFAULT_FINISH = { gloss: 0.7, metallic: 0, clearcoat: 0.5, glow: 0.14 } as const;

/** "Not painted" — the empty option of the per-material channel dropdown. */
const NO_CHANNEL = "";

const CHANNEL_LABEL: Record<PaintChannel, string> = {
  primary: "Primary",
  accent: "Accent",
  emissive: "Emissive",
};

/** One row of the material table: a slot of the model and what the paint does to it. */
export interface MaterialRow {
  material: string;
  channel: PaintChannel | null;
  patterned: boolean;
  /** Named by the paint but absent from the model — a rename left it dangling. */
  missing: boolean;
}

/**
 * The table the tool draws: every material of the model, plus any the paint
 * still names after the model moved on. Nothing is silently dropped — a
 * dangling target is a thing the designer has to see to fix.
 */
export function materialRows(cosmetic: CosmeticConfig, modelMaterials: readonly string[]): MaterialRow[] {
  const rows: MaterialRow[] = modelMaterials.map((material) => {
    const target = paintTargetFor(cosmetic, material);
    return {
      material,
      channel: target?.channel ?? null,
      patterned: target?.patterned === true,
      missing: false,
    };
  });
  const known = new Set(modelMaterials.map((name) => name.trim().toLowerCase()));
  for (const target of cosmetic.materials ?? []) {
    if (known.has(target.material.trim().toLowerCase())) continue;
    rows.push({ material: target.material, channel: target.channel, patterned: target.patterned === true, missing: true });
  }
  return rows;
}

/**
 * `cosmetic` with `material` assigned to `channel`, or dropped from the target
 * list when `channel` is null. Assigning ANY channel commits the paint to
 * explicit targeting: the list stops being absent, so every material the
 * designer has not named is now deliberately unpainted rather than guessed at.
 */
export function withMaterialChannel(
  cosmetic: CosmeticConfig,
  material: string,
  channel: PaintChannel | null,
): CosmeticConfig {
  const rest = (cosmetic.materials ?? []).filter(
    (target) => target.material.trim().toLowerCase() !== material.trim().toLowerCase(),
  );
  if (!channel) return { ...cosmetic, materials: rest };
  const previous = paintTargetFor(cosmetic, material);
  const next = { material, channel, ...(previous?.patterned ? { patterned: true } : {}) };
  return { ...cosmetic, materials: [...rest, next] };
}

/** `cosmetic` with the pattern drawn into (or lifted off) one already-targeted material. */
export function withMaterialPatterned(cosmetic: CosmeticConfig, material: string, patterned: boolean): CosmeticConfig {
  const target = paintTargetFor(cosmetic, material);
  if (!target) return cosmetic;
  return {
    ...cosmetic,
    materials: (cosmetic.materials ?? []).map((entry) =>
      entry === target ? { material: entry.material, channel: entry.channel, ...(patterned ? { patterned: true } : {}) } : entry,
    ),
  };
}

/** A fresh paint for `ship`, targeting nothing — the designer picks the plates. */
export function newSkinFor(ship: ShipConfig, existingIds: readonly string[]): CosmeticConfig {
  const slug = ship.id.split(".").pop() ?? ship.id;
  let n = 1;
  while (existingIds.includes(`cosmetic.paint-${slug}-custom-${n}`)) n++;
  return {
    id: `cosmetic.paint-${slug}-custom-${n}`,
    type: "cosmetic",
    version: 2,
    name: `Custom ${n}`,
    kind: "paint",
    price: 0,
    target: ship.id,
    paint: { primary: "#8a94a6", accent: "#c3ccd8" },
    materials: [],
  };
}

export class SkinEditor implements EditorPanel {
  readonly element = document.createElement("div");
  private readonly scene: Scene;
  private readonly assets: AssetRegistry;
  private readonly paint: ShipPaintBank;
  private readonly previewRoot: TransformNode;
  private previewMesh: Mesh | null = null;
  /** Material slots of the staged hull's UNPAINTED master — the table's rows. */
  private baseMaterials: string[] = [];

  private shipId: string;
  private cosmeticId: string;
  /** Hull loads already kicked, keyed like ShipManager's so a scale edit re-kicks. */
  private readonly hullLoadKicked = new Set<string>();

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
    this.element.append(
      this.coloursSection(cosmetic),
      this.surfaceSection(cosmetic),
      this.finishSection(cosmetic),
      this.materialsSection(cosmetic),
    );
  }

  /** The three authored channels. Emissive is opt-in: absent leaves the glow alone. */
  private coloursSection(cosmetic: CosmeticConfig): HTMLElement {
    const box = section("Colours");
    const primary = colorInput(cosmetic.paint.primary, (value) => this.patchPaint({ primary: value }));
    const accent = colorInput(cosmetic.paint.accent, (value) => this.patchPaint({ accent: value }));

    const emissiveOn = document.createElement("input");
    emissiveOn.type = "checkbox";
    emissiveOn.checked = cosmetic.paint.emissive !== undefined;
    const emissive = colorInput(cosmetic.paint.emissive ?? cosmetic.paint.accent, (value) =>
      this.patchPaint({ emissive: value }),
    );
    emissive.disabled = !emissiveOn.checked;
    emissiveOn.addEventListener("change", () => {
      this.patchPaint({ emissive: emissiveOn.checked ? emissive.value : undefined });
      this.renderUi();
    });

    box.append(
      row(text("Primary "), primary, text(" Accent "), accent),
      row(emissiveOn, text(" Emissive "), emissive),
      hint("Primary and accent tint the base colour of the materials you assign below. Emissive recolours a glow slot's light while keeping its authored strength."),
    );
    return box;
  }

  /**
   * How the painted plate behaves under light. This is what separates a livery
   * from primer: a saturated hue at the model's authored roughness is flat, and
   * gloss + clear coat are what put the arena's reflection and a rolling white
   * highlight on top of it. Off = keep whatever the artist authored.
   */
  private surfaceSection(cosmetic: CosmeticConfig): HTMLElement {
    const box = section("Surface");
    const finish = cosmetic.paint.finish;

    const on = document.createElement("input");
    on.type = "checkbox";
    on.checked = finish !== undefined;
    on.addEventListener("change", () => {
      this.patchPaint({ finish: on.checked ? { ...DEFAULT_FINISH } : undefined });
      this.renderUi();
    });

    const knob = (label: string, key: keyof PaintFinish): HTMLElement => {
      const input = document.createElement("input");
      input.type = "range";
      input.min = "0";
      input.max = "1";
      input.step = "0.02";
      input.value = String(finish?.[key] ?? 0);
      input.disabled = finish === undefined;
      const readout = text((finish?.[key] ?? 0).toFixed(2));
      readout.className = "ed-mono";
      input.addEventListener("input", () => (readout.textContent = Number(input.value).toFixed(2)));
      input.addEventListener("change", () => {
        // Read the LIVE finish, not the one captured at render: three knobs
        // share this section and only the table re-renders between edits, so a
        // captured copy would make each knob undo the one before it.
        this.patchPaint({ finish: { ...this.cosmetic()?.paint.finish, [key]: Number(input.value) } });
      });
      return row(text(label), input, readout);
    };

    box.append(
      row(on, text(" Override the artist's surface")),
      knob("Gloss ", "gloss"),
      knob("Metallic ", "metallic"),
      knob("Clear coat ", "clearcoat"),
      knob("Glow ", "glow"),
      hint("Gloss 1 is a mirror; clear coat adds a lacquer layer whose white highlight is independent of the hue; glow lights the plate in its own colour so it still reads in a dark arena. Off leaves the model's own surface exactly as authored."),
      hint("Metallic is a trap in these arenas: the IBL is small, so metal eats the diffuse term and turns a bright hue to mud. Leave it near zero unless the skin is meant to look like bare, unpainted plate."),
    );
    return box;
  }

  /** Flat colour, or one of the procedural patterns drawn into the albedo. */
  private finishSection(cosmetic: CosmeticConfig): HTMLElement {
    const box = section("Pattern");
    const select = document.createElement("select");
    select.append(new Option("Flat colour", NO_CHANNEL));
    for (const pattern of paintPattern.options) select.append(new Option(titleCase(pattern), pattern));
    select.value = cosmetic.paint.pattern ?? NO_CHANNEL;
    select.addEventListener("change", () => {
      this.patchPaint({ pattern: (select.value || undefined) as PaintPattern | undefined });
      this.renderUi();
    });

    const patternColor = colorInput(cosmetic.paint.patternColor ?? cosmetic.paint.accent, (value) =>
      this.patchPaint({ patternColor: value }),
    );
    const scale = document.createElement("input");
    scale.type = "number";
    scale.className = "ed-input ed-num ed-num--sm";
    scale.step = "0.5";
    scale.min = "0.5";
    scale.max = "64";
    scale.value = String(cosmetic.paint.patternScale ?? 3);
    scale.addEventListener("change", () => {
      const value = Number(scale.value);
      this.patchPaint({ patternScale: Number.isFinite(value) && value > 0 ? Math.min(64, value) : undefined });
    });
    patternColor.disabled = !cosmetic.paint.pattern;
    scale.disabled = !cosmetic.paint.pattern;

    box.append(
      row(text("Pattern "), select, text(" Stripe/rust colour "), patternColor, text(" Repeats "), scale),
      hint("A pattern is drawn into the albedo of the materials you tick “Pattern” on below. Roughness, metal and clearcoat are untouched, so the finish still reflects like the plate it sits on."),
    );
    return box;
  }

  /**
   * The point of the tool: one row per material of the hull's model, and the
   * channel each wears. "Not painted" is the default, and it means exactly that.
   */
  private materialsSection(cosmetic: CosmeticConfig): HTMLElement {
    const box = section("Painted materials");
    const ship = this.ship();
    const names = this.baseMaterials;
    const rows = materialRows(cosmetic, names);

    if (cosmetic.materials === undefined) {
      box.append(
        warn("This skin has no material list, so it falls back to guessing roles from material names — which is what smears paint over canopies and engine bloom. Assign a channel below to switch it to explicit targeting."),
      );
    }
    if (names.length === 0) {
      box.append(hint(ship?.render.model ? "Loading the hull's materials…" : "This hull renders from a procedural recipe, which has a single material slot."));
    }

    const table = document.createElement("table");
    const head = document.createElement("tr");
    for (const label of ["Material", "Wears", "Pattern"]) {
      const th = document.createElement("th");
      th.textContent = label;
      head.append(th);
    }
    table.append(head);

    for (const entry of rows) {
      const channelSelect = document.createElement("select");
      channelSelect.append(new Option("Not painted", NO_CHANNEL));
      for (const channel of ["primary", "accent", "emissive"] as const) {
        channelSelect.append(new Option(CHANNEL_LABEL[channel], channel));
      }
      channelSelect.value = entry.channel ?? NO_CHANNEL;
      channelSelect.addEventListener("change", () => {
        this.replace(withMaterialChannel(cosmetic, entry.material, (channelSelect.value || null) as PaintChannel | null));
        this.renderUi();
      });

      const patterned = document.createElement("input");
      patterned.type = "checkbox";
      patterned.checked = entry.patterned;
      // A glow slot emits light; there is nothing for a stripe to sit on.
      patterned.disabled = !cosmetic.paint.pattern || entry.channel === null || entry.channel === "emissive";
      patterned.addEventListener("change", () => {
        this.replace(withMaterialPatterned(cosmetic, entry.material, patterned.checked));
        this.renderUi();
      });

      const line = document.createElement("tr");
      line.dataset["material"] = entry.material;
      const name = document.createElement("td");
      name.className = "ed-mono";
      name.textContent = entry.missing ? `${entry.material} ⚠ not in this model` : entry.material;
      if (entry.missing) name.title = "The paint still names this material, but the hull's model no longer has it.";
      line.append(name, cell(channelSelect), cell(patterned));
      table.append(line);
    }
    box.append(table);
    box.append(hint("Anything left on “Not painted” renders exactly as the artist shipped it — glass, dark tech and engine bloom included."));
    return box;
  }

  // ----------------------------------------------------------- editing ----

  private patchPaint(patch: Partial<CosmeticConfig["paint"]>): void {
    const cosmetic = this.cosmetic();
    if (!cosmetic) return;
    const paint = { ...cosmetic.paint, ...patch };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete (paint as Record<string, unknown>)[key];
    }
    this.replace({ ...cosmetic, paint });
  }

  /** Commit through ConfigService, then re-stage the preview off the edited paint. */
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
    const error = await saveConfig(cosmetic);
    this.report(error);
  }

  // ------------------------------------------------------------ preview ----

  /**
   * Stage the hull wearing the edited paint. The bank caches painted masters by
   * (hull, cosmetic), so the edited one has to be invalidated or the preview
   * would keep showing the colours the paint had when it was first staged.
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
    this.baseMaterials = slotNamesOf(base);
    const master = this.paint.masterFor(base, this.cosmeticId || null);
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

function cell(child: Node): HTMLTableCellElement {
  const td = document.createElement("td");
  td.append(child);
  return td;
}

function row(...children: Node[]): HTMLDivElement {
  const div = document.createElement("div");
  div.className = "ed-row";
  div.append(...children);
  return div;
}

function section(title: string): HTMLElement {
  const box = document.createElement("details");
  box.open = true;
  // Stable hook for tests and the screenshot rig: the headings are prose and
  // will be reworded, the slug is what code is allowed to reach for.
  box.dataset["section"] = title.toLowerCase().replace(/\s+/g, "-");
  const summary = document.createElement("summary");
  summary.textContent = title;
  box.append(summary);
  return box;
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

import { themeSchema, type ThemeConfig } from "@space-arena/shared";
import type { EditorHost, EditorPanel } from "./EditorShell.js";
import { SchemaFormGen, type FieldRenderContext } from "./SchemaFormGen.js";
import { saveConfig } from "./saveConfig.js";

/** The free-form `colors` record of a theme (CSS custom property → value). */
export type ColorRecord = ThemeConfig["colors"];

/** First free `theme.custom-N` id. */
export function nextThemeId(existing: readonly string[]): string {
  let n = 1;
  while (existing.includes(`theme.custom-${n}`)) n++;
  return `theme.custom-${n}`;
}

/** CSS custom-property name for a key the designer typed ("hud-glow" → "--hud-glow"). */
export function normalizeColorKey(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("--") ? trimmed : `--${trimmed.replace(/^-+/, "")}`;
}

export function setColor(record: ColorRecord, key: string, value: string): ColorRecord {
  return { ...record, [key]: value };
}

export function removeColor(record: ColorRecord, key: string): ColorRecord {
  const next = { ...record };
  delete next[key];
  return next;
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/**
 * Theme editor (ROADMAP 5.4/5.8): picker + generated form over `themeSchema`,
 * covering the HUD scale, the module-button cluster geometry (anchor, arc,
 * sizes) with its portrait/landscape override blocks, and the haptics patterns.
 *
 * `colors` is a `z.record(string, string)` with no enumerable JSON-schema
 * properties — the same generator gap {@link
 * import("./BotProfileEditor.js").BotProfileEditor} hits with `behaviors` — so
 * it is supplied through the generator's `fields` escape hatch as a
 * swatch-per-variable list with an add row.
 */
export class ThemeEditor implements EditorPanel {
  readonly element = document.createElement("div");
  private selectedId: string | null = null;
  private form: SchemaFormGen<ThemeConfig> | null = null;

  constructor(
    private readonly host: EditorHost,
    private readonly report: (message: string | null) => void,
  ) {
    this.selectedId = this.themes()[0]?.id ?? null;
    this.render();
  }

  private themes(): ThemeConfig[] {
    return this.host.configService.getAll<ThemeConfig>("theme");
  }

  private render(): void {
    this.element.replaceChildren();
    const configs = this.themes();

    const toolbar = document.createElement("div");
    toolbar.className = "ed-toolbar";
    const select = document.createElement("select");
    select.className = "ed-select";
    for (const config of configs) select.append(new Option(config.name ?? config.id, config.id, false, config.id === this.selectedId));
    select.addEventListener("change", () => {
      this.selectedId = select.value;
      this.render();
    });
    const add = document.createElement("button");
    add.type = "button";
    add.className = "ed-btn";
    add.textContent = "New theme";
    add.addEventListener("click", () => this.createFrom(configs));
    const save = document.createElement("button");
    save.type = "button";
    save.className = "ed-btn ed-btn--primary";
    save.textContent = "Save to disk";
    save.addEventListener("click", () => void this.save());
    toolbar.append(label("Theme"), select, add, save);
    this.element.append(toolbar, hint());

    const selected = configs.find((c) => c.id === this.selectedId);
    if (!selected) {
      const empty = document.createElement("div");
      empty.className = "ed-empty";
      empty.textContent = "No theme configs loaded.";
      this.element.append(empty);
      return;
    }

    this.form = new SchemaFormGen<ThemeConfig>({
      schema: themeSchema,
      value: selected,
      configService: this.host.configService,
      onProblem: (p) => this.report(p ? `${selected.id} ${p.path}: ${p.message}` : null),
      fields: { colors: (ctx) => colorsField(ctx) },
    });
    this.element.append(this.form.element);
  }

  private createFrom(configs: ThemeConfig[]): void {
    const template = configs.find((c) => c.id === this.selectedId) ?? configs[0];
    if (!template) {
      this.report("Cannot create a theme: no template loaded.");
      return;
    }
    const id = nextThemeId(configs.map((c) => c.id));
    const clone: ThemeConfig = { ...structuredClone(template), id, name: id };
    const result = this.host.configService.replace(clone);
    if (!result.ok) {
      this.report(result.errors.map((e) => e.message).join("; "));
      return;
    }
    this.selectedId = id;
    this.render();
  }

  private async save(): Promise<void> {
    if (!this.form) return;
    const error = await saveConfig(this.form.getValue());
    if (error) this.report(error);
  }

  dispose(): void {
    this.element.replaceChildren();
  }
}

/** Bespoke renderer for the `colors` record (see class doc). */
function colorsField(ctx: FieldRenderContext): HTMLElement {
  const record = (ctx.value ?? {}) as ColorRecord;
  const commit = (next: ColorRecord): void => ctx.change(ctx.path, next);

  const box = document.createElement("details");
  box.className = "ed-group ed-record";
  box.open = true;
  const summary = document.createElement("summary");
  summary.className = "ed-group-title";
  summary.textContent = `colors (${Object.keys(record).length})`;
  box.append(summary);

  for (const key of Object.keys(record)) {
    box.append(colorRow(key, record[key] ?? "", record, commit));
  }

  const addRow = document.createElement("div");
  addRow.className = "ed-row ed-record-add";
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.className = "ed-input";
  nameInput.placeholder = "--hud-new-var";
  nameInput.dataset["addColorName"] = "";
  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "ed-btn ed-btn--sm";
  addBtn.textContent = "Add color";
  addBtn.addEventListener("click", () => {
    const key = normalizeColorKey(nameInput.value);
    if (!key || record[key] !== undefined) return;
    commit(setColor(record, key, "#ffffff"));
  });
  addRow.append(nameInput, addBtn);
  box.append(addRow);
  return box;
}

function colorRow(key: string, value: string, record: ColorRecord, commit: (next: ColorRecord) => void): HTMLElement {
  const wrap = document.createElement("label");
  wrap.className = "editor-field ed-param";
  const title = document.createElement("span");
  title.textContent = key;
  wrap.append(title);

  const row = document.createElement("div");
  row.className = "ed-control-row";
  const swatch = document.createElement("input");
  swatch.type = "color";
  swatch.className = "ed-color";
  swatch.value = HEX_COLOR.test(value) ? value.toLowerCase() : "#000000";
  const hex = document.createElement("input");
  hex.type = "text";
  hex.className = "ed-input ed-mono ed-color-text";
  hex.name = `colors.${key}`;
  hex.value = value;
  swatch.addEventListener("input", () => { hex.value = swatch.value; });
  swatch.addEventListener("change", () => commit(setColor(record, key, swatch.value)));
  hex.addEventListener("input", () => { if (HEX_COLOR.test(hex.value)) swatch.value = hex.value.toLowerCase(); });
  hex.addEventListener("change", () => commit(setColor(record, key, hex.value)));
  row.append(swatch, hex);
  wrap.append(row);

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "ed-btn ed-btn--ghost ed-btn--sm";
  remove.textContent = "×";
  remove.title = `Remove ${key}`;
  remove.dataset["removeColor"] = key;
  remove.addEventListener("click", () => commit(removeColor(record, key)));
  wrap.append(remove);
  return wrap;
}

function hint(): HTMLElement {
  const note = document.createElement("div");
  note.className = "ed-note";
  note.textContent =
    "hud.moduleCluster drives the in-match button ring; hud.portrait / hud.landscape override it per orientation. Edits apply to the live HUD as soon as the editor closes.";
  return note;
}

function label(value: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = "ed-label";
  span.textContent = value;
  return span;
}

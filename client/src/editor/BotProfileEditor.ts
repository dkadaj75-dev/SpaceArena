import {
  BEHAVIOR_PARAM_SPECS,
  botBehaviors,
  botprofileSchema,
  type BehaviorParamSpec,
  type BotprofileConfig,
} from "@space-arena/shared";
import { BOT_OVERLAY_KEY, botOverlayEnabled, setBotOverlayEnabled } from "../game/botOverlayModel.js";
import type { EditorHost, EditorPanel } from "./EditorShell.js";
import { SchemaFormGen, type FieldRenderContext } from "./SchemaFormGen.js";
import { saveConfig } from "./saveConfig.js";

/** The free-form `behaviors` record of a botprofile. */
export type BehaviorRecord = BotprofileConfig["behaviors"];
type Params = BehaviorRecord[string];

/** Behaviour keys the sim can actually run (the live registry, not a copy). */
export function registeredBehaviorKeys(): string[] {
  return [...botBehaviors().keys()];
}

/** Registered behaviours a profile does not declare yet — the "add" dropdown. */
export function addableBehaviorKeys(record: BehaviorRecord, all = registeredBehaviorKeys()): string[] {
  return all.filter((key) => record[key] === undefined);
}

/** First free `bot.custom-N` id. */
export function nextProfileId(existing: readonly string[]): string {
  let n = 1;
  while (existing.includes(`bot.custom-${n}`)) n++;
  return `bot.custom-${n}`;
}

/** Add a behaviour with a neutral weight (params fall back to behaviour defaults). */
export function addBehavior(record: BehaviorRecord, key: string): BehaviorRecord {
  if (record[key] !== undefined) return record;
  return { ...structuredClone(record), [key]: { baseWeight: 1 } };
}

/** Drop a behaviour entirely — the profile can then never choose it. */
export function removeBehavior(record: BehaviorRecord, key: string): BehaviorRecord {
  const next = structuredClone(record) as Record<string, Params>;
  delete next[key];
  return next;
}

/** Set one tunable (or `baseWeight`) on one behaviour. */
export function setBehaviorParam(record: BehaviorRecord, key: string, param: string, value: unknown): BehaviorRecord {
  const existing = record[key];
  if (!existing) return record;
  const next = structuredClone(record) as Record<string, Record<string, unknown>>;
  next[key]![param] = value;
  return next as BehaviorRecord;
}

/** Remove one tunable so the behaviour falls back to its built-in default. */
export function removeBehaviorParam(record: BehaviorRecord, key: string, param: string): BehaviorRecord {
  const existing = record[key];
  if (!existing) return record;
  const next = structuredClone(record) as Record<string, Record<string, unknown>>;
  delete next[key]![param];
  return next as BehaviorRecord;
}

/** Tunables a behaviour understands that the profile has not set yet. */
export function addableParamKeys(params: Params, key: string): BehaviorParamSpec[] {
  const specs = BEHAVIOR_PARAM_SPECS[key] ?? [];
  const bag = params as Record<string, unknown>;
  return specs.filter((spec) => bag[spec.key] === undefined);
}

function specFor(key: string, param: string): BehaviorParamSpec | undefined {
  return (BEHAVIOR_PARAM_SPECS[key] ?? []).find((s) => s.key === param);
}

/**
 * Behavior Editor (ROADMAP 5.3): profile picker + generated form over
 * `botprofileSchema`, with a bespoke editor for the `behaviors` record.
 *
 * `behaviors` is a `z.record(string, object().catchall(unknown))` — it has no
 * enumerable JSON-schema properties, so the generator cannot render it (a
 * record of addable keys is a known SchemaFormGen gap). It is supplied through
 * the generator's `fields` escape hatch instead: one collapsible section per
 * declared behaviour, a dropdown of registered-but-missing behaviour keys, and
 * per-behaviour tunables driven by `BEHAVIOR_PARAM_SPECS`.
 *
 * Also hosts the on/off switch for the live in-match {@link
 * import("../game/BotDebugOverlay.js").BotDebugOverlay}.
 */
export class BotProfileEditor implements EditorPanel {
  readonly element = document.createElement("div");
  private selectedId: string | null = null;
  private form: SchemaFormGen<BotprofileConfig> | null = null;

  constructor(
    private readonly host: EditorHost,
    private readonly report: (message: string | null) => void,
  ) {
    this.selectedId = host.configService.getAll<BotprofileConfig>("botprofile")[0]?.id ?? null;
    this.render();
  }

  private profiles(): BotprofileConfig[] {
    return this.host.configService.getAll<BotprofileConfig>("botprofile");
  }

  private render(): void {
    this.element.replaceChildren();
    const configs = this.profiles();

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
    add.textContent = "New profile";
    add.addEventListener("click", () => this.createFrom(configs));
    const save = document.createElement("button");
    save.type = "button";
    save.className = "ed-btn ed-btn--primary";
    save.textContent = "Save to disk";
    save.addEventListener("click", () => void this.save());
    toolbar.append(label("Profile"), select, add, save);
    this.element.append(toolbar, this.overlayRow());

    const selected = configs.find((c) => c.id === this.selectedId);
    if (!selected) {
      const empty = document.createElement("div");
      empty.className = "ed-empty";
      empty.textContent = "No bot profiles loaded.";
      this.element.append(empty);
      return;
    }
    this.form = new SchemaFormGen<BotprofileConfig>({
      schema: botprofileSchema,
      value: selected,
      configService: this.host.configService,
      onProblem: (p) => this.report(p ? `${selected.id} ${p.path}: ${p.message}` : null),
      fields: { behaviors: (ctx) => behaviorsField(ctx) },
    });
    this.element.append(this.form.element);
  }

  /** "Show live overlay" — drives the in-match debug overlay (also F8). */
  private overlayRow(): HTMLElement {
    const row = document.createElement("div");
    row.className = "ed-row";
    const toggle = document.createElement("span");
    toggle.className = "ed-toggle";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = botOverlayEnabled();
    input.addEventListener("change", () => setBotOverlayEnabled(input.checked));
    const track = document.createElement("span");
    track.className = "ed-toggle-track";
    toggle.append(input, track);
    const note = document.createElement("span");
    note.className = "ed-note";
    note.textContent = `Show live overlay in practice matches (${BOT_OVERLAY_KEY})`;
    row.append(toggle, note);
    return row;
  }

  private createFrom(configs: BotprofileConfig[]): void {
    const template = configs.find((c) => c.id === this.selectedId) ?? configs[0];
    if (!template) {
      this.report("Cannot create a profile: no template loaded.");
      return;
    }
    const id = nextProfileId(configs.map((c) => c.id));
    const clone: BotprofileConfig = { ...structuredClone(template), id, name: id };
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

/** Bespoke renderer for the `behaviors` record (see class doc). */
function behaviorsField(ctx: FieldRenderContext): HTMLElement {
  const record = (ctx.value ?? {}) as BehaviorRecord;
  const commit = (next: BehaviorRecord): void => ctx.change(ctx.path, next);

  const box = document.createElement("details");
  box.className = "ed-group ed-record";
  box.open = true;
  const summary = document.createElement("summary");
  summary.className = "ed-group-title";
  summary.textContent = `behaviors (${Object.keys(record).length})`;
  box.append(summary);

  for (const key of Object.keys(record)) {
    box.append(behaviorSection(key, record[key]!, record, commit));
  }

  const addable = addableBehaviorKeys(record);
  const addRow = document.createElement("div");
  addRow.className = "ed-row ed-record-add";
  const picker = document.createElement("select");
  picker.className = "ed-select";
  picker.disabled = addable.length === 0;
  picker.append(new Option(addable.length ? "Add behavior…" : "All behaviors added", ""));
  for (const key of addable) picker.append(new Option(key, key));
  picker.addEventListener("change", () => {
    if (picker.value) commit(addBehavior(record, picker.value));
  });
  addRow.append(picker);
  box.append(addRow);
  return box;
}

function behaviorSection(
  key: string,
  params: Params,
  record: BehaviorRecord,
  commit: (next: BehaviorRecord) => void,
): HTMLElement {
  const section = document.createElement("details");
  section.className = "ed-group ed-behavior";
  section.open = true;
  section.dataset.behavior = key;
  const summary = document.createElement("summary");
  summary.className = "ed-group-title";
  summary.textContent = `${key} — weight ${params.baseWeight}`;
  section.append(summary);

  const head = document.createElement("div");
  head.className = "ed-row";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "ed-btn ed-btn--danger ed-btn--sm";
  remove.textContent = "Remove behavior";
  remove.dataset.removeBehavior = key;
  remove.addEventListener("click", () => commit(removeBehavior(record, key)));
  head.append(remove);
  section.append(head);

  // baseWeight is the one schema-declared field: the utility multiplier.
  section.append(
    paramControl(
      { key: "baseWeight", kind: "number", fallback: 1, min: 0, max: 3, doc: "Utility multiplier for this behaviour (0 = never chosen)." },
      params.baseWeight,
      key,
      (value) => commit(setBehaviorParam(record, key, "baseWeight", value)),
      null,
    ),
  );

  const bag = params as Record<string, unknown>;
  for (const param of Object.keys(bag)) {
    if (param === "baseWeight") continue;
    const spec = specFor(key, param) ?? inferSpec(param, bag[param]);
    section.append(
      paramControl(spec, bag[param], key, (value) => commit(setBehaviorParam(record, key, param, value)), () =>
        commit(removeBehaviorParam(record, key, param)),
      ),
    );
  }

  const addable = addableParamKeys(params, key);
  const addRow = document.createElement("div");
  addRow.className = "ed-row ed-record-add";
  const picker = document.createElement("select");
  picker.className = "ed-select";
  picker.dataset.addParamFor = key;
  picker.disabled = addable.length === 0;
  picker.append(new Option(addable.length ? "Add param…" : "All params set", ""));
  for (const spec of addable) picker.append(new Option(spec.key, spec.key));
  picker.addEventListener("change", () => {
    const spec = addable.find((s) => s.key === picker.value);
    if (spec) commit(setBehaviorParam(record, key, spec.key, spec.fallback));
  });
  addRow.append(picker);
  section.append(addRow);
  return section;
}

/** Control for one tunable, plus an optional "reset to default" remove button. */
function paramControl(
  spec: BehaviorParamSpec,
  value: unknown,
  behaviorKey: string,
  onChange: (value: unknown) => void,
  onRemove: (() => void) | null,
): HTMLElement {
  const wrap = document.createElement("label");
  wrap.className = "editor-field ed-param";
  const title = document.createElement("span");
  title.textContent = spec.key;
  title.title = spec.doc;
  wrap.append(title);
  const name = `behaviors.${behaviorKey}.${spec.key}`;

  if (spec.kind === "boolean") {
    const toggle = document.createElement("span");
    toggle.className = "ed-toggle";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.name = name;
    input.checked = value === true;
    input.addEventListener("change", () => onChange(input.checked));
    const track = document.createElement("span");
    track.className = "ed-toggle-track";
    toggle.append(input, track);
    wrap.append(toggle);
  } else if (spec.kind === "enum") {
    const select = document.createElement("select");
    select.className = "ed-select";
    select.name = name;
    for (const option of spec.options ?? []) select.append(new Option(option, option, false, option === value));
    select.addEventListener("change", () => onChange(select.value));
    wrap.append(select);
  } else if (spec.kind === "number") {
    const row = document.createElement("div");
    row.className = "ed-control-row";
    const input = document.createElement("input");
    input.type = "number";
    input.className = "ed-input ed-num";
    input.name = name;
    input.step = "any";
    input.value = String(typeof value === "number" ? value : (spec.fallback as number));
    input.addEventListener("change", () => onChange(Number(input.value)));
    row.append(input);
    if (spec.min !== undefined && spec.max !== undefined) {
      const slider = document.createElement("input");
      slider.type = "range";
      slider.className = "ed-range";
      slider.min = String(spec.min);
      slider.max = String(spec.max);
      slider.step = String((spec.max - spec.min) / 100);
      slider.value = input.value;
      slider.addEventListener("input", () => { input.value = slider.value; });
      slider.addEventListener("change", () => onChange(Number(slider.value)));
      input.addEventListener("input", () => { slider.value = input.value; });
      row.append(slider);
    }
    wrap.append(row);
  } else {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "ed-input";
    input.name = name;
    input.value = String(value ?? "");
    input.addEventListener("change", () => onChange(input.value));
    wrap.append(input);
  }

  if (onRemove) {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "ed-btn ed-btn--ghost ed-btn--sm";
    remove.textContent = "×";
    remove.title = `Reset ${spec.key} to its built-in default`;
    remove.dataset.removeParam = name;
    remove.addEventListener("click", () => onRemove());
    wrap.append(remove);
  }
  return wrap;
}

/** Fallback metadata for a param key no behaviour documents (content may set anything). */
function inferSpec(key: string, value: unknown): BehaviorParamSpec {
  if (typeof value === "boolean") return { key, kind: "boolean", fallback: false, doc: "Custom param." };
  if (typeof value === "number") return { key, kind: "number", fallback: 0, doc: "Custom param." };
  return { key, kind: "enum", fallback: String(value ?? ""), options: [String(value ?? "")], doc: "Custom param." };
}

function label(value: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = "ed-label";
  span.textContent = value;
  return span;
}

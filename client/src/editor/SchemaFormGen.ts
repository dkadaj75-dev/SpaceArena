import { z, type ZodType } from "zod";
import type { ConfigService, ConfigType } from "@space-arena/shared";

export interface FormProblem {
  path: string;
  message: string;
}

/** Everything a bespoke field renderer needs to draw and commit one subtree. */
export interface FieldRenderContext {
  /** Current value at {@link path} (may be `undefined` for absent optionals). */
  value: unknown;
  /** Dotted path segments from the config root. */
  path: string[];
  label: string;
  /** Commit a new value at an arbitrary path — same validation/replace path as generated inputs. */
  change(path: string[], next: unknown): void;
}

/**
 * Renderer for one field the generator cannot express (free-form records, for
 * example). Return `null` to fall back to the generated control.
 */
export type FieldRenderer = (ctx: FieldRenderContext) => HTMLElement | null;

export interface SchemaFormOptions<T> {
  schema: ZodType<T>;
  value: T;
  configService: Pick<ConfigService, "getAll" | "replace">;
  onProblem?: (problem: FormProblem | null) => void;
  /** Stable complete issue list for standalone whole-form rendering. */
  onProblems?: (problems: FormProblem[]) => void;
  onSaved?: (value: T) => void;
  /** Draft editors may retain schema-valid values while pack references are temporarily broken. */
  allowPackInvalid?: boolean;
  /**
   * Bespoke renderers by dotted path (e.g. `"behaviors"`). Escape hatch for
   * shapes with no enumerable JSON-schema properties — a `z.record(...)` of
   * addable keys is the canonical case (see `BotProfileEditor`).
   */
  fields?: Record<string, FieldRenderer>;
}

type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  const?: unknown;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  pattern?: string;
  anyOf?: JsonSchema[];
  /** Zod emits `oneOf` for discriminated unions, `anyOf` for plain ones. */
  oneOf?: JsonSchema[];
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
};

/** Matches a 6-digit hex colour, which we surface as a native colour picker. */
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

let datalistSeq = 0;

const REFERENCE_TYPES: Record<string, ConfigType> = {
  asteroidId: "asteroid",
  defaultFitting: "module",
  onFire: "action",
  onOverheat: "action",
  onActivate: "action",
  onDeactivate: "action",
  actions: "action",
  triggerEvent: "event",
  notification: "notification",
  profile: "botprofile",
  defaultProfile: "botprofile",
  ship: "ship",
  defaultShip: "ship",
  defaultArena: "arena",
  hull: "upgrade",
  engine: "upgrade",
  energy: "upgrade",
  heat: "upgrade",
};

/** Schema-driven HTML form generator used by every editor panel. */
export class SchemaFormGen<T> {
  readonly element: HTMLFormElement;
  private value: T;
  private readonly json: JsonSchema;

  constructor(private readonly options: SchemaFormOptions<T>) {
    this.value = structuredClone(options.value);
    // Zod 4 exposes this stable conversion API; using it preserves constraints
    // such as min/max and enums without coupling the editor to private defs.
    this.json = z.toJSONSchema(options.schema) as JsonSchema;
    this.element = document.createElement("form");
    this.element.className = "editor-schema-form";
    this.render();
  }

  getValue(): T {
    return structuredClone(this.value);
  }

  private render(): void {
    this.element.replaceChildren(this.field(this.json, this.value, [], "Config", true));
  }

  private resolve(schema: JsonSchema): JsonSchema {
    if (!schema.$ref) return schema;
    const key = schema.$ref.split("/").pop();
    return (key && this.json.$defs?.[key]) || schema;
  }

  private field(raw: JsonSchema, value: unknown, path: string[], label: string, root = false): HTMLElement {
    const schema = this.resolve(raw);
    if (!root) {
      const custom = this.options.fields?.[path.join(".")];
      const element = custom?.({ value, path, label, change: (p, next) => this.change(p, next) });
      if (element) return element;
    }
    const union = schema.anyOf ?? schema.oneOf;
    if (union) {
      const branches = union.map((item) => this.resolve(item)).filter((item) => item.type !== "null");
      // A union of literals is really an enum — render it as a <select>.
      const literals = branches.filter((item) => item.const !== undefined).map((item) => item.const);
      if (branches.length > 1 && literals.length === branches.length) {
        return this.scalarField({ type: typeof literals[0] === "number" ? "number" : "string", enum: literals }, value, path, label);
      }
      const tagged = branches.length > 1 ? discriminatorOf(branches) : null;
      if (tagged) return this.unionField(branches, tagged, value, path, label);
      return this.field(branches[0] ?? union[0]!, value, path, label, root);
    }
    if (schema.type === "object" || schema.properties) {
      // z.record/z.unknown/free-form objects have no enumerable properties in
      // JSON Schema. A labelled JSON editor keeps every value authorable while
      // friendly controls remain in place for known shapes.
      if (!root && Object.keys(schema.properties ?? {}).length === 0) return this.jsonField(value, path, label);
      const box = document.createElement(root ? "div" : "details");
      box.className = root ? "ed-form-root" : "ed-group";
      if (!root) {
        (box as HTMLDetailsElement).open = true;
        const summary = document.createElement("summary");
        summary.className = "ed-group-title";
        summary.textContent = label;
        box.append(summary);
      }
      const properties = schema.properties ?? {};
      for (const [key, child] of Object.entries(properties)) {
        const childValue = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
        const childField = this.field(child, childValue, [...path, key], key);
        if (!(schema.required ?? []).includes(key)) {
          const optional = document.createElement("div");
          optional.className = "ed-optional";
          const toggle = document.createElement("span");
          toggle.className = "ed-toggle";
          const present = document.createElement("input");
          present.type = "checkbox"; present.checked = childValue !== undefined;
          present.dataset.presenceFor = [...path, key].join(".");
          const track = document.createElement("span");
          track.className = "ed-toggle-track";
          toggle.append(present, track);
          const presentLabel = document.createElement("span");
          presentLabel.className = "ed-optional-label";
          presentLabel.textContent = `${key} present`;
          childField.hidden = !present.checked;
          present.addEventListener("change", () => this.change([...path, key], present.checked ? defaultFor(child) : undefined));
          optional.append(toggle, presentLabel, childField); box.append(optional);
        } else box.append(childField);
      }
      return box;
    }
    if (schema.type === "array") return this.arrayField(schema, Array.isArray(value) ? value : [], path, label);
    return this.scalarField(schema, value, path, label);
  }

  /**
   * A discriminated union (`winCondition`, `boundaryRule`, …): a `<select>` of
   * the discriminator's literals plus the fields of the *selected* branch only.
   * Switching the discriminator replaces the whole subtree with that branch's
   * defaults, so the value never sits in a shape no branch accepts.
   */
  private unionField(branches: JsonSchema[], key: string, value: unknown, path: string[], label: string): HTMLElement {
    const current = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
    const index = Math.max(0, branches.findIndex((b) => this.resolve(b.properties?.[key] ?? {}).const === current));
    const branch = branches[index]!;
    // Render the branch without its discriminator — the <select> below owns it.
    const { [key]: _discriminator, ...rest } = branch.properties ?? {};
    const body = this.field(
      { ...branch, type: "object", properties: rest, required: (branch.required ?? []).filter((r) => r !== key) },
      value,
      path,
      label,
    );

    const row = document.createElement("label");
    row.className = "editor-field ed-union-kind";
    const title = document.createElement("span");
    title.textContent = key;
    const select = document.createElement("select");
    select.className = "ed-select";
    select.name = [...path, key].join(".");
    branches.forEach((b, i) => {
      const literal = this.resolve(b.properties?.[key] ?? {}).const;
      select.append(new Option(String(literal), String(i), false, i === index));
    });
    select.addEventListener("change", () => this.change(path, defaultFor(branches[Number(select.value)] ?? branch)));
    row.append(title, select);

    // `body` is a <details> group (never root here) — the picker goes first.
    const summary = body.querySelector(":scope > summary");
    if (summary) summary.after(row);
    else body.prepend(row);
    return body;
  }

  private arrayField(schema: JsonSchema, values: unknown[], path: string[], label: string): HTMLElement {
    const wrap = this.wrap(label);
    const list = document.createElement("div");
    list.className = "editor-array";
    values.forEach((item, index) => {
      const row = document.createElement("div");
      row.className = "editor-array-row";
      row.append(this.field(schema.items ?? {}, item, [...path, String(index)], `${label} ${index + 1}`));
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "ed-btn ed-btn--danger ed-btn--sm";
      remove.textContent = "Remove";
      remove.addEventListener("click", () => this.change(path, values.filter((_, i) => i !== index)));
      row.append(remove);
      list.append(row);
    });
    const add = document.createElement("button");
    add.type = "button";
    add.className = "ed-btn ed-btn--sm";
    add.textContent = "Add";
    add.addEventListener("click", () => this.change(path, [...values, defaultFor(schema.items ?? {})]));
    wrap.append(list, add);
    return wrap;
  }

  private scalarField(schema: JsonSchema, value: unknown, path: string[], label: string): HTMLElement {
    const wrap = this.wrap(label);
    const name = path.join(".");
    const referenceType = REFERENCE_TYPES[label];
    let input: HTMLInputElement | HTMLSelectElement;
    /** Extra node appended after the primary control (slider, colour swatch…). */
    let companion: HTMLElement | null = null;

    if (referenceType) {
      // Searchable reference picker: a text box backed by a <datalist> of ids.
      // Keeps typing/filtering on desktop and the native picker on touch, which
      // a plain <select> of hundreds of ids cannot.
      input = document.createElement("input");
      input.type = "text";
      input.className = "ed-input editor-reference";
      input.value = typeof value === "string" ? value : "";
      input.autocomplete = "off";
      input.placeholder = `${referenceType} id…`;
      const list = document.createElement("datalist");
      list.id = `ed-ref-${referenceType}-${++datalistSeq}`;
      const ids = this.options.configService.getAll(referenceType).map((item) => item.id).sort();
      for (const id of ids) list.append(new Option(id, id));
      input.setAttribute("list", list.id);
      companion = list;
    } else if (schema.enum) {
      input = document.createElement("select");
      input.className = "ed-select";
      for (const option of schema.enum) input.append(new Option(String(option), String(option), false, option === value));
    } else if (schema.type === "boolean") {
      input = document.createElement("input");
      input.type = "checkbox";
      input.checked = value === true;
      input.className = "ed-toggle-input";
    } else if (schema.type === "number" || schema.type === "integer") {
      input = document.createElement("input");
      input.type = "number";
      input.className = "ed-input ed-num";
      if (schema.minimum !== undefined) input.min = String(schema.minimum);
      if (schema.maximum !== undefined) input.max = String(schema.maximum);
      input.step = schema.type === "integer" ? "1" : "any";
      input.value = typeof value === "number" || typeof value === "string" ? String(value) : "";
    } else if (isColor(label, schema, value)) {
      input = document.createElement("input");
      input.type = "color";
      input.className = "ed-color";
      input.value = typeof value === "string" && HEX_COLOR.test(value) ? value.toLowerCase() : "#000000";
    } else {
      input = document.createElement("input");
      input.type = "text";
      input.className = "ed-input";
      input.value = typeof value === "string" || typeof value === "number" ? String(value) : "";
    }

    input.name = name;
    input.addEventListener("change", () => this.change(path, inputValue(input, schema)));

    if (input instanceof HTMLInputElement && input.type === "checkbox") {
      // Toggle switch: the visual track is a sibling styled off :checked.
      const toggle = document.createElement("span");
      toggle.className = "ed-toggle";
      const track = document.createElement("span");
      track.className = "ed-toggle-track";
      toggle.append(input, track);
      wrap.append(toggle);
    } else if (input instanceof HTMLInputElement && input.type === "number" && sliderBounds(schema)) {
      // Bounded number: slider + number box, kept in sync both ways. The slider
      // only *commits* on `change` so dragging doesn't re-render every frame.
      const row = document.createElement("div");
      row.className = "ed-control-row";
      const [min, max] = sliderBounds(schema)!;
      const slider = document.createElement("input");
      slider.type = "range";
      slider.className = "ed-range";
      slider.min = String(min);
      slider.max = String(max);
      slider.step = schema.type === "integer" ? "1" : String((max - min) / 100 || "any");
      slider.value = String(typeof value === "number" ? value : min);
      slider.addEventListener("input", () => { input.value = slider.value; });
      slider.addEventListener("change", () => this.change(path, Number(slider.value)));
      input.addEventListener("input", () => { slider.value = input.value; });
      row.append(input, slider);
      wrap.append(row);
    } else if (input instanceof HTMLInputElement && input.type === "color") {
      // Colour: swatch + hex text box, kept in sync.
      const row = document.createElement("div");
      row.className = "ed-control-row";
      const hex = document.createElement("input");
      hex.type = "text";
      hex.className = "ed-input ed-mono ed-color-text";
      hex.dataset.colorFor = name;
      hex.value = typeof value === "string" ? value : "";
      hex.addEventListener("input", () => { if (HEX_COLOR.test(hex.value)) input.value = hex.value.toLowerCase(); });
      hex.addEventListener("change", () => this.change(path, hex.value));
      input.addEventListener("input", () => { hex.value = input.value; });
      row.append(input, hex);
      wrap.append(row);
    } else {
      wrap.append(input);
    }
    if (companion) wrap.append(companion);

    const error = document.createElement("small");
    error.className = "editor-field-error";
    error.dataset.errorFor = path.join(".");
    wrap.append(error);
    return wrap;
  }

  private jsonField(value: unknown, path: string[], label: string): HTMLElement {
    const wrap = this.wrap(`${label} (JSON)`);
    const input = document.createElement("textarea");
    input.className = "ed-input ed-json";
    input.name = path.join("."); input.rows = 7;
    input.value = JSON.stringify(value ?? {}, null, 2);
    const error = document.createElement("small"); error.className = "editor-field-error"; error.dataset.errorFor = path.join(".");
    input.addEventListener("change", () => {
      try { this.change(path, JSON.parse(input.value)); }
      catch { const problem = { path: path.join("."), message: "Enter valid JSON" }; this.showError(problem); this.options.onProblem?.(problem); this.options.onProblems?.([problem]); }
    });
    wrap.append(input, error); return wrap;
  }

  private wrap(label: string): HTMLLabelElement {
    const wrap = document.createElement("label");
    wrap.className = "editor-field";
    const title = document.createElement("span");
    title.textContent = label;
    wrap.append(title);
    return wrap;
  }

  private change(path: string[], next: unknown): void {
    const candidate = structuredClone(this.value) as unknown;
    setPath(candidate, path, next);
    const result = this.options.schema.safeParse(candidate);
    this.clearErrors();
    if (!result.success) {
      const problems = result.error.issues.map((issue) => ({ path: issue.path.map(String).join(".") || path.join("."), message: issue.message }));
      for (const problem of problems) this.showError(problem);
      this.options.onProblem?.(problems[0] ?? null);
      this.options.onProblems?.(problems);
      return;
    }
    const replaced = this.options.configService.replace(result.data);
    if (!replaced.ok) {
      const error = replaced.errors[0] ?? { path: path.join("."), message: "Config was rejected" };
      this.showError(error);
      this.options.onProblem?.(error);
      this.options.onProblems?.([error]);
      if (!this.options.allowPackInvalid) return;
    }
    this.value = result.data;
    this.options.onProblem?.(null);
    this.options.onProblems?.([]);
    this.options.onSaved?.(result.data);
    this.render();
  }

  private clearErrors(): void {
    this.element.querySelectorAll<HTMLElement>("[data-error-for]").forEach((el) => (el.textContent = ""));
  }

  private showError(problem: FormProblem): void {
    const error = this.element.querySelector<HTMLElement>(`[data-error-for="${CSS.escape(problem.path)}"]`);
    if (error) error.textContent = problem.message;
  }
}

/**
 * The discriminator property of an object union: a key every branch declares
 * with a distinct literal (`const`) value. Returns null for unions that are not
 * discriminated, which fall back to the first-branch rendering.
 */
function discriminatorOf(branches: JsonSchema[]): string | null {
  const first = branches[0];
  if (!first?.properties) return null;
  for (const key of Object.keys(first.properties)) {
    const literals = branches.map((b) => b.properties?.[key]?.const);
    if (literals.some((l) => l === undefined)) continue;
    if (new Set(literals).size !== literals.length) continue;
    return key;
  }
  return null;
}

/**
 * Bounds worth drawing a slider for. `z.number().int()` reports JS's max safe
 * integer as its maximum, which would make a 0..9e15 track — those stay a plain
 * number box.
 */
const MAX_SLIDER_SPAN = 1e6;
function sliderBounds(schema: JsonSchema): [number, number] | null {
  const min = schema.minimum;
  const max = schema.maximum;
  if (min === undefined || max === undefined) return null;
  if (max - min > MAX_SLIDER_SPAN) return null;
  return [min, max];
}

function inputValue(input: HTMLInputElement | HTMLSelectElement, schema: JsonSchema): unknown {
  if (input instanceof HTMLInputElement && input.type === "checkbox") return input.checked;
  if (schema.type === "number" || schema.type === "integer") return Number(input.value);
  return input.value;
}
function defaultFor(raw: JsonSchema): unknown {
  const schema = raw;
  if (schema.const !== undefined) return schema.const;
  if (schema.anyOf) {
    const branch = schema.anyOf.find((item) => item.type !== "null");
    if (branch) return defaultFor(branch);
  }
  if (schema.type === "object") return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([key, child]) => [key, defaultFor(child)]));
  if (schema.type === "array") return [];
  if (schema.type === "boolean") return false;
  if (schema.type === "number" || schema.type === "integer") {
    // `exclusiveMinimum` (z.number().positive()) must not seed an invalid 0.
    if (schema.minimum !== undefined) return schema.minimum;
    return schema.exclusiveMinimum !== undefined ? schema.exclusiveMinimum + 1 : 0;
  }
  return schema.enum?.[0] ?? "";
}
function setPath(value: unknown, path: string[], next: unknown): void {
  let target: unknown = value;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]!;
    target = Array.isArray(target) ? target[Number(key)] : (target as Record<string, unknown>)[key];
  }
  const key = path[path.length - 1]!;
  if (Array.isArray(target)) target[Number(key)] = next;
  else (target as Record<string, unknown>)[key] = next;
}
/**
 * A colour picker is only safe when the current value really is a 6-digit hex
 * (`<input type="color">` silently coerces anything else to #000000). Empty
 * values fall back to the field's name/pattern hints.
 */
function isColor(label: string, schema: JsonSchema, value: unknown): boolean {
  if (typeof value === "string" && HEX_COLOR.test(value)) return true;
  if (value !== undefined && value !== "") return false;
  return /color|palette/i.test(label) || schema.pattern?.includes("#") === true;
}

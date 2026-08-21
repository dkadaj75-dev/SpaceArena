import { z, type ZodType } from "zod";
import type { ConfigService, ConfigType } from "@space-arena/shared";
import { referenceTypesFor } from "./referenceFields.js";

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
  /**
   * Extra cross-reference fields keyed by dotted path (`*` for array indices),
   * merged over the table in `referenceFields.ts`. Only needed for a shape that
   * table does not describe — every shipped config type is already covered.
   */
  references?: Record<string, ConfigType | readonly ConfigType[]>;
}

export type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  /**
   * Zod emits this (and NO `items`) for `z.tuple([...])`. A tuple's arity is
   * part of its type, so it is a different control from an array — see
   * {@link SchemaFormGen.tupleField}.
   */
  prefixItems?: JsonSchema[];
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

/** Placeholder option for clearing an optional reference (or an empty fitting slot). */
const NO_REFERENCE = "— none —";

/** Schema-driven HTML form generator used by every editor panel. */
export class SchemaFormGen<T> {
  readonly element: HTMLFormElement;
  private value: T;
  /**
   * Remembered accordion opens, keyed by field path (`propPlacements.3`,
   * `render[]`). Instance-scoped on purpose: a new form (new config selected)
   * starts folded again, but render()'s full rebuild on every commit restores
   * the opens the designer made in THIS form.
   */
  private readonly folds = new Map<string, boolean>();
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
        // Folded by default: a real pack renders hundreds of groups, and a wall
        // of open accordions buries the one being edited. `folds` remembers the
        // designer's opens because render() rebuilds this DOM on every commit —
        // without it the group under the cursor would slam shut on each edit.
        const key = path.join(".");
        (box as HTMLDetailsElement).open = this.folds.get(key) ?? false;
        box.addEventListener("toggle", () => this.folds.set(key, (box as HTMLDetailsElement).open));
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
          present.addEventListener("change", () => this.change([...path, key], present.checked ? defaultFor(child, this.json.$defs) : undefined));
          optional.append(toggle, presentLabel, childField); box.append(optional);
        } else box.append(childField);
      }
      return box;
    }
    // A tuple must be tested BEFORE the array branch: it also reports
    // `type: "array"`, but it carries `prefixItems` instead of `items`.
    if (schema.type === "array" && schema.prefixItems) {
      return this.tupleField(schema.prefixItems, Array.isArray(value) ? value : [], path, label);
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
    select.addEventListener("change", () => this.change(path, defaultFor(branches[Number(select.value)] ?? branch, this.json.$defs)));
    row.append(title, select);

    // `body` is a <details> group (never root here) — the picker goes first.
    const summary = body.querySelector(":scope > summary");
    if (summary) summary.after(row);
    else body.prepend(row);
    return body;
  }

  /**
   * Arrays render as: the "New" action first, then a folded "List of …" group
   * holding every row (each row's own group folded too). A 129-placement arena
   * used to open all of them at once and flood the panel.
   */
  private arrayField(schema: JsonSchema, values: unknown[], path: string[], label: string): HTMLElement {
    const wrap = this.wrap(label);
    const add = document.createElement("button");
    add.type = "button";
    add.className = "ed-btn ed-btn--sm";
    add.textContent = `New ${label}`;
    add.addEventListener("click", () => {
      // Reveal what was just created: the list and the new row open themselves.
      this.folds.set(`${path.join(".")}[]`, true);
      this.folds.set([...path, String(values.length)].join("."), true);
      this.change(path, [...values, defaultFor(schema.items ?? {}, this.json.$defs)]);
    });

    const listKey = `${path.join(".")}[]`;
    const listBox = document.createElement("details");
    listBox.className = "ed-group ed-group--list";
    listBox.open = this.folds.get(listKey) ?? false;
    listBox.addEventListener("toggle", () => this.folds.set(listKey, listBox.open));
    const summary = document.createElement("summary");
    summary.className = "ed-group-title";
    summary.textContent = `List of ${label} (${values.length})`;
    listBox.append(summary);

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
    listBox.append(list);
    wrap.append(add, listBox);
    return wrap;
  }

  /**
   * A FIXED-ARITY tuple (`z.tuple([...])`): `render.star.dir`,
   * `render.skybox.sun.dir`, a nav graph's `[from, to]` link.
   *
   * These reach us as `prefixItems` with no `items`, which the array path could
   * not read — it fell through to `this.field({}, …)` per row, so a sun/star
   * DIRECTION rendered as an add/removable list of untyped TEXT boxes. Typing
   * `0.5` there committed the string "0.5", the tuple's number check rejected
   * it, and the field was therefore un-authorable in the Map editor despite
   * being on screen. Worse, Add/Remove could change the arity, which no tuple
   * accepts at any value.
   *
   * So: the slots are drawn inline, side by side, each with its own typed
   * control from the same {@link field} recursion (numbers get number boxes,
   * hex strings get swatches). No add/remove, and no accordion — three numbers
   * do not deserve a fold, and burying a sun direction one click deeper is the
   * opposite of what a designer aiming a star needs.
   */
  private tupleField(prefixItems: JsonSchema[], values: unknown[], path: string[], label: string): HTMLElement {
    // A <div>, not the usual <label> from wrap(): each slot below is itself a
    // <label> around its own input, and nested labels retarget the outer click.
    const wrap = document.createElement("div");
    wrap.className = "editor-field ed-tuple";
    const title = document.createElement("span");
    title.textContent = label;
    wrap.append(title);

    const row = document.createElement("div");
    row.className = "ed-control-row ed-tuple-row";
    prefixItems.forEach((item, index) => {
      const slot = this.field(item, values[index], [...path, String(index)], tupleSlotLabel(this.resolve(item), index, prefixItems.length));
      slot.classList.add("ed-tuple-slot");
      row.append(slot);
    });
    wrap.append(row);

    // Tuple-level issues (arena's "must be a unit vector" refinement reports at
    // the tuple path, not at a slot) need somewhere to land.
    const error = document.createElement("small");
    error.className = "editor-field-error";
    error.dataset.errorFor = path.join(".");
    wrap.append(error);
    return wrap;
  }

  private scalarField(schema: JsonSchema, value: unknown, path: string[], label: string): HTMLElement {
    const wrap = this.wrap(unitLabel(label));
    const name = path.join(".");
    const referenceTypes = referenceTypesFor(this.configType(), path, this.options.references);
    let input: HTMLInputElement | HTMLSelectElement;

    if (referenceTypes) {
      input = this.referenceField(referenceTypes, value);
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
    // Spinner arrows / scroll steps on a number input emit `input` events with
    // NO `inputType` (typing carries one, e.g. "insertText"). Some engines only
    // fire `change` on blur for stepped values, so the model would lag every
    // arrow click until focus left the field — commit steps immediately, and
    // leave typing to the `change` commit above.
    if (input instanceof HTMLInputElement && input.type === "number") {
      input.addEventListener("input", (ev) => {
        if ((ev as InputEvent).inputType) return;
        this.change(path, inputValue(input, schema));
      });
    }

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

    const error = document.createElement("small");
    error.className = "editor-field-error";
    error.dataset.errorFor = path.join(".");
    wrap.append(error);
    return wrap;
  }

  /** The config type of the value being edited — the key into the reference table. */
  private configType(): string | undefined {
    const type = (this.value as { type?: unknown } | null)?.type;
    return typeof type === "string" ? type : undefined;
  }

  /**
   * Cross-reference picker: a real `<select>` of every live id of the referenced
   * type(s). Two options exist beyond the catalogue — "— none —" for clearing an
   * optional reference or an empty fitting slot, and the current value itself
   * when it resolves to nothing, marked "(missing)" so a dangling id stays
   * visible and selectable instead of silently snapping to another config.
   */
  private referenceField(types: readonly ConfigType[], value: unknown): HTMLSelectElement {
    const select = document.createElement("select");
    select.className = "ed-select editor-reference";
    const current = typeof value === "string" ? value : "";
    select.append(new Option(NO_REFERENCE, "", false, current === ""));

    let known = false;
    for (const type of types) {
      const ids = this.options.configService.getAll(type).map((item) => item.id).sort();
      if (!ids.length) continue;
      // One flat list for a single-type field; grouped when a field is
      // polymorphic (`cosmetic.target` accepts a ship OR a module).
      const target = types.length > 1 ? document.createElement("optgroup") : select;
      if (target instanceof HTMLOptGroupElement) { target.label = type; select.append(target); }
      for (const id of ids) {
        const selected = id === current;
        known ||= selected;
        target.append(new Option(id, id, false, selected));
      }
    }
    if (current && !known) select.append(new Option(`${current} (missing)`, current, false, true));
    select.value = current;
    return select;
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

/** Slot names for a vector tuple, longest axis set the shipped schemas use. */
const TUPLE_AXES = ["x", "y", "z", "w"];

/**
 * What to call one slot of a tuple. Every NUMERIC short tuple in the shipped
 * schemas is a spatial vector (`sun.dir`, `star.dir`), and "x / y / z" is what
 * an author reads off a panorama — "1 / 2 / 3" would make them count. Anything
 * else (a nav link's `[from, to]` pair of ids) keeps a 1-based position, which
 * is the only honest name for a slot with no axis.
 */
function tupleSlotLabel(item: JsonSchema, index: number, arity: number): string {
  const numeric = item.type === "number" || item.type === "integer";
  return numeric && arity <= TUPLE_AXES.length ? TUPLE_AXES[index]! : String(index + 1);
}

/**
 * Units a designer would otherwise have to guess. The schemas already encode
 * the unit in the key's SUFFIX (`durationMs`, `sizePx`, `elevationDeg`), but
 * the generated form printed the bare key — so "2000" on screen could equally
 * be two seconds or two thousand of something, and the only way to find out was
 * to read the schema source. The raw key stays in the label so a field on
 * screen is still greppable against the JSON it writes.
 *
 * Order matters: the compound suffixes must be tested before the simple ones
 * they end with, or `minDegPerSec` would be labelled seconds.
 */
const UNIT_SUFFIXES: readonly (readonly [RegExp, string])[] = [
  [/DegPerSec$/, "deg/s"],
  [/PerSec$/, "per second"],
  [/Ms$/, "ms"],
  [/Sec$/, "s"],
  [/Px$/, "px"],
  [/Deg$/, "deg"],
  [/Units$/, "world units"],
];
export function unitLabel(label: string): string {
  const match = UNIT_SUFFIXES.find(([pattern]) => pattern.test(label));
  return match ? `${label} (${match[1]})` : label;
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
/**
 * The value a field should hold when it first appears — enabling an optional,
 * switching a union branch, adding an array element, or seeding a whole new
 * config. `defs` resolves `$ref`s, which a schema converted
 * from a shared sub-schema is full of.
 */
export function defaultFor(raw: JsonSchema, defs?: Record<string, JsonSchema>): unknown {
  const schema = raw.$ref ? defs?.[raw.$ref.split("/").pop() ?? ""] ?? raw : raw;
  if (schema.const !== undefined) return schema.const;
  const union = schema.anyOf ?? schema.oneOf;
  if (union) {
    const branch = union.find((item) => (item.$ref ? defs?.[item.$ref.split("/").pop() ?? ""]?.type : item.type) !== "null");
    if (branch) return defaultFor(branch, defs);
  }
  if (schema.type === "object" || schema.properties) {
    const required = schema.required;
    return Object.fromEntries(Object.entries(schema.properties ?? {})
      // A skeleton carries only what the schema demands; optionals stay absent
      // so a new config is the smallest thing that validates.
      .filter(([key]) => !required || required.includes(key))
      .map(([key, child]) => [key, defaultFor(child, defs)]));
  }
  // A tuple's arity is part of its type: seeding `[]` (what every array used to
  // get) makes a freshly-enabled `render.star` invalid on the very first render
  // with no way to add the missing slots, since tuples have no add control.
  if (schema.type === "array") return schema.prefixItems ? schema.prefixItems.map((item) => defaultFor(item, defs)) : [];
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

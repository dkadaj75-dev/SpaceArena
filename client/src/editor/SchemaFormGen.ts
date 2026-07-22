import { z, type ZodType } from "zod";
import type { ConfigService, ConfigType } from "@space-arena/shared";

export interface FormProblem {
  path: string;
  message: string;
}

export interface SchemaFormOptions<T> {
  schema: ZodType<T>;
  value: T;
  configService: Pick<ConfigService, "getAll" | "replace">;
  onProblem?: (problem: FormProblem | null) => void;
  onSaved?: (value: T) => void;
}

type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  pattern?: string;
  anyOf?: JsonSchema[];
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
};

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
    if (schema.anyOf) {
      const concrete = schema.anyOf.find((item) => this.resolve(item).type !== "null") ?? schema.anyOf[0]!;
      return this.field(concrete, value, path, label, root);
    }
    if (schema.type === "object" || schema.properties) {
      const box = document.createElement(root ? "div" : "details");
      if (!root) {
        (box as HTMLDetailsElement).open = true;
        const summary = document.createElement("summary");
        summary.textContent = label;
        box.append(summary);
      }
      const properties = schema.properties ?? {};
      for (const [key, child] of Object.entries(properties)) {
        const childValue = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
        const childField = this.field(child, childValue, [...path, key], key);
        if (!(schema.required ?? []).includes(key)) {
          const optional = document.createElement("div");
          const present = document.createElement("input");
          present.type = "checkbox"; present.checked = childValue !== undefined;
          const presentLabel = document.createElement("span"); presentLabel.textContent = `${key} present`;
          childField.hidden = !present.checked;
          present.addEventListener("change", () => this.change([...path, key], present.checked ? defaultFor(child) : undefined));
          optional.append(present, presentLabel, childField); box.append(optional);
        } else box.append(childField);
      }
      return box;
    }
    if (schema.type === "array") return this.arrayField(schema, Array.isArray(value) ? value : [], path, label);
    return this.scalarField(schema, value, path, label);
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
      remove.textContent = "Remove";
      remove.addEventListener("click", () => this.change(path, values.filter((_, i) => i !== index)));
      row.append(remove);
      list.append(row);
    });
    const add = document.createElement("button");
    add.type = "button";
    add.textContent = "Add";
    add.addEventListener("click", () => this.change(path, [...values, defaultFor(schema.items ?? {})]));
    wrap.append(list, add);
    return wrap;
  }

  private scalarField(schema: JsonSchema, value: unknown, path: string[], label: string): HTMLElement {
    const wrap = this.wrap(label);
    const referenceType = REFERENCE_TYPES[label];
    let input: HTMLInputElement | HTMLSelectElement;
    if (referenceType) {
      input = document.createElement("select");
      input.className = "editor-reference";
      const ids = this.options.configService.getAll(referenceType).map((item) => item.id).sort();
      for (const id of ids) input.append(new Option(id, id, false, id === value));
    } else if (schema.enum) {
      input = document.createElement("select");
      for (const option of schema.enum) input.append(new Option(String(option), String(option), false, option === value));
    } else {
      input = document.createElement("input");
      if (schema.type === "number" || schema.type === "integer") {
        input.type = "number";
        if (schema.minimum !== undefined) input.min = String(schema.minimum);
        if (schema.maximum !== undefined) input.max = String(schema.maximum);
        input.step = schema.type === "integer" ? "1" : "any";
      } else if (schema.type === "boolean") {
        input.type = "checkbox";
        input.checked = value === true;
      } else if (isColor(label, schema, value)) input.type = "color";
      else input.type = "text";
      if (input.type !== "checkbox") input.value = typeof value === "string" || typeof value === "number" ? String(value) : "";
    }
    input.name = path.join(".");
    input.addEventListener("change", () => this.change(path, inputValue(input, schema)));
    wrap.append(input);
    if (schema.type === "number" && schema.minimum !== undefined && schema.maximum !== undefined) {
      const slider = document.createElement("input");
      slider.type = "range";
      slider.min = String(schema.minimum);
      slider.max = String(schema.maximum);
      slider.step = input instanceof HTMLInputElement ? input.step : "any";
      slider.value = String(value ?? schema.minimum);
      slider.addEventListener("input", () => {
        if (input instanceof HTMLInputElement) input.value = slider.value;
        this.change(path, Number(slider.value));
      });
      wrap.append(slider);
    }
    const error = document.createElement("small");
    error.className = "editor-field-error";
    error.dataset.errorFor = path.join(".");
    wrap.append(error);
    return wrap;
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
      const issue = result.error.issues[0];
      const problem = { path: issue?.path.map(String).join(".") || path.join("."), message: issue?.message ?? "Invalid value" };
      this.showError(problem);
      this.options.onProblem?.(problem);
      return;
    }
    const replaced = this.options.configService.replace(result.data);
    if (!replaced.ok) {
      const error = replaced.errors[0] ?? { path: path.join("."), message: "Config was rejected" };
      this.showError(error);
      this.options.onProblem?.(error);
      return;
    }
    this.value = result.data;
    this.options.onProblem?.(null);
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

function inputValue(input: HTMLInputElement | HTMLSelectElement, schema: JsonSchema): unknown {
  if (input instanceof HTMLInputElement && input.type === "checkbox") return input.checked;
  if (schema.type === "number" || schema.type === "integer") return Number(input.value);
  return input.value;
}
function defaultFor(raw: JsonSchema): unknown {
  const schema = raw;
  if (schema.type === "object") return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([key, child]) => [key, defaultFor(child)]));
  if (schema.type === "array") return [];
  if (schema.type === "boolean") return false;
  if (schema.type === "number" || schema.type === "integer") return schema.minimum ?? 0;
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
function isColor(label: string, schema: JsonSchema, value: unknown): boolean {
  return /color|palette/i.test(label) || schema.pattern?.includes("#") === true || (typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value));
}

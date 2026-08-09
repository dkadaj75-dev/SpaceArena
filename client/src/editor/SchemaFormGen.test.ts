import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ConfigService } from "@space-arena/shared";
import { SchemaFormGen } from "./SchemaFormGen.js";

const testSchema = z.object({
  id: z.string(),
  name: z.string(),
  nested: z.object({ speed: z.number().min(0).max(10) }),
  note: z.string().optional(),
  mode: z.enum(["a", "b", "c"]),
  tags: z.array(z.string()),
  asteroidId: z.string(),
});

type TestConfig = z.infer<typeof testSchema>;

const baseValue: TestConfig = {
  id: "x.1",
  name: "Thing",
  nested: { speed: 5 },
  mode: "b",
  tags: ["one", "two"],
  asteroidId: "asteroid.small-rock",
};

function fakeConfigService(overrides: Partial<Pick<ConfigService, "getAll" | "replace">> = {}): Pick<ConfigService, "getAll" | "replace"> {
  return {
    getAll: vi.fn(() => [{ id: "asteroid.small-rock" }, { id: "asteroid.large-hazard" }]) as unknown as ConfigService["getAll"],
    replace: vi.fn(() => ({ ok: true, errors: [] })) as unknown as ConfigService["replace"],
    ...overrides,
  };
}

function input(form: SchemaFormGen<TestConfig>, name: string): HTMLInputElement | HTMLSelectElement {
  const el = form.element.querySelector(`[name="${name}"]`);
  if (!el) throw new Error(`no input named ${name}`);
  return el as HTMLInputElement | HTMLSelectElement;
}

describe("SchemaFormGen", () => {
  it("renders inputs for nested objects, optional fields, enum fields, and array fields", () => {
    const configService = fakeConfigService();
    const form = new SchemaFormGen({ schema: testSchema, value: baseValue, configService });

    // Nested object -> collapsible <details> containing the child field.
    const nestedInput = input(form, "nested.speed");
    expect(nestedInput.tagName).toBe("INPUT");
    expect(nestedInput.closest("details")).not.toBeNull();

    // Optional field -> presence checkbox alongside the (hidden, since absent) field.
    const noteInput = form.element.querySelector('[name="note"]') as HTMLInputElement;
    expect(noteInput).not.toBeNull();
    expect((noteInput.closest("label.editor-field") as HTMLElement | null)?.hidden).toBe(true);
    // The presence checkbox is now wrapped in a `.ed-toggle` switch, so it is
    // located by its data attribute rather than by sibling text.
    const presenceCheckbox = form.element.querySelector<HTMLInputElement>('input[type="checkbox"][data-presence-for="note"]');
    expect(presenceCheckbox).not.toBeNull();
    expect(presenceCheckbox!.checked).toBe(false);
    expect(presenceCheckbox!.closest(".ed-toggle")).not.toBeNull();
    expect(presenceCheckbox!.closest(".ed-optional")?.querySelector(".ed-optional-label")?.textContent).toBe("note present");

    // Enum field -> <select> with one option per enum value.
    const modeSelect = input(form, "mode") as HTMLSelectElement;
    expect(modeSelect.tagName).toBe("SELECT");
    expect(Array.from(modeSelect.options).map((o) => o.value)).toEqual(["a", "b", "c"]);
    expect(modeSelect.value).toBe("b");

    // Array field -> add/remove UI, one row per element.
    const arrayWrap = form.element.querySelector(".editor-array")!;
    expect(arrayWrap.querySelectorAll(".editor-array-row")).toHaveLength(2);
    expect(form.element.querySelector('[name="tags.0"]')).not.toBeNull();
  });

  it("triggers configService.replace with the updated value on a valid edit", () => {
    const configService = fakeConfigService();
    const form = new SchemaFormGen({ schema: testSchema, value: baseValue, configService });

    const nameInput = input(form, "name") as HTMLInputElement;
    nameInput.value = "New Name";
    nameInput.dispatchEvent(new Event("change"));

    expect(configService.replace).toHaveBeenCalledTimes(1);
    expect(configService.replace).toHaveBeenCalledWith(expect.objectContaining({ name: "New Name" }));
    expect(form.getValue().name).toBe("New Name");
  });

  it("shows an inline error and does not call replace on an invalid edit", () => {
    const configService = fakeConfigService();
    const onProblem = vi.fn();
    const form = new SchemaFormGen({ schema: testSchema, value: baseValue, configService, onProblem });

    const speedInput = input(form, "nested.speed") as HTMLInputElement;
    speedInput.value = "999";
    speedInput.dispatchEvent(new Event("change"));

    expect(configService.replace).not.toHaveBeenCalled();
    expect(onProblem).toHaveBeenCalledWith(expect.objectContaining({ path: "nested.speed" }));
    const error = form.element.querySelector('[data-error-for="nested.speed"]');
    expect(error?.textContent).toBeTruthy();
    expect(form.getValue().nested.speed).toBe(5);
  });

  it("array add appends a default-shaped item and remove deletes by index", () => {
    const configService = fakeConfigService();
    const form = new SchemaFormGen({ schema: testSchema, value: baseValue, configService });

    const addButton = Array.from(form.element.querySelectorAll("button")).find((b) => b.textContent === "Add")!;
    addButton.click();
    expect(form.getValue().tags).toEqual(["one", "two", ""]);

    const removeButtons = Array.from(form.element.querySelectorAll("button")).filter((b) => b.textContent === "Remove");
    // Remove the first row ("one").
    removeButtons[0]!.click();
    expect(form.getValue().tags).toEqual(["two", ""]);
  });

  it("renders id-reference fields as a searchable input backed by a datalist of configService ids", () => {
    const configService = fakeConfigService();
    const form = new SchemaFormGen({ schema: testSchema, value: baseValue, configService });

    const reference = input(form, "asteroidId") as HTMLInputElement;
    expect(reference.tagName).toBe("INPUT");
    expect(reference.type).toBe("text");
    expect(configService.getAll).toHaveBeenCalledWith("asteroid");
    expect(reference.value).toBe("asteroid.small-rock");

    // The candidate ids live in the linked <datalist>, still sorted.
    const listId = reference.getAttribute("list");
    expect(listId).toBeTruthy();
    const datalist = form.element.querySelector(`datalist#${listId}`) as HTMLDataListElement;
    expect(datalist).not.toBeNull();
    const ids = Array.from(datalist.querySelectorAll("option")).map((o) => o.value);
    expect(ids).toEqual(["asteroid.large-hazard", "asteroid.small-rock"]);
  });

  it("renders a bounded number as a synced number box + range slider, and the slider commits edits", () => {
    const configService = fakeConfigService();
    const form = new SchemaFormGen({ schema: testSchema, value: baseValue, configService });

    const speed = input(form, "nested.speed") as HTMLInputElement;
    expect(speed.type).toBe("number");
    const row = speed.closest(".ed-control-row")!;
    const slider = row.querySelector('input[type="range"]') as HTMLInputElement;
    expect(slider).not.toBeNull();
    expect(slider.min).toBe("0");
    expect(slider.max).toBe("10");
    expect(slider.value).toBe("5");

    // Dragging syncs the number box without committing…
    slider.value = "7";
    slider.dispatchEvent(new Event("input"));
    expect(speed.value).toBe("7");
    expect(configService.replace).not.toHaveBeenCalled();
    // …releasing commits.
    slider.dispatchEvent(new Event("change"));
    expect(configService.replace).toHaveBeenCalledTimes(1);
    expect(form.getValue().nested.speed).toBe(7);
  });

  it("renders booleans as a toggle switch and hex-coloured strings as a colour picker + hex box", () => {
    const schema = z.object({
      id: z.string(),
      enabled: z.boolean(),
      tint: z.string(),
    });
    const configService = fakeConfigService();
    const form = new SchemaFormGen({
      schema,
      value: { id: "x.1", enabled: true, tint: "#57d8ff" },
      configService,
    });

    const toggle = form.element.querySelector('[name="enabled"]') as HTMLInputElement;
    expect(toggle.type).toBe("checkbox");
    expect(toggle.checked).toBe(true);
    expect(toggle.closest(".ed-toggle")?.querySelector(".ed-toggle-track")).not.toBeNull();
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change"));
    expect(configService.replace).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));

    const color = form.element.querySelector('[name="tint"]') as HTMLInputElement;
    expect(color.type).toBe("color");
    const hex = form.element.querySelector('[data-color-for="tint"]') as HTMLInputElement;
    expect(hex.value).toBe("#57d8ff");
    hex.value = "#ff4d5e";
    hex.dispatchEvent(new Event("change"));
    expect(configService.replace).toHaveBeenLastCalledWith(expect.objectContaining({ tint: "#ff4d5e" }));
  });

  it("renders a discriminated union as a kind <select> plus only the selected branch", () => {
    const schema = z.object({
      id: z.string(),
      rule: z.discriminatedUnion("type", [
        z.object({ type: z.literal("bounce"), restitution: z.number().min(0).max(1) }),
        z.object({ type: z.literal("damage"), damagePerSec: z.number().nonnegative() }),
      ]),
    });
    const configService = fakeConfigService();
    const form = new SchemaFormGen({ schema, value: { id: "x.1", rule: { type: "bounce", restitution: 0.5 } }, configService });

    const kind = form.element.querySelector('[name="rule.type"]') as HTMLSelectElement;
    expect(kind.tagName).toBe("SELECT");
    expect(Array.from(kind.options).map((o) => o.textContent)).toEqual(["bounce", "damage"]);
    expect(form.element.querySelector('[name="rule.restitution"]')).not.toBeNull();
    expect(form.element.querySelector('[name="rule.damagePerSec"]')).toBeNull();

    // Switching branch re-seeds the subtree with that branch's defaults.
    kind.value = "1";
    kind.dispatchEvent(new Event("change"));
    expect(form.getValue().rule).toEqual({ type: "damage", damagePerSec: 0 });
    expect(form.element.querySelector('[name="rule.damagePerSec"]')).not.toBeNull();
    expect(form.element.querySelector('[name="rule.restitution"]')).toBeNull();
  });

  it("seeds an exclusive minimum above the bound and skips sliders for unbounded integers", () => {
    const schema = z.object({
      id: z.string(),
      seconds: z.number().positive().optional(),
      count: z.number().int().nonnegative(),
    });
    const configService = fakeConfigService();
    const form = new SchemaFormGen({ schema, value: { id: "x.1", count: 3 }, configService });

    // `z.number().int()` reports MAX_SAFE_INTEGER as its maximum — no slider.
    const count = form.element.querySelector('[name="count"]') as HTMLInputElement;
    expect(count.closest(".ed-control-row")).toBeNull();

    // Enabling an optional `positive()` number must not seed an invalid 0.
    const presence = form.element.querySelector<HTMLInputElement>('[data-presence-for="seconds"]')!;
    presence.checked = true;
    presence.dispatchEvent(new Event("change"));
    expect(form.getValue().seconds).toBe(1);
  });

  it("delegates a field to a bespoke renderer registered by path", () => {
    const schema = z.object({ id: z.string(), bag: z.record(z.string(), z.number()) });
    const configService = fakeConfigService();
    const form = new SchemaFormGen({
      schema,
      value: { id: "x.1", bag: { a: 1 } },
      configService,
      fields: {
        bag: (ctx) => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "custom-bag";
          button.textContent = Object.keys(ctx.value as object).join(",");
          button.addEventListener("click", () => ctx.change(ctx.path, { ...(ctx.value as object), b: 2 }));
          return button;
        },
      },
    });

    const custom = form.element.querySelector<HTMLButtonElement>("button.custom-bag")!;
    expect(custom.textContent).toBe("a");
    custom.click();
    expect(form.getValue().bag).toEqual({ a: 1, b: 2 });
    expect(configService.replace).toHaveBeenCalledWith(expect.objectContaining({ bag: { a: 1, b: 2 } }));
    // The re-render keeps using the bespoke renderer.
    expect(form.element.querySelector<HTMLButtonElement>("button.custom-bag")!.textContent).toBe("a,b");
  });

  it("renders a union of literals as a <select>", () => {
    const schema = z.object({
      id: z.string(),
      shape: z.union([z.literal("box"), z.literal("sphere"), z.literal("cone")]),
    });
    const configService = fakeConfigService();
    const form = new SchemaFormGen({ schema, value: { id: "x.1", shape: "sphere" }, configService });

    const select = form.element.querySelector('[name="shape"]') as HTMLSelectElement;
    expect(select.tagName).toBe("SELECT");
    expect(Array.from(select.options).map((o) => o.value)).toEqual(["box", "sphere", "cone"]);
    expect(select.value).toBe("sphere");
  });

  it("edits arbitrary record keys through the JSON fallback and retains invalid text", () => {
    const schema = z.object({ id: z.string(), params: z.record(z.string(), z.unknown()) });
    const onProblems = vi.fn();
    const form = new SchemaFormGen({ schema, value: { id: "action.x", params: { amount: 1 } }, configService: fakeConfigService(), onProblems });
    const json = form.element.querySelector<HTMLTextAreaElement>('[name="params"]')!;
    expect(json.value).toContain('"amount": 1');
    json.value = '{"amount":2,"newKey":true}'; json.dispatchEvent(new Event("change"));
    expect(form.getValue().params).toEqual({ amount: 2, newKey: true });
    const rerendered = form.element.querySelector<HTMLTextAreaElement>('[name="params"]')!;
    rerendered.value = "{"; rerendered.dispatchEvent(new Event("change"));
    expect(rerendered.value).toBe("{");
    expect(onProblems).toHaveBeenLastCalledWith([{ path: "params", message: "Enter valid JSON" }]);
  });
});

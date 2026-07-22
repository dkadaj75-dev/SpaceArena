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
    const presenceCheckbox = Array.from(form.element.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).find(
      (c) => c.nextSibling?.textContent === "note present",
    );
    expect(presenceCheckbox).toBeDefined();

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

  it("renders id-reference fields as a <select> populated from configService.getAll (current implementation)", () => {
    // Gap note: REFERENCE_TYPES support only a plain <select>, not the
    // "searchable dropdown" called for in ROADMAP §6B 1.11 — there is no
    // text-filter affordance inside the reference dropdown itself.
    const configService = fakeConfigService();
    const form = new SchemaFormGen({ schema: testSchema, value: baseValue, configService });

    const referenceSelect = input(form, "asteroidId");
    expect(referenceSelect.tagName).toBe("SELECT");
    expect(configService.getAll).toHaveBeenCalledWith("asteroid");
    const ids = Array.from((referenceSelect as HTMLSelectElement).options).map((o) => o.value);
    expect(ids).toEqual(["asteroid.large-hazard", "asteroid.small-rock"]);
    expect((referenceSelect as HTMLSelectElement).value).toBe("asteroid.small-rock");
  });
});

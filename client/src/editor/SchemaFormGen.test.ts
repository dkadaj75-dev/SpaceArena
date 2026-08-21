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
  asteroidId: "asteroid.rock-a",
};

function fakeConfigService(overrides: Partial<Pick<ConfigService, "getAll" | "replace">> = {}): Pick<ConfigService, "getAll" | "replace"> {
  return {
    getAll: vi.fn(() => [{ id: "asteroid.rock-a" }, { id: "asteroid.rock-b" }]) as unknown as ConfigService["getAll"],
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

    const addButton = Array.from(form.element.querySelectorAll("button")).find((b) => b.textContent === "New tags")!;
    addButton.click();
    expect(form.getValue().tags).toEqual(["one", "two", ""]);

    const removeButtons = Array.from(form.element.querySelectorAll("button")).filter((b) => b.textContent === "Remove");
    // Remove the first row ("one").
    removeButtons[0]!.click();
    expect(form.getValue().tags).toEqual(["two", ""]);
  });

  it("renders id-reference fields as a <select> of live configService ids plus a none option", () => {
    const configService = fakeConfigService();
    const form = new SchemaFormGen({ schema: testSchema, value: baseValue, configService, references: { asteroidId: "asteroid" } });

    const reference = input(form, "asteroidId") as HTMLSelectElement;
    expect(reference.tagName).toBe("SELECT");
    expect(configService.getAll).toHaveBeenCalledWith("asteroid");
    expect(reference.value).toBe("asteroid.rock-a");
    // Sorted catalogue, preceded by the clear option.
    expect(Array.from(reference.options).map((o) => o.value)).toEqual(["", "asteroid.rock-a", "asteroid.rock-b"]);

    reference.value = "asteroid.rock-b";
    reference.dispatchEvent(new Event("change"));
    expect(configService.replace).toHaveBeenCalledWith(expect.objectContaining({ asteroidId: "asteroid.rock-b" }));
  });

  it("keeps a dangling reference selectable and marks it missing", () => {
    const configService = fakeConfigService();
    const form = new SchemaFormGen({
      schema: testSchema,
      value: { ...baseValue, asteroidId: "asteroid.deleted" },
      configService,
      references: { asteroidId: "asteroid" },
    });

    const reference = input(form, "asteroidId") as HTMLSelectElement;
    expect(reference.value).toBe("asteroid.deleted");
    const missing = Array.from(reference.options).find((o) => o.value === "asteroid.deleted")!;
    expect(missing.textContent).toBe("asteroid.deleted (missing)");
  });

  it("resolves references nested inside arrays, not just immediate property names", () => {
    const schema = z.object({
      id: z.string(),
      type: z.literal("gamemode"),
      bots: z.object({ shipPool: z.array(z.string()), roster: z.array(z.object({ profile: z.string() })) }),
    });
    const configService = {
      getAll: vi.fn((type: string) => (type === "ship" ? [{ id: "ship.a" }] : [{ id: "bot.ace" }])) as unknown as ConfigService["getAll"],
      replace: vi.fn(() => ({ ok: true, errors: [] })) as unknown as ConfigService["replace"],
    };
    const form = new SchemaFormGen({
      schema,
      value: { id: "gamemode.x", type: "gamemode", bots: { shipPool: ["ship.a"], roster: [{ profile: "bot.ace" }] } },
      configService,
    });

    // The config type is read off the value, so the shipped path table applies.
    const pool = form.element.querySelector('[name="bots.shipPool.0"]') as HTMLSelectElement;
    expect(pool.tagName).toBe("SELECT");
    expect(Array.from(pool.options).map((o) => o.value)).toEqual(["", "ship.a"]);
    const profile = form.element.querySelector('[name="bots.roster.0.profile"]') as HTMLSelectElement;
    expect(profile.tagName).toBe("SELECT");
    expect(profile.value).toBe("bot.ace");
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

describe("SchemaFormGen folded accordions", () => {
  it("renders groups and array lists folded by default", () => {
    const configService = fakeConfigService();
    const form = new SchemaFormGen({ schema: testSchema, value: baseValue, configService });

    const nested = form.element.querySelector<HTMLDetailsElement>('[name="nested.speed"]')!.closest("details")!;
    expect(nested.open).toBe(false);

    const list = form.element.querySelector<HTMLDetailsElement>("details.ed-group--list")!;
    expect(list.open).toBe(false);
    expect(list.querySelector("summary")!.textContent).toBe("List of tags (2)");
    // The create action sits before the folded list, visible without opening it.
    const newButton = Array.from(form.element.querySelectorAll("button")).find((b) => b.textContent === "New tags")!;
    expect(newButton.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("remembers opened groups across the full re-render a commit causes", () => {
    const configService = fakeConfigService();
    const form = new SchemaFormGen({ schema: testSchema, value: baseValue, configService });

    const nested = form.element.querySelector<HTMLDetailsElement>('[name="nested.speed"]')!.closest("details")!;
    nested.open = true;
    nested.dispatchEvent(new Event("toggle"));

    // A committed edit rebuilds the whole form.
    const speed = input(form, "nested.speed") as HTMLInputElement;
    speed.value = "7";
    speed.dispatchEvent(new Event("change"));

    const rebuilt = form.element.querySelector<HTMLDetailsElement>('[name="nested.speed"]')!.closest("details")!;
    expect(rebuilt).not.toBe(nested);
    expect(rebuilt.open).toBe(true);
    // Untouched groups stay folded.
    expect(form.element.querySelector<HTMLDetailsElement>("details.ed-group--list")!.open).toBe(false);
  });

  it("New opens the list and reveals the row it just created", () => {
    const configService = fakeConfigService();
    const form = new SchemaFormGen({ schema: testSchema, value: baseValue, configService });

    Array.from(form.element.querySelectorAll("button")).find((b) => b.textContent === "New tags")!.click();

    expect(form.getValue().tags).toEqual(["one", "two", ""]);
    const list = form.element.querySelector<HTMLDetailsElement>("details.ed-group--list")!;
    expect(list.open).toBe(true);
    expect(list.querySelector("summary")!.textContent).toBe("List of tags (3)");
  });
});

/**
 * `z.tuple([...])` reaches the generator as `prefixItems` with NO `items`,
 * which the array path could not read — a sun/star direction used to render as
 * an add/removable list of untyped text boxes, so it could not be authored at
 * all (see `SchemaFormGen.tupleField`).
 */
describe("SchemaFormGen tuple fields", () => {
  const vectorSchema = z.object({
    id: z.string(),
    dir: z.tuple([z.number(), z.number(), z.number()]),
    link: z.tuple([z.string(), z.string()]),
    star: z.object({ dir: z.tuple([z.number(), z.number(), z.number()]) }).optional(),
  });
  type VectorConfig = z.infer<typeof vectorSchema>;
  const vectorValue: VectorConfig = { id: "x.1", dir: [0, 0.5, -1], link: ["a", "b"] };

  function vectorForm(): SchemaFormGen<VectorConfig> {
    return new SchemaFormGen({ schema: vectorSchema, value: vectorValue, configService: fakeConfigService() });
  }

  it("renders one typed slot per tuple position, with no add/remove control", () => {
    const form = vectorForm();

    const x = form.element.querySelector<HTMLInputElement>('[name="dir.0"]')!;
    const y = form.element.querySelector<HTMLInputElement>('[name="dir.1"]')!;
    const z3 = form.element.querySelector<HTMLInputElement>('[name="dir.2"]')!;
    // Number boxes, not the text boxes the old array fallback produced.
    expect([x.type, y.type, z3.type]).toEqual(["number", "number", "number"]);
    expect([x.value, y.value, z3.value]).toEqual(["0", "0.5", "-1"]);
    // Arity is part of the type: no "New dir" and no per-slot "Remove".
    const buttons = Array.from(form.element.querySelectorAll("button")).map((b) => b.textContent);
    expect(buttons).not.toContain("New dir");
    expect(buttons).not.toContain("Remove");
    // Inline, not buried in an accordion — aiming a star should not cost a click.
    expect(x.closest("details")).toBeNull();
  });

  it("labels a numeric vector's slots by axis and a non-numeric tuple's by position", () => {
    const form = vectorForm();
    const caption = (name: string): string | null | undefined =>
      form.element.querySelector(`[name="${name}"]`)?.closest(".ed-tuple-slot")?.querySelector("span")?.textContent;

    expect([caption("dir.0"), caption("dir.1"), caption("dir.2")]).toEqual(["x", "y", "z"]);
    expect([caption("link.0"), caption("link.1")]).toEqual(["1", "2"]);
  });

  it("commits a slot edit as a number, keeping the other slots intact", () => {
    const form = vectorForm();
    const y = form.element.querySelector<HTMLInputElement>('[name="dir.1"]')!;
    y.value = "0.75";
    y.dispatchEvent(new Event("change"));

    expect(form.getValue().dir).toEqual([0, 0.75, -1]);
  });

  it("seeds a tuple at full arity when an optional block is switched on", () => {
    const form = vectorForm();
    const presence = form.element.querySelector<HTMLInputElement>('input[data-presence-for="star"]')!;
    presence.checked = true;
    presence.dispatchEvent(new Event("change"));

    // `[]` (the old array default) would leave the block permanently invalid:
    // tuples have no add control to fill the missing slots with.
    expect(form.getValue().star?.dir).toEqual([0, 0, 0]);
  });
});

describe("SchemaFormGen unit hints", () => {
  const unitSchema = z.object({
    id: z.string(),
    durationMs: z.number(),
    sizePx: z.number(),
    elevationDeg: z.number(),
    minDegPerSec: z.number(),
    rangeUnits: z.number(),
    intensity: z.number(),
  });
  type UnitConfig = z.infer<typeof unitSchema>;

  it("appends the unit the key's suffix encodes, and nothing when there is none", () => {
    const form = new SchemaFormGen<UnitConfig>({
      schema: unitSchema,
      value: { id: "x.1", durationMs: 1, sizePx: 1, elevationDeg: 1, minDegPerSec: 1, rangeUnits: 1, intensity: 1 },
      configService: fakeConfigService(),
    });
    const caption = (name: string): string | null | undefined =>
      form.element.querySelector(`[name="${name}"]`)?.closest(".editor-field")?.querySelector("span")?.textContent;

    expect(caption("durationMs")).toBe("durationMs (ms)");
    expect(caption("sizePx")).toBe("sizePx (px)");
    expect(caption("elevationDeg")).toBe("elevationDeg (deg)");
    // Compound suffix wins over the simple one it ends with.
    expect(caption("minDegPerSec")).toBe("minDegPerSec (deg/s)");
    expect(caption("rangeUnits")).toBe("rangeUnits (world units)");
    // The key stays greppable against the JSON it writes; unitless keys are untouched.
    expect(caption("intensity")).toBe("intensity");
  });
});

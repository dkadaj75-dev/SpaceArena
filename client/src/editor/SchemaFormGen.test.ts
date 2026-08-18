import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CONFIG_SCHEMAS, type ConfigService } from "@space-arena/shared";
import { AccordionState } from "./accordion.js";
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

/**
 * A repo-root file, for the smoke test that renders real shipped content. Vite
 * rewrites `import.meta.url` to an http URL in this project, so the lookup walks
 * up from the cwd (repo root or `client/`, depending on how vitest was invoked).
 */
function repoFile(relative: string): string {
  for (const prefix of ["", "..", "../.."]) {
    const candidate = resolve(process.cwd(), prefix, relative);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`cannot locate ${relative} from ${process.cwd()}`);
}

function input(form: SchemaFormGen<TestConfig>, name: string): HTMLInputElement | HTMLSelectElement {
  const el = form.element.querySelector(`[name="${name}"]`);
  if (!el) throw new Error(`no input named ${name}`);
  return el as HTMLInputElement | HTMLSelectElement;
}

// Fold state is namespaced per config type when a scope is given; clear it so
// one test's disclosure never decides another's starting shape.
beforeEach(() => {
  localStorage.clear();
});

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

    // Array field -> folded list accordion, one row per element.
    const arrayWrap = form.element.querySelector(".editor-array")!;
    expect(arrayWrap.querySelectorAll(".editor-array-row")).toHaveLength(2);
    expect(form.element.querySelector('[name="tags.0"]')).not.toBeNull();
  });

  it("renders every array as a folded New-first-then-List accordion", () => {
    const schema = z.object({
      id: z.string(),
      propPlacements: z.array(z.object({ propId: z.string(), scale: z.number() })),
    });
    const form = new SchemaFormGen({
      schema,
      value: { id: "arena.x", propPlacements: [{ propId: "a", scale: 1 }, { propId: "b", scale: 2 }] },
      configService: fakeConfigService(),
      accordions: new AccordionState("", null),
    });

    const list = form.element.querySelector<HTMLDetailsElement>('[data-accordion="propPlacements"]')!;
    expect(list.open).toBe(false);
    expect(list.firstElementChild!.textContent).toContain("Prop Placements");

    // Create action comes before the list, and the list is folded too.
    const add = list.querySelector<HTMLButtonElement>('.ed-list-create [data-action="add"]')!;
    expect(add.textContent).toBe("New prop placement");
    const inner = form.element.querySelector<HTMLDetailsElement>('[data-accordion="propPlacements[]"]')!;
    expect(inner.open).toBe(false);
    expect(list.compareDocumentPosition(inner) & Node.DOCUMENT_POSITION_CONTAINED_BY).toBeTruthy();

    // Each row is itself folded — this is what stopped 24 props flooding the panel.
    const rows = inner.querySelectorAll<HTMLDetailsElement>(".editor-array-row > details");
    expect(rows).toHaveLength(2);
    expect(Array.from(rows).map((row) => row.open)).toEqual([false, false]);
    expect(rows[0]!.firstElementChild!.textContent).toContain("Prop placement 1");

    // A plain nested object is NOT a list and keeps its open default.
    expect(form.element.querySelector<HTMLDetailsElement>('[data-accordion="propPlacements.0"]')!.open).toBe(false);
  });

  it("keeps opened groups open across the re-render an edit triggers, and reveals what New creates", () => {
    const schema = z.object({ id: z.string(), sockets: z.array(z.object({ kind: z.string() })) });
    const form = new SchemaFormGen({
      schema,
      value: { id: "ship.x", sockets: [{ kind: "hardpoint" }] },
      configService: fakeConfigService(),
      accordions: new AccordionState("", null),
    });

    const open = (selector: string): void => {
      const box = form.element.querySelector<HTMLDetailsElement>(selector)!;
      box.open = true;
      box.dispatchEvent(new Event("toggle"));
    };
    open('[data-accordion="sockets"]');
    open('[data-accordion="sockets[]"]');
    open('[data-accordion="sockets.0"]');

    const kind = form.element.querySelector<HTMLInputElement>('[name="sockets.0.kind"]')!;
    kind.value = "emitter";
    kind.dispatchEvent(new Event("change"));

    // Without the remembered state the form would refold under the cursor.
    expect(form.element.querySelector<HTMLDetailsElement>('[data-accordion="sockets"]')!.open).toBe(true);
    expect(form.element.querySelector<HTMLDetailsElement>('[data-accordion="sockets.0"]')!.open).toBe(true);

    // "New socket" must show the thing it just made.
    form.element.querySelector<HTMLButtonElement>('[data-accordion="sockets"] > .ed-list-create [data-action="add"]')!.click();
    expect(form.getValue().sockets).toHaveLength(2);
    expect(form.element.querySelector<HTMLDetailsElement>('[data-accordion="sockets[]"]')!.open).toBe(true);
    expect(form.element.querySelector<HTMLDetailsElement>('[data-accordion="sockets.1"]')!.open).toBe(true);
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

    // The generic "Add" is now a named create action at the top of the list.
    const addButton = form.element.querySelector<HTMLButtonElement>('[data-accordion="tags"] [data-action="add"]')!;
    expect(addButton.textContent).toBe("New tag");
    addButton.click();
    expect(form.getValue().tags).toEqual(["one", "two", ""]);

    const removeButtons = Array.from(form.element.querySelectorAll<HTMLButtonElement>('[data-action="remove"]'));
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
    expect(reference.value).toBe("asteroid.small-rock");
    // Sorted catalogue, preceded by the clear option.
    expect(Array.from(reference.options).map((o) => o.value)).toEqual(["", "asteroid.large-hazard", "asteroid.small-rock"]);

    reference.value = "asteroid.large-hazard";
    reference.dispatchEvent(new Event("change"));
    expect(configService.replace).toHaveBeenCalledWith(expect.objectContaining({ asteroidId: "asteroid.large-hazard" }));
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

  it("keeps the shipped 129-prop arena folded instead of flooding the panel", () => {
    // The arena that motivated this: lunar-rift ships 129 prop placements, and
    // every one of them used to render as an open object form on selection.
    const arena = JSON.parse(readFileSync(repoFile("content/arenas/lunar-rift.json"), "utf8")) as unknown;
    const form = new SchemaFormGen({
      schema: CONFIG_SCHEMAS.arena,
      value: CONFIG_SCHEMAS.arena.parse(arena),
      configService: fakeConfigService(),
      accordions: new AccordionState("", null),
    });

    const props = form.element.querySelector<HTMLDetailsElement>('[data-accordion="propPlacements"]')!;
    expect(props.open).toBe(false);
    expect(props.firstElementChild!.querySelector(".ed-count")?.textContent).toBe("129");
    expect(props.querySelector<HTMLButtonElement>('.ed-list-create [data-action="add"]')!.textContent).toBe("New prop placement");
    expect(form.element.querySelector<HTMLDetailsElement>('[data-accordion="propPlacements[]"]')!.open).toBe(false);
    // EVERY list on the arena tool follows the same rule — not just props.
    const lists = Array.from(form.element.querySelectorAll<HTMLDetailsElement>("details.ed-list"));
    expect(lists.length).toBeGreaterThan(3);
    expect(lists.filter((box) => box.open)).toHaveLength(0);

    // What is left open on sight is only small single-purpose forms (`bounds`,
    // `sky`, …) — the useful defaults the fold was never meant to destroy.
    const exposed = Array.from(form.element.querySelectorAll<HTMLDetailsElement>("details[open]"))
      .filter((box) => !box.parentElement?.closest("details:not([open])"));
    expect(exposed.every((box) => !box.classList.contains("ed-list"))).toBe(true);
    expect(exposed.length).toBeLessThan(12);
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

import { afterEach, describe, expect, it, vi } from "vitest";
import { tuningSchema, type ConfigService, type TuningConfig } from "@space-arena/shared";
import type { EditorHost } from "./EditorShell.js";
import { TuningPanel } from "./TuningPanel.js";

afterEach(() => vi.unstubAllGlobals());

function tuning(): TuningConfig {
  return tuningSchema.parse({
    id: "tuning.default",
    type: "tuning",
    version: 1,
    targetingPolicy: "nearest",
    globalDamageMult: 1,
  });
}

describe("TuningPanel persistence feedback", () => {
  it("reports endpoint failures through the editor problem UI", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("disk denied", { status: 400 })));
    const configService = {
      getAll: vi.fn((type: string) => (type === "tuning" ? [tuning()] : [])),
      replace: vi.fn(() => ({ ok: true as const, errors: [] })),
    } as unknown as ConfigService;
    const report = vi.fn();
    const panel = new TuningPanel({ configService } as unknown as EditorHost, report);

    panel.element.querySelector<HTMLButtonElement>(".ed-btn--primary")!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(report).toHaveBeenCalledWith(expect.stringContaining("disk denied"));
    panel.dispose();
    panel.element.remove();
  });
});

describe("TuningPanel accordions", () => {
  function panelWith(report = vi.fn()): TuningPanel {
    const configService = {
      getAll: vi.fn((type: string) => (type === "tuning" ? [tuning()] : [])),
      replace: vi.fn(() => ({ ok: true as const, errors: [] })),
    } as unknown as ConfigService;
    const panel = new TuningPanel({ configService } as unknown as EditorHost, report);
    // The filter walks labels with `:scope > span`, which only resolves against
    // an attached root in happy-dom — the real editor always mounts its panel.
    document.body.append(panel.element);
    return panel;
  }

  it("opens folded, and a filter hit reveals its section", () => {
    const panel = panelWith();
    const section = panel.element.querySelector<HTMLDetailsElement>("details")!;
    expect(section.open).toBe(false);

    const search = panel.element.querySelector<HTMLInputElement>('input[type="search"]')!;
    search.value = "globalDamage";
    search.dispatchEvent(new Event("input"));
    // Searching a wall of shut accordions and being shown nothing would make
    // the filter useless, so a hit opens its own section.
    expect(section.open).toBe(true);

    panel.dispose();
    panel.element.remove();
  });

  it("folds back when the filter is cleared, but honours a designer's own open", () => {
    const panel = panelWith();
    const section = panel.element.querySelector<HTMLDetailsElement>("details")!;
    const search = panel.element.querySelector<HTMLInputElement>('input[type="search"]')!;

    search.value = "globalDamage";
    search.dispatchEvent(new Event("input"));
    search.value = "";
    search.dispatchEvent(new Event("input"));
    expect(section.open).toBe(false);

    // An explicit toggle with no filter active is the designer's choice and
    // must survive the refilter the form's rebuild triggers.
    section.open = true;
    section.dispatchEvent(new Event("toggle"));
    search.dispatchEvent(new Event("input"));
    expect(section.open).toBe(true);

    panel.dispose();
    panel.element.remove();
  });

  it("misses fold the section rather than leaving it open on nothing", () => {
    const panel = panelWith();
    const section = panel.element.querySelector<HTMLDetailsElement>("details")!;
    const search = panel.element.querySelector<HTMLInputElement>('input[type="search"]')!;

    search.value = "zzz-no-such-field";
    search.dispatchEvent(new Event("input"));
    expect(section.open).toBe(false);

    panel.dispose();
    panel.element.remove();
  });
});

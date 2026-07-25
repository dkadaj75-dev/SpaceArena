import { describe, expect, it, vi } from "vitest";
import type { BotprofileConfig, ConfigService } from "@space-arena/shared";
import {
  addBehavior,
  addableBehaviorKeys,
  addableParamKeys,
  BotProfileEditor,
  nextProfileId,
  registeredBehaviorKeys,
  removeBehavior,
  removeBehaviorParam,
  setBehaviorParam,
  type BehaviorRecord,
} from "./BotProfileEditor.js";
import type { EditorHost } from "./EditorShell.js";

function profile(over: Partial<BotprofileConfig> = {}): BotprofileConfig {
  return {
    id: "bot.aggressive",
    type: "botprofile",
    version: 1,
    name: "Aggressive",
    decisionIntervalMs: 400,
    orderJitterMs: 150,
    preferredRange: [20, 35],
    behaviors: {
      engage: { baseWeight: 1, boostChance: 0.4, targetPreference: "nearest" },
      kite: { baseWeight: 0.5 },
    },
    moduleDiscipline: { heatShutdownAt: 0.85, reactivateBelow: 0.5, energyReserve: 0.15, shieldOnlyWhenEngaged: true },
    ...over,
  } as BotprofileConfig;
}

/** Editor host backed by an in-memory single-profile registry. */
function fakeHost(profiles: BotprofileConfig[]): { host: EditorHost; replace: ReturnType<typeof vi.fn> } {
  const replace = vi.fn((config: BotprofileConfig) => {
    const index = profiles.findIndex((p) => p.id === config.id);
    if (index >= 0) profiles[index] = config;
    else profiles.push(config);
    return { ok: true as const, errors: [] };
  });
  const configService = {
    getAll: vi.fn((type: string) => (type === "botprofile" ? profiles : [])),
    replace,
  } as unknown as ConfigService;
  return { host: { configService } as unknown as EditorHost, replace };
}

describe("botprofile behaviour record helpers", () => {
  const record = profile().behaviors;

  it("lists registered behaviours that the profile has not declared yet", () => {
    expect(registeredBehaviorKeys()).toEqual(expect.arrayContaining(["engage", "kite", "breakLoS", "retreat", "dodge"]));
    expect(addableBehaviorKeys(record)).toEqual(expect.arrayContaining(["breakLoS", "retreat", "dodge"]));
    expect(addableBehaviorKeys(record)).not.toContain("engage");
  });

  it("adds a behaviour with a neutral weight without touching the original record", () => {
    const next = addBehavior(record, "retreat");
    expect(next["retreat"]).toEqual({ baseWeight: 1 });
    expect(record["retreat"]).toBeUndefined();
    // Adding an existing key is a no-op (never clobbers tuned params).
    expect(addBehavior(record, "engage")).toBe(record);
  });

  it("removes a behaviour and leaves the rest intact", () => {
    const next = removeBehavior(record, "engage");
    expect(Object.keys(next)).toEqual(["kite"]);
    expect(Object.keys(record)).toEqual(["engage", "kite"]);
  });

  it("sets and clears individual params", () => {
    const withParam = setBehaviorParam(record, "kite", "urgencyGain", 2.5);
    expect(withParam["kite"]).toEqual({ baseWeight: 0.5, urgencyGain: 2.5 });
    const cleared = removeBehaviorParam(withParam, "kite", "urgencyGain");
    expect(cleared["kite"]).toEqual({ baseWeight: 0.5 });
    // Unknown behaviour keys are inert.
    expect(setBehaviorParam(record, "nope", "x", 1)).toBe(record);
  });

  it("offers only unset tunables for a behaviour", () => {
    const keys = addableParamKeys(record["engage"]!, "engage").map((s) => s.key);
    expect(keys).not.toContain("boostChance");
    expect(keys).not.toContain("targetPreference");
    expect(keys).toContain("throttleBand");
  });

  it("picks the first free custom profile id", () => {
    expect(nextProfileId(["bot.aggressive"])).toBe("bot.custom-1");
    expect(nextProfileId(["bot.custom-1", "bot.custom-2"])).toBe("bot.custom-3");
  });
});

describe("BotProfileEditor panel", () => {
  it("renders one collapsible section per behaviour plus an add dropdown", () => {
    const { host } = fakeHost([profile()]);
    const panel = new BotProfileEditor(host, vi.fn());

    const sections = panel.element.querySelectorAll<HTMLDetailsElement>("details.ed-behavior");
    expect(Array.from(sections).map((s) => s.dataset["behavior"])).toEqual(["engage", "kite"]);
    // Schema-declared fields still come from the generator.
    expect(panel.element.querySelector('[name="decisionIntervalMs"]')).not.toBeNull();
    // Tunables render with their behaviour-specific control (enum -> <select>).
    const preference = panel.element.querySelector<HTMLSelectElement>('[name="behaviors.engage.targetPreference"]');
    expect(preference?.tagName).toBe("SELECT");
    expect(Array.from(preference!.options).map((o) => o.value)).toEqual(["nearest", "lowestHull"]);

    const addable = Array.from(
      panel.element.querySelectorAll<HTMLSelectElement>(".ed-record > .ed-record-add select")[0]!.options,
    ).map((o) => o.value);
    expect(addable).toEqual(["", "breakLoS", "retreat", "dodge", "avoidRocks"]);
  });

  it("commits behaviour add/remove and param edits through the config service", () => {
    const profiles = [profile()];
    const { host, replace } = fakeHost(profiles);
    const panel = new BotProfileEditor(host, vi.fn());

    // Tuning a weight commits the whole profile.
    const weight = panel.element.querySelector<HTMLInputElement>('[name="behaviors.engage.baseWeight"]')!;
    weight.value = "2";
    weight.dispatchEvent(new Event("change"));
    expect(replace).toHaveBeenLastCalledWith(
      expect.objectContaining({ behaviors: expect.objectContaining({ engage: expect.objectContaining({ baseWeight: 2 }) }) }),
    );

    // Adding a behaviour from the dropdown.
    const picker = panel.element.querySelector<HTMLSelectElement>(".ed-record > .ed-record-add select")!;
    picker.value = "retreat";
    picker.dispatchEvent(new Event("change"));
    expect(replace.mock.calls.at(-1)![0].behaviors["retreat"]).toEqual({ baseWeight: 1 });

    // …and removing one again.
    const remove = panel.element.querySelector<HTMLButtonElement>('[data-remove-behavior="kite"]')!;
    remove.click();
    expect(replace.mock.calls.at(-1)![0].behaviors["kite"]).toBeUndefined();
    expect(replace.mock.calls.at(-1)![0].behaviors["engage"]).toBeDefined();
  });

  it("clones the selected profile under a fresh id on New profile", () => {
    const profiles = [profile()];
    const { host } = fakeHost(profiles);
    const panel = new BotProfileEditor(host, vi.fn());

    Array.from(panel.element.querySelectorAll("button")).find((b) => b.textContent === "New profile")!.click();
    expect(profiles.map((p) => p.id)).toEqual(["bot.aggressive", "bot.custom-1"]);
    const clone = profiles[1] as BotprofileConfig;
    expect(clone.name).toBe("bot.custom-1");
    expect(clone.behaviors as BehaviorRecord).toEqual(profiles[0]!.behaviors);
  });
});

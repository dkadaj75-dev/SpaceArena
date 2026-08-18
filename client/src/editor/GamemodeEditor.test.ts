import { describe, expect, it, vi } from "vitest";
import type { ConfigService, GamemodeConfig } from "@space-arena/shared";
import { GamemodeEditor, nextGamemodeId } from "./GamemodeEditor.js";
import type { EditorHost } from "./EditorShell.js";

function mode(over: Partial<GamemodeConfig> = {}): GamemodeConfig {
  return {
    id: "gamemode.practice-bots",
    type: "gamemode",
    version: 1,
    name: "Practice vs Bots",
    teams: "1v1",
    defaultArena: "arena.ring-nebula",
    winCondition: { type: "destroyTargets", count: 2 },
    eliminationEndsMatch: true,
    respawn: { enabled: false, delay: 3 },
    boundaryRule: { type: "warning", graceSeconds: 3 },
    rewards: { win: 0, loss: 0, perKill: 0 },
    bots: {
      defaultProfile: "bot.aggressive",
      defaultShip: "ship.interceptor",
      roster: [{ profile: "bot.aggressive", ship: "ship.interceptor", team: 1, count: 1 }],
    },
    ...over,
  } as GamemodeConfig;
}

function fakeHost(modes: GamemodeConfig[]): { host: EditorHost; replace: ReturnType<typeof vi.fn> } {
  const replace = vi.fn((config: GamemodeConfig) => {
    const index = modes.findIndex((m) => m.id === config.id);
    if (index >= 0) modes[index] = config;
    else modes.push(config);
    return { ok: true as const, errors: [] };
  });
  const configService = {
    getAll: vi.fn((type: string) => (type === "gamemode" ? modes : [{ id: "bot.aggressive" }, { id: "ship.interceptor" }])),
    replace,
  } as unknown as ConfigService;
  return { host: { configService } as unknown as EditorHost, replace };
}

describe("GamemodeEditor", () => {
  it("picks the first free custom gamemode id", () => {
    expect(nextGamemodeId(["gamemode.practice-bots-1v1"])).toBe("gamemode.custom-1");
    expect(nextGamemodeId(["gamemode.custom-1"])).toBe("gamemode.custom-2");
  });

  it("renders rule fields as dropdowns/toggles, including the win-condition union", () => {
    const { host } = fakeHost([mode()]);
    const panel = new GamemodeEditor(host, vi.fn());

    const teams = panel.element.querySelector<HTMLSelectElement>('[name="teams"]')!;
    // 10v10 joined the union when CTF scaled up (owner 2026-08-06).
    expect(Array.from(teams.options).map((o) => o.value)).toEqual(["1v1", "2v2", "5v5", "10v10"]);

    // Discriminated union -> a `type` <select> plus only the chosen branch's fields.
    const kind = panel.element.querySelector<HTMLSelectElement>('[name="winCondition.type"]')!;
    expect(Array.from(kind.options).map((o) => o.textContent)).toEqual(["destroyTargets", "fragLimit", "timeLimit", "captureLimit"]);
    expect(panel.element.querySelector('[name="winCondition.count"]')).not.toBeNull();
    expect(panel.element.querySelector('[name="winCondition.seconds"]')).toBeNull();

    const boundary = panel.element.querySelector<HTMLSelectElement>('[name="boundaryRule.type"]')!;
    expect(Array.from(boundary.options).map((o) => o.textContent)).toEqual([
      "bounce",
      "damage",
      "damageAndBounce",
      "warning",
    ]);
    expect(panel.element.querySelector('[name="boundaryRule.graceSeconds"]')).not.toBeNull();

    // Toggles for booleans, roster rows with add/remove for the bots block.
    expect(panel.element.querySelector<HTMLInputElement>('[name="respawn.enabled"]')!.type).toBe("checkbox");
    expect(panel.element.querySelector('[name="bots.roster.0.profile"]')).not.toBeNull();
    expect(panel.element.querySelectorAll(".editor-array-row").length).toBeGreaterThan(0);
  });

  it("switching the win condition re-seeds the branch and commits it", () => {
    const modes = [mode()];
    const { host, replace } = fakeHost(modes);
    const panel = new GamemodeEditor(host, vi.fn());

    const kind = panel.element.querySelector<HTMLSelectElement>('[name="winCondition.type"]')!;
    kind.value = String(Array.from(kind.options).findIndex((o) => o.textContent === "timeLimit"));
    kind.dispatchEvent(new Event("change"));

    expect(replace).toHaveBeenCalledTimes(1);
    expect(modes[0]!.winCondition).toEqual({ type: "timeLimit", seconds: expect.any(Number) });
    // The re-rendered form now shows the timeLimit field, not the old count.
    expect(panel.element.querySelector('[name="winCondition.seconds"]')).not.toBeNull();
    expect(panel.element.querySelector('[name="winCondition.count"]')).toBeNull();
  });

  it("clones the selected mode under a fresh id on New mode", () => {
    const modes = [mode()];
    const { host } = fakeHost(modes);
    const panel = new GamemodeEditor(host, vi.fn());

    Array.from(panel.element.querySelectorAll("button")).find((b) => b.textContent === "New mode")!.click();
    expect(modes.map((m) => m.id)).toEqual(["gamemode.practice-bots", "gamemode.custom-1"]);
  });
});

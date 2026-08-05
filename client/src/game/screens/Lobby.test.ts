// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfigService, GamemodeConfig } from "@space-arena/shared";
import type { AuthService, AuthState } from "../../core/AuthService.js";
import { ServerHealthState } from "../../core/serverHealth.js";
import { Lobby, OFFLINE_HEALTH_REFRESH_MS } from "./Lobby.js";

const authed = {
  status: "authed",
  profile: { displayName: "Pilot", level: 1, credits: 0, isGuest: false },
} as AuthState;

function configs(): ConfigService {
  const duel = {
    id: "gamemode.duel-1v1",
    type: "gamemode",
    version: 1,
    name: "Duel",
  } as GamemodeConfig;
  return {
    get: () => undefined,
    getAll: (type: string) => (type === "gamemode" ? [duel] : []),
  } as unknown as ConfigService;
}

/** Config service shaped like the shipped pack's offline bot modes. */
function practiceConfigs(): ConfigService {
  const modes = [
    {
      id: "gamemode.practice-bots-1v1",
      type: "gamemode",
      version: 1,
      name: "Practice — 1v1 vs Bot",
      bots: { defaultProfile: "bot.rookie", roster: [{ profile: "bot.rookie", team: 1, count: 1 }] },
    },
    {
      id: "gamemode.practice-bots",
      type: "gamemode",
      version: 1,
      name: "Practice — 2v2 vs Bots",
      bots: {
        defaultProfile: "bot.rookie",
        roster: [
          { profile: "bot.rookie", team: 0, count: 1 },
          { profile: "bot.rookie", team: 1, count: 2 },
        ],
      },
    },
  ] as unknown as GamemodeConfig[];
  return {
    get: () => undefined,
    getAll: (type: string) => (type === "gamemode" ? modes : []),
  } as unknown as ConfigService;
}

function auth(): AuthService {
  return {
    getState: () => authed,
    onChange: () => () => undefined,
  } as unknown as AuthService;
}

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
  document.head.replaceChildren();
});

describe("Lobby practice section", () => {
  function mount(onChoose: () => void): Lobby {
    return new Lobby(document.body, practiceConfigs(), auth(), new ServerHealthState(vi.fn()), {
      onChoose,
      onLogout: vi.fn(),
      onAccountRequested: vi.fn(),
      onHangarRequested: vi.fn(),
      onSettingsRequested: vi.fn(),
    });
  }

  it("offers bot practice modes", () => {
    const lobby = mount(vi.fn());
    const practice = document.querySelector<HTMLElement>('[data-section="practice"]')!;
    const labels = [...practice.querySelectorAll("button")].map((b) => b.textContent);
    expect(labels).toEqual(["Practice — 1v1 vs Bot", "Practice — 2v2 vs Bots"]);
    // Practice is offline-capable: none of them gate on the game server.
    expect([...practice.querySelectorAll("button")].every((b) => !b.disabled)).toBe(true);
    lobby.hide();
  });

  it("each bot mode launches practice with its OWN gamemode id", () => {
    // One lobby per click: choosing sets the busy guard that disables the whole
    // row, so a second click on the same instance is correctly a no-op.
    for (const [index, gamemode] of [
      [0, "gamemode.practice-bots-1v1"],
      [1, "gamemode.practice-bots"],
    ] as const) {
      const onChoose = vi.fn();
      const lobby = mount(onChoose);
      const practice = document.querySelector<HTMLElement>('[data-section="practice"]')!;
      practice.querySelectorAll<HTMLButtonElement>("button")[index]!.click();
      expect(onChoose).toHaveBeenCalledWith({ kind: "practice", gamemode });
      lobby.hide();
      document.body.replaceChildren();
    }
  });
});

describe("Lobby server health", () => {
  it("refreshes while visible and offline, then clears the badge and enables online play", async () => {
    vi.useFakeTimers();
    const probe = vi
      .fn()
      .mockResolvedValueOnce({ online: false, detail: "not ready" })
      .mockResolvedValueOnce({ online: true, detail: "" });
    const health = new ServerHealthState(probe);
    health.set({ online: false, detail: "boot probe failed" });
    const lobby = new Lobby(
      document.body,
      configs(),
      auth(),
      health,
      {
        onChoose: vi.fn(),
        onLogout: vi.fn(),
        onAccountRequested: vi.fn(),
        onHangarRequested: vi.fn(),
        onSettingsRequested: vi.fn(),
      },
    );
    lobby.hide();
    lobby.show();
    await vi.advanceTimersByTimeAsync(0);

    const badge = document.querySelector<HTMLElement>("[data-server-offline]")!;
    const duel = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent === "Duel",
    )!;
    expect(badge.classList.contains("visible")).toBe(true);
    expect(duel.disabled).toBe(true);

    await vi.advanceTimersByTimeAsync(OFFLINE_HEALTH_REFRESH_MS);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(badge.classList.contains("visible")).toBe(false);
    expect(duel.disabled).toBe(false);
  });
});

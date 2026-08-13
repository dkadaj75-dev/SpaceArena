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

/** Config service shaped like shipped online modes, including authored bot rosters. */
function practiceConfigs(): ConfigService {
  const modes = [
    {
      id: "gamemode.practice-bots-1v1",
      type: "gamemode",
      version: 1,
      name: "Skirmish 1v1",
      launch: "online",
      bots: { defaultProfile: "bot.rookie", roster: [{ profile: "bot.rookie", team: 1, count: 1 }] },
    },
    {
      id: "gamemode.practice-bots",
      type: "gamemode",
      version: 1,
      name: "Skirmish 2v2",
      launch: "online",
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

describe("Lobby mode list", () => {
  function mount(onChoose: () => void): Lobby {
    return new Lobby(document.body, practiceConfigs(), auth(), new ServerHealthState(vi.fn()), {
      onChoose,
      onLogout: vi.fn(),
      onAccountRequested: vi.fn(),
      onHangarRequested: vi.fn(),
      onShopRequested: vi.fn(),
      onSettingsRequested: vi.fn(),
    });
  }

  it("offers every non-tutorial mode in one online-gated list", () => {
    const lobby = mount(vi.fn());
    const play = document.querySelector<HTMLElement>('[data-section="play"]')!;
    const labels = [...play.querySelectorAll("button")].map((b) => b.textContent);
    expect(labels).toEqual(["Skirmish 1v1", "Skirmish 2v2"]);
    expect([...play.querySelectorAll("button")].every((b) => !b.disabled)).toBe(true);
    lobby.hide();
  });

  it("routes every mode through the same online join path", () => {
    // One lobby per click: choosing sets the busy guard that disables the whole
    // row, so a second click on the same instance is correctly a no-op.
    for (const [index, gamemode] of [
      [0, "gamemode.practice-bots-1v1"],
      [1, "gamemode.practice-bots"],
    ] as const) {
      const onChoose = vi.fn();
      const lobby = mount(onChoose);
      const play = document.querySelector<HTMLElement>('[data-section="play"]')!;
      play.querySelectorAll<HTMLButtonElement>("button")[index]!.click();
      expect(onChoose).toHaveBeenCalledWith({ kind: "online", gamemode });
      lobby.hide();
      document.body.replaceChildren();
    }
  });
});

/** The practice modes plus the tutorial config the menu button is generated from. */
function tutorialConfigs(): ConfigService {
  const base = practiceConfigs();
  const tutorial = { id: "tutorial.basics", type: "tutorial", version: 1 } as unknown as GamemodeConfig;
  return {
    get: () => undefined,
    getAll: (type: string) =>
      type === "tutorial" ? [tutorial] : (base.getAll as (t: string) => unknown[])(type),
  } as unknown as ConfigService;
}

describe("Lobby tutorial entry", () => {
  function mount(configs: ConfigService, onChoose: () => void): Lobby {
    return new Lobby(document.body, configs, auth(), new ServerHealthState(vi.fn()), {
      onChoose,
      onLogout: vi.fn(),
      onAccountRequested: vi.fn(),
      onHangarRequested: vi.fn(),
      onShopRequested: vi.fn(),
      onSettingsRequested: vi.fn(),
    });
  }

  it("heads the single Play section — a first-time pilot reads down from the top", () => {
    const lobby = mount(tutorialConfigs(), vi.fn());
    const play = document.querySelector<HTMLElement>('[data-section="play"]')!;
    const labels = [...play.querySelectorAll("button")].map((b) => b.textContent);
    expect(labels[0]).toBe("Tutorial");
    lobby.hide();
  });

  it("launches the tutorial, and never gates on the game server", () => {
    const onChoose = vi.fn();
    const lobby = mount(tutorialConfigs(), onChoose);
    const button = document.querySelector<HTMLButtonElement>('[data-lobby-action="tutorial"]')!;
    expect(button.disabled).toBe(false);
    button.click();
    expect(onChoose).toHaveBeenCalledWith({ kind: "tutorial" });
    lobby.hide();
  });

  it("is absent from a content pack that ships no tutorial", () => {
    const lobby = mount(practiceConfigs(), vi.fn());
    expect(document.querySelector('[data-lobby-action="tutorial"]')).toBeNull();
    lobby.hide();
  });

  it("excludes the offline tutorial gamemode from the online rows", () => {
    const modes = [
      {
        id: "gamemode.practice-bots-1v1",
        type: "gamemode",
        version: 1,
        name: "Skirmish 1v1",
        launch: "online",
        bots: { defaultProfile: "bot.rookie", roster: [{ profile: "bot.rookie", team: 1, count: 1 }] },
      },
      { id: "gamemode.tutorial", type: "gamemode", version: 1, name: "Flight School", launch: "offline" },
    ] as unknown as GamemodeConfig[];
    const lobby = mount(
      {
        get: () => undefined,
        getAll: (type: string) => (type === "gamemode" ? modes : []),
      } as unknown as ConfigService,
      vi.fn(),
    );
    const labels = [...document.querySelectorAll("button")].map((b) => b.textContent);
    expect(labels).not.toContain("Flight School");
    expect(labels).toContain("Skirmish 1v1");
    lobby.hide();
  });
});

describe("Lobby fleet section", () => {
  it("offers SHOP beside the Hangar, both usable without an account", () => {
    const onShopRequested = vi.fn();
    new Lobby(document.body, practiceConfigs(), auth(), new ServerHealthState(vi.fn()), {
      onChoose: vi.fn(),
      onLogout: vi.fn(),
      onAccountRequested: vi.fn(),
      onHangarRequested: vi.fn(),
      onShopRequested,
      onSettingsRequested: vi.fn(),
    });
    const fleet = document.querySelector<HTMLElement>('[data-section="fleet"]')!;
    const buttons = [...fleet.querySelectorAll<HTMLButtonElement>("button")];
    expect(buttons.map((b) => b.textContent)).toEqual(["Hangar", "Shop"]);
    // The coach mark finds its destinations by these hooks, not by label.
    expect(buttons.map((b) => b.dataset["lobbyAction"])).toEqual(["hangar", "shop"]);
    // The ledger is local without a login, so the shop never gates on the server.
    expect(buttons.every((b) => !b.disabled)).toBe(true);
    buttons[1]!.click();
    expect(onShopRequested).toHaveBeenCalledTimes(1);
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
        onShopRequested: vi.fn(),
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

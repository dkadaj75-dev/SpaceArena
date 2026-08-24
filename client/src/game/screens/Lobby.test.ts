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
      teams: "1v1",
      launch: "online",
      menu: { group: "Deathmatch", label: "Duel", order: 1 },
      bots: { defaultProfile: "bot.rookie", roster: [{ profile: "bot.rookie", team: 1, count: 1 }] },
    },
    {
      id: "gamemode.practice-bots",
      type: "gamemode",
      version: 1,
      name: "Skirmish 2v2",
      teams: "2v2",
      launch: "online",
      menu: { group: "Team Deathmatch", label: "2v2", blurb: "Fast pairs", order: 1 },
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

function auth(state: AuthState = authed): AuthService {
  return {
    getState: () => state,
    onChange: () => () => undefined,
  } as unknown as AuthService;
}

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
  document.head.replaceChildren();
});

/** Every mode card on screen, in DOM order. */
function cards(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>(".sa-menu-card")];
}

describe("Lobby mode grid", () => {
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

  it("files each mode under its authored group, in pack order", () => {
    const lobby = mount(vi.fn());
    const groups = [...document.querySelectorAll<HTMLElement>(".sa-menu-group")];
    expect(groups.map((g) => g.dataset["group"])).toEqual(["deathmatch", "team deathmatch"]);
    expect(cards().map((c) => c.dataset["gamemode"])).toEqual([
      "gamemode.practice-bots-1v1",
      "gamemode.practice-bots",
    ]);
    expect(cards().every((c) => !c.disabled)).toBe(true);
    lobby.hide();
  });

  it("shows the short label and its blurb, not the mode's full name", () => {
    // The group heading already says "Team Deathmatch"; repeating it on the card
    // is how a menu ends up reading "Team Deathmatch / Skirmish 2v2".
    const lobby = mount(vi.fn());
    const card = document.querySelector<HTMLElement>('[data-gamemode="gamemode.practice-bots"]')!;
    expect(card.querySelector(".sa-menu-card-label")?.textContent).toBe("2v2");
    expect(card.querySelector(".sa-menu-card-blurb")?.textContent).toBe("Fast pairs");
    expect(card.textContent).not.toContain("Skirmish");
    lobby.hide();
  });

  it("draws an icon on every card", () => {
    const lobby = mount(vi.fn());
    expect(cards().every((c) => c.querySelector(".sa-menu-icon svg") !== null)).toBe(true);
    lobby.hide();
  });

  it("leaves a hidden mode off the grid — it ships as a fixture, not a destination", () => {
    const modes = [
      { id: "gamemode.duel-1v1", type: "gamemode", version: 1, name: "Duel", teams: "1v1", launch: "online" },
      {
        id: "gamemode.practice-bots-1v1",
        type: "gamemode",
        version: 1,
        name: "Skirmish 1v1",
        teams: "1v1",
        launch: "online",
        hidden: true,
      },
    ] as unknown as GamemodeConfig[];
    const lobby = new Lobby(
      document.body,
      { get: () => undefined, getAll: (type: string) => (type === "gamemode" ? modes : []) } as unknown as ConfigService,
      auth(),
      new ServerHealthState(vi.fn()),
      {
        onChoose: vi.fn(),
        onLogout: vi.fn(),
        onAccountRequested: vi.fn(),
        onHangarRequested: vi.fn(),
        onShopRequested: vi.fn(),
        onSettingsRequested: vi.fn(),
      },
    );
    expect(cards().map((c) => c.dataset["gamemode"])).toEqual(["gamemode.duel-1v1"]);
    lobby.hide();
  });

  it("routes every mode through the same online join path", () => {
    // One lobby per click: choosing sets the busy guard that disables the whole
    // grid, so a second click on the same instance is correctly a no-op.
    for (const gamemode of ["gamemode.practice-bots-1v1", "gamemode.practice-bots"]) {
      const onChoose = vi.fn();
      const lobby = mount(onChoose);
      document.querySelector<HTMLButtonElement>(`[data-gamemode="${gamemode}"]`)!.click();
      expect(onChoose).toHaveBeenCalledWith({ kind: "online", gamemode });
      lobby.hide();
      document.body.replaceChildren();
    }
  });
});

describe("Lobby mode drawer", () => {
  function mount(onChoose = vi.fn()): Lobby {
    return new Lobby(document.body, practiceConfigs(), auth(), new ServerHealthState(vi.fn()), {
      onChoose,
      onLogout: vi.fn(),
      onAccountRequested: vi.fn(),
      onHangarRequested: vi.fn(),
      onShopRequested: vi.fn(),
      onSettingsRequested: vi.fn(),
    });
  }
  const categories = (): HTMLButtonElement[] => [
    ...document.querySelectorAll<HTMLButtonElement>(".sa-menu-category"),
  ];
  const shown = (selector: string): boolean =>
    document.querySelector<HTMLElement>(selector)?.hidden === false;

  it("opens on one button per authored category, and no mode buttons", () => {
    const lobby = mount();
    expect(categories().map((b) => b.querySelector(".sa-menu-card-label")?.textContent)).toEqual([
      "Deathmatch",
      "Team Deathmatch",
    ]);
    // The modes exist — they are built once and hidden, so the online gate can
    // still reach them — but no drawer is open.
    expect(shown('.sa-menu-group[data-group="deathmatch"]')).toBe(false);
    expect(lobby.openModeGroup).toBeNull();
    lobby.hide();
  });

  it("swaps the whole root menu for that category's modes, and back again", () => {
    const lobby = mount();
    categories()[1]!.click();

    expect(lobby.openModeGroup).toBe("Team Deathmatch");
    expect(shown('.sa-menu-group[data-group="team deathmatch"]')).toBe(true);
    // Everything the root offered is gone: categories AND destinations.
    expect(shown(".sa-menu-play")).toBe(false);
    expect(shown(".sa-menu-destinations")).toBe(false);
    expect(shown('.sa-menu-group[data-group="deathmatch"]')).toBe(false);

    document.querySelector<HTMLButtonElement>(".sa-menu-back")!.click();
    expect(lobby.openModeGroup).toBeNull();
    expect(shown(".sa-menu-play")).toBe(true);
    expect(shown(".sa-menu-destinations")).toBe(true);
    lobby.hide();
  });

  it("launches the mode inside the drawer, not the category button", () => {
    const onChoose = vi.fn();
    const lobby = mount(onChoose);
    categories()[0]!.click();
    expect(onChoose).not.toHaveBeenCalled();
    document.querySelector<HTMLButtonElement>('[data-gamemode="gamemode.practice-bots-1v1"]')!.click();
    expect(onChoose).toHaveBeenCalledWith({ kind: "online", gamemode: "gamemode.practice-bots-1v1" });
    lobby.hide();
  });

  it("comes back to the ROOT menu, whatever was open when the player left", () => {
    // Arriving from a match or the Hangar and finding a drawer still standing
    // reads as the game having lost its place.
    // `show()` re-probes the server, so this one needs a probe that answers.
    const lobby = new Lobby(
      document.body,
      practiceConfigs(),
      auth(),
      new ServerHealthState(vi.fn().mockResolvedValue({ online: true, detail: "" })),
      {
        onChoose: vi.fn(),
        onLogout: vi.fn(),
        onAccountRequested: vi.fn(),
        onHangarRequested: vi.fn(),
        onShopRequested: vi.fn(),
        onSettingsRequested: vi.fn(),
      },
    );
    categories()[0]!.click();
    expect(lobby.openModeGroup).toBe("Deathmatch");
    lobby.hide();
    lobby.show();
    expect(lobby.openModeGroup).toBeNull();
    expect(shown(".sa-menu-play")).toBe(true);
    lobby.hide();
  });

  it("flashes a pressed button, so a tap that changes the screen still answers", () => {
    const lobby = mount();
    const category = categories()[0]!;
    category.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(category.classList.contains("sa-pressed")).toBe(true);
    // The class is what the animation hangs off; it clears when that ends, or
    // the next press would find it already applied and never restart.
    category.dispatchEvent(new Event("animationend", { bubbles: true }));
    expect(category.classList.contains("sa-pressed")).toBe(false);
    lobby.hide();
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

  it("is a destination, not a mode card — it is a place you go, not a match", () => {
    const lobby = mount(tutorialConfigs(), vi.fn());
    expect(cards().map((c) => c.dataset["gamemode"])).not.toContain(undefined);
    const destinations = [...document.querySelectorAll<HTMLElement>(".sa-menu-destination")];
    expect(destinations.map((d) => d.dataset["lobbyAction"])).toEqual(["hangar", "shop", "tutorial"]);
    expect(destinations[2]!.querySelector(".sa-menu-card-label")?.textContent).toBe("Tutorial");
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

describe("Lobby destinations", () => {
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
    const buttons = [...document.querySelectorAll<HTMLButtonElement>(".sa-menu-destination")];
    expect(buttons.map((b) => b.querySelector(".sa-menu-card-label")?.textContent)).toEqual(["Hangar", "Shop"]);
    // The coach mark finds its destinations by these hooks, not by label.
    expect(buttons.map((b) => b.dataset["lobbyAction"])).toEqual(["hangar", "shop"]);
    // The ledger is local without a login, so the shop never gates on the server.
    expect(buttons.every((b) => !b.disabled)).toBe(true);
    buttons[1]!.click();
    expect(onShopRequested).toHaveBeenCalledTimes(1);
  });
});

describe("Lobby server health", () => {
  it("keeps modes playable locally while offline, then clears the badge when the server returns", async () => {
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
    expect(duel.disabled).toBe(false);
    expect(duel.title).toContain("locally against bots");

    await vi.advanceTimersByTimeAsync(OFFLINE_HEALTH_REFRESH_MS);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(badge.classList.contains("visible")).toBe(false);
    expect(duel.disabled).toBe(false);
  });

  it("never claims pilots are online while the header says you are not", async () => {
    // Finding 13: the chip read "Playing offline" and the line under the title
    // read "3 PILOTS ONLINE", in one screenshot. The count is a fact about a
    // lobby you cannot enter without an identity, so it is gated on having one.
    vi.useFakeTimers();
    const health = new ServerHealthState(vi.fn().mockResolvedValue({ online: true, detail: "", playersOnline: 3 }));
    const anonymous = new Lobby(document.body, configs(), auth({ status: "anonymous" } as AuthState), health, {
      onChoose: vi.fn(),
      onLogout: vi.fn(),
      onAccountRequested: vi.fn(),
      onHangarRequested: vi.fn(),
      onShopRequested: vi.fn(),
      onSettingsRequested: vi.fn(),
    });
    health.set({ online: true, detail: "", playersOnline: 3 });
    const count = (): string => document.querySelector<HTMLElement>(".sa-menu-online-count")!.textContent!;
    expect(document.querySelector(".sa-menu-account")!.textContent).toContain("Playing offline");
    expect(count()).toBe("");
    anonymous.dispose();
    document.body.replaceChildren();

    const signedIn = new Lobby(document.body, configs(), auth(), health, {
      onChoose: vi.fn(),
      onLogout: vi.fn(),
      onAccountRequested: vi.fn(),
      onHangarRequested: vi.fn(),
      onShopRequested: vi.fn(),
      onSettingsRequested: vi.fn(),
    });
    expect(count()).toBe("3 pilots online");
    // …and it goes away with the server, not just with the account.
    health.set({ online: false, detail: "could not be reached", playersOnline: 3 });
    expect(count()).toBe("");
    signedIn.dispose();
  });

  it("lets an anonymous pilot launch a mode when no server is available", () => {
    const health = new ServerHealthState(vi.fn());
    health.set({ online: false, detail: "static host" });
    const onChoose = vi.fn();
    new Lobby(
      document.body,
      configs(),
      auth({ status: "anonymous" } as AuthState),
      health,
      {
        onChoose,
        onLogout: vi.fn(),
        onAccountRequested: vi.fn(),
        onHangarRequested: vi.fn(),
        onShopRequested: vi.fn(),
        onSettingsRequested: vi.fn(),
      },
    );
    const duel = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent === "Duel",
    )!;
    expect(duel.disabled).toBe(false);
    duel.click();
    expect(onChoose).toHaveBeenCalledWith({ kind: "online", gamemode: "gamemode.duel-1v1" });
  });
});

/**
 * Finding 12: "Skip (offline practice)" against a REACHABLE server leaves the
 * pilot unauthed, and every mode card came back disabled while rendering
 * identically to a live one — the only explanation a `title` tooltip, which a
 * phone cannot show at all.
 */
describe("Lobby online gate", () => {
  function mount(state: AuthState): Lobby {
    const health = new ServerHealthState(vi.fn());
    health.set({ online: true, detail: "" });
    return new Lobby(document.body, practiceConfigs(), auth(state), health, {
      onChoose: vi.fn(),
      onLogout: vi.fn(),
      onAccountRequested: vi.fn(),
      onHangarRequested: vi.fn(),
      onShopRequested: vi.fn(),
      onSettingsRequested: vi.fn(),
    });
  }
  const notes = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>("[data-lobby-locked]")];

  it("makes an unplayable card LOOK unplayable, and says why in the open", () => {
    const lobby = mount({ status: "anonymous" } as AuthState);
    expect(cards().every((c) => c.disabled && c.classList.contains("locked"))).toBe(true);
    // One line per drawer, so the reason is under whichever group is open.
    expect(notes()).toHaveLength(2);
    expect(notes().every((n) => !n.hidden)).toBe(true);
    expect(notes()[0]!.textContent).toContain("Log in to play online");
    // The tooltip stays for a mouse — it is just no longer the only channel.
    expect(cards()[0]!.title).toContain("Log in to play online");
    lobby.dispose();
  });

  it("leaves signed-in cards alone", () => {
    const lobby = mount(authed);
    expect(cards().some((c) => c.classList.contains("locked"))).toBe(false);
    expect(notes().every((n) => n.hidden)).toBe(true);
    lobby.dispose();
  });

  it("does not dress a busy card as locked — busy is a moment, this is a state", () => {
    const lobby = mount(authed);
    lobby.setBusy(true, "Connecting…");
    expect(cards().every((c) => c.disabled)).toBe(true);
    expect(cards().some((c) => c.classList.contains("locked"))).toBe(false);
    lobby.dispose();
  });
});

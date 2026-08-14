// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfigService, Snapshot } from "@space-arena/shared";
import type { GameSession } from "../GameSession.js";
import {
  DEFAULT_MATCH_LOADING_MIN_VISIBLE_MS,
  formatCountUp,
  loadingRoster,
  matchLoadingMinVisibleMs,
  MatchLoadingScreen,
  renderRoster,
  rosterTeams,
} from "./MatchLoadingScreen.js";

/** Minimal config surface: the screen only reads arena + theme. */
function configs(overrides: Record<string, unknown> = {}): ConfigService {
  return {
    get: (type: string, id: string) => overrides[`${type}:${id}`],
    getAll: () => [],
  } as unknown as ConfigService;
}

function snapshot(ships: Array<{ id: number; team: number }>): Snapshot {
  return { ships, phase: "waiting" } as unknown as Snapshot;
}

/** A session stand-in for the roster reader (nothing here touches the sim). */
function session(
  ships: Array<{ id: number; team: number }>,
  names: Record<number, string> = {},
  bots: readonly number[] = [],
): GameSession {
  return {
    playerId: 1,
    arenaId: "arena.test",
    rosterSnapshot: snapshot(ships),
    displayNameFor: (id: number) => names[id],
    isBotFor: (id: number) => bots.includes(id),
  } as unknown as GameSession;
}

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("match loading roster", () => {
  it("renders every player under the correct ordered team", () => {
    const host = document.createElement("div");
    renderRoster(host, [
      { team: 1, name: "Red Bot" }, { team: 0, name: "Player" }, { team: 0, name: "Wing Bot" },
    ]);
    const teams = host.querySelectorAll<HTMLElement>(".sa-match-loading-team");
    expect([...teams].map((team) => team.dataset["team"])).toEqual(["0", "1"]);
    expect([...teams[0]!.querySelectorAll(".sa-match-loading-pilot")].map((el) => el.textContent)).toEqual(["Player", "Wing Bot"]);
    expect(teams[1]!.textContent).toContain("Red Bot");
  });

  it("shows both teams and their open slots while the room is still filling", () => {
    const host = document.createElement("div");
    renderRoster(host, [{ team: 0, name: "Player", kind: "you" }], 2);
    const teams = host.querySelectorAll<HTMLElement>(".sa-match-loading-team");
    expect(teams).toHaveLength(2);
    expect(teams[0]!.querySelector(".sa-match-loading-count")?.textContent).toBe("1/2");
    // One seated pilot plus one placeholder for the slot still being sought.
    const kinds = [...teams[0]!.querySelectorAll<HTMLElement>(".sa-match-loading-pilot")].map((el) => el.dataset["kind"]);
    expect(kinds).toEqual(["you", "empty"]);
    expect(teams[1]!.querySelectorAll('[data-kind="empty"]')).toHaveLength(2);
  });

  it("tags backfill bots so a filled slot is not mistaken for a human", () => {
    const host = document.createElement("div");
    renderRoster(host, [{ team: 1, name: "Vortexrunner_77", kind: "bot" }], 1);
    const pilot = host.querySelector<HTMLElement>('.sa-match-loading-pilot[data-kind="bot"]');
    expect(pilot?.textContent).toContain("Vortexrunner_77");
    expect(pilot?.querySelector(".sa-match-loading-tag")?.textContent).toBe("BOT");
  });

  it("groups a flat roster into team views with the open-slot count", () => {
    expect(rosterTeams([{ team: 1, name: "Foe" }], 2)).toEqual([
      { team: 0, filled: [], empty: 2 },
      { team: 1, filled: [{ team: 1, name: "Foe" }], empty: 1 },
    ]);
  });

  it("reads the newest authoritative state, marking the local pilot and the bots", () => {
    const roster = loadingRoster(
      session([{ id: 1, team: 0 }, { id: 2, team: 1 }, { id: 3, team: 1 }], { 1: "Ace", 2: "Rival" }, [3]),
    );
    expect(roster).toEqual([
      { team: 0, name: "Ace", kind: "you" },
      { team: 1, name: "Rival", kind: "player" },
      { team: 1, name: "PILOT 3", kind: "bot" },
    ]);
  });
});

describe("match loading duration", () => {
  it("uses the authored menu hold and preserves the cached-load default", () => {
    expect(matchLoadingMinVisibleMs(undefined)).toBe(DEFAULT_MATCH_LOADING_MIN_VISIBLE_MS);
    expect(matchLoadingMinVisibleMs({ menu: { matchLoadingMinVisibleMs: 1800 } } as never)).toBe(1800);
  });
});

describe("search elapsed clock", () => {
  it("counts UP in m:ss, never down", () => {
    expect(formatCountUp(0)).toBe("0:00");
    expect(formatCountUp(7_400)).toBe("0:07");
    expect(formatCountUp(65_000)).toBe("1:05");
    expect(formatCountUp(-5_000)).toBe("0:00");
  });
});

describe("MatchLoadingScreen phases", () => {
  it("opens on the search phase with a running clock, then settles on the arena card", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const arena = { id: "arena.test", name: "Ring Nebula", render: { skybox: { texture: "sky.env" } } };
    const screen = new MatchLoadingScreen(document.body, configs({ "arena:arena.test": arena }));

    screen.showSearching({ teamSize: 1, title: "Ring Nebula" });
    const root = document.querySelector<HTMLElement>(".sa-match-loading")!;
    expect(screen.phase).toBe("searching");
    expect(root.dataset["phase"]).toBe("searching");
    expect(root.querySelector(".sa-match-loading-kicker")?.textContent).toBe("FINDING PLAYERS");
    const elapsed = root.querySelector<HTMLElement>(".sa-match-loading-elapsed")!;
    expect(elapsed.hidden).toBe(false);
    expect(elapsed.textContent).toBe("0:00");

    vi.advanceTimersByTime(7_000);
    expect(elapsed.textContent).toBe("0:07");

    // Both teams are drawn from the first frame, so nothing shifts as they fill.
    expect(root.querySelectorAll(".sa-match-loading-team")).toHaveLength(2);
    screen.setRoster([
      { team: 0, name: "Ace", kind: "you" },
      { team: 1, name: "Vortexrunner_77", kind: "bot" },
    ]);
    expect(root.querySelectorAll('.sa-match-loading-pilot[data-kind="empty"]')).toHaveLength(0);
    expect(root.textContent).toContain("Vortexrunner_77");

    screen.showSession(session([{ id: 1, team: 0 }], { 1: "Ace" }), "/");
    expect(screen.phase).toBe("ready");
    expect(elapsed.hidden).toBe(true);
    // The clock is stopped with the phase, not left ticking behind the card.
    const settled = elapsed.textContent;
    vi.advanceTimersByTime(5_000);
    expect(elapsed.textContent).toBe(settled);
    screen.dispose();
  });

  it("shows remaining preload progress and clears it once the models are in", () => {
    const screen = new MatchLoadingScreen(document.body, configs());
    screen.showSearching({ teamSize: 2 });
    const progress = document.querySelector<HTMLElement>(".sa-match-loading-progress")!;
    expect(progress.hidden).toBe(true);

    screen.setAssetProgress(3, 12);
    expect(progress.hidden).toBe(false);
    expect(progress.textContent).toContain("25%");

    screen.setAssetProgress(12, 12);
    expect(progress.hidden).toBe(true);
    screen.dispose();
  });

  it("offers a cancel control only while a cancellable search is live", () => {
    const onCancel = vi.fn();
    const screen = new MatchLoadingScreen(document.body, configs());
    const cancel = document.querySelector<HTMLButtonElement>(".sa-match-loading-cancel")!;
    expect(cancel.hidden).toBe(true);

    screen.showSearching({ teamSize: 1, onCancel });
    expect(cancel.hidden).toBe(false);
    cancel.click();
    expect(onCancel).toHaveBeenCalledTimes(1);

    screen.showPending("Building flight school");
    expect(screen.phase).toBe("pending");
    expect(cancel.hidden).toBe(true);
    cancel.click();
    expect(onCancel).toHaveBeenCalledTimes(1);
    screen.dispose();
  });
});

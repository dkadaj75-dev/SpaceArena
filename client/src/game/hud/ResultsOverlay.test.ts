import { afterEach, describe, expect, it, vi } from "vitest";
import type { Snapshot } from "@space-arena/shared";
import type { GameSession } from "../GameSession.js";
import { REWARDS_HEADING, ResultsOverlay, SCOREBOARD_ACTION_LABEL } from "./ResultsOverlay.js";
import { injectHudStyle } from "./hudStyle.js";

const ended = { phase: "ended", winnerTeam: 0 } as Snapshot;

function session(): GameSession {
  return {
    matchStats: {
      all: () => [{
        entityId: 7,
        kills: 9,
        deaths: 1,
        assists: 4,
        flagsTaken: 1,
        flagsDropped: 0,
        flagsReturned: 0,
        flagsCaptured: 2,
      }],
    },
    sim: { world: { gamemode: { ctf: {}, winCondition: { type: "score" } } } },
    displayNameFor: () => "NOVA",
    teamOf: () => 0,
  } as unknown as GameSession;
}

afterEach(() => document.body.replaceChildren());

describe("ResultsOverlay MVP presentation", () => {
  it("builds the badge, pilot name, stat chips, and preserves the next hook", () => {
    const overlay = new ResultsOverlay(document.body, session(), 1, {
      onPlayAgain: vi.fn(),
      onMenu: vi.fn(),
      onMvp: vi.fn(),
    });
    overlay.update(ended);
    overlay.showMvp();

    expect(document.querySelector(".hud-results-mvp-badge")?.textContent).toBe("MVP");
    expect(document.querySelector(".hud-results-title")?.textContent).toBe("NOVA");
    expect(document.querySelectorAll(".hud-results-stat")).toHaveLength(3);
    expect(document.querySelector("[data-results-action='next']")).toBeInstanceOf(HTMLButtonElement);
  });

  it("fast-forwards every chip without blocking the button action", () => {
    const onNext = vi.fn();
    const overlay = new ResultsOverlay(document.body, session(), 1, {
      onPlayAgain: vi.fn(),
      onMenu: vi.fn(),
    });
    overlay.setScoreboardAction(onNext);
    overlay.update(ended);
    overlay.showMvp();

    document.querySelector(".hud-results")?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(document.querySelector(".hud-results")?.classList.contains("hud-results--mvp-skipped")).toBe(true);
    expect([...document.querySelectorAll(".hud-results-stat-value")].map((el) => el.textContent)).toEqual(["9", "4", "2"]);

    (document.querySelector("[data-results-action='next']") as HTMLButtonElement).click();
    expect(onNext).toHaveBeenCalledOnce();
  });

  /**
   * Playtest finding 3: the primary button "often fails" — three taps in a row
   * on one run and the scoreboard never opened. One tap raised BOTH the root's
   * `pointerdown` (skip the count-up, which rewrites classes and relays out the
   * card) and the button's `click`, and the click lost the race often enough to
   * make the button feel broken. A press that lands on a control is now the
   * control's, entirely: it never skips, and it acts on pointerup.
   */
  it("opens the scoreboard from a real tap sequence on the button", () => {
    const onNext = vi.fn();
    const overlay = new ResultsOverlay(document.body, session(), 1, { onPlayAgain: vi.fn(), onMenu: vi.fn() });
    overlay.setScoreboardAction(onNext);
    overlay.update(ended);
    overlay.showMvp();

    const next = document.querySelector<HTMLButtonElement>("[data-results-action='next']")!;
    next.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1 }));
    // The press was the BUTTON's: the count-up is not skipped out from under it.
    expect(document.querySelector(".hud-results")?.classList.contains("hud-results--mvp-skipped")).toBe(false);
    next.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
    expect(onNext).toHaveBeenCalledOnce();
  });

  it("still skips the count-up from a press on the card itself", () => {
    const overlay = new ResultsOverlay(document.body, session(), 1, { onPlayAgain: vi.fn(), onMenu: vi.fn() });
    overlay.update(ended);
    overlay.showMvp();
    document.querySelector(".hud-results-panel")?.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, pointerId: 2 }),
    );
    expect(document.querySelector(".hud-results")?.classList.contains("hud-results--mvp-skipped")).toBe(true);
  });

  it("fires each action exactly once per tap, never twice", () => {
    const onMenu = vi.fn();
    const overlay = new ResultsOverlay(document.body, session(), 1, { onPlayAgain: vi.fn(), onMenu });
    overlay.update(ended);
    overlay.showMvp();
    const quit = document.querySelector<HTMLButtonElement>("[data-results-action='menu']")!;
    quit.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 3 }));
    quit.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 3 }));
    // The compatibility click a browser sends after a single-touch tap must not
    // run the action a second time.
    quit.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(onMenu).toHaveBeenCalledOnce();
  });

  it("names the primary action for where it goes, not for its position in a queue", () => {
    const overlay = new ResultsOverlay(document.body, session(), 1, { onPlayAgain: vi.fn(), onMenu: vi.fn() });
    overlay.update(ended);
    // "NEXT" said nothing while the two buttons that describe real outcomes
    // were demoted beside it (menus finding 62).
    expect(document.querySelector("[data-results-action='next']")?.textContent).toBe(SCOREBOARD_ACTION_LABEL);
    expect(SCOREBOARD_ACTION_LABEL.toUpperCase()).toBe("SCOREBOARD");
    overlay.dispose();
  });
});

describe("ResultsOverlay rewards", () => {
  function overlay(offline = false): ResultsOverlay {
    const o = new ResultsOverlay(document.body, session(), 1, { onPlayAgain: vi.fn(), onMenu: vi.fn() }, { offline });
    o.update(ended);
    return o;
  }

  it("counts a real grant up from zero", () => {
    const o = overlay();
    o.showRewards({ credits: 120, xp: 120, newLevel: 2, leveledUp: true });
    expect(document.querySelector(".hud-results-rewards-line")).not.toBeNull();
    expect(document.querySelector(".hud-results-levelup")?.textContent).toContain("Level 2");

    o.update(ended, 5000);
    expect(document.querySelector(".hud-results-rewards-line .credits")?.textContent).toBe("+120");
    expect(document.querySelector(".hud-results-rewards-line .xp")?.textContent).toBe("+120");
  });

  it("says a mode granted nothing instead of animating a count-up to zero", () => {
    // Every `gamemode.practice-*` authors win/loss/perKill: 0, and the server
    // still sends the `matchRewards` message (ArenaRoom.persistAndReward) — so
    // an ONLINE practice match legitimately arrives here as 0/0. It read
    // "+0 credits · +0 xp", which the playtest reported as a broken pipeline.
    const o = overlay();
    o.showRewards({ credits: 0, xp: 0, newLevel: 1, leveledUp: false });
    expect(document.querySelector(".hud-results-rewards-line")).toBeNull();
    expect(document.querySelector(".hud-results-rewards")?.textContent).toBe("No rewards from this match");
  });

  it("keeps the offline wording when there is no server to grant anything", () => {
    const o = overlay(true);
    o.showRewards({ credits: 0, xp: 0, newLevel: 1, leveledUp: false });
    expect(document.querySelector(".hud-results-rewards")?.textContent).toBe("Practice — no rewards");
  });

  /**
   * Playtest finding 17 / menus 61: the card reads
   * "MVP · PLAYTEST-MATCH-B · 1 KILLS / 0 ASSISTS · +25 credits · +25 xp" —
   * someone else's name, someone else's tiles, then YOUR grant, with nothing
   * between them saying the subject changed.
   */
  it("labels the reward line as YOURS, under the MVP's name and tiles", () => {
    const o = overlay();
    o.showMvp();
    // Nothing to own yet: no heading floating over an empty block.
    expect(document.querySelector<HTMLElement>(".hud-results-rewards-heading")?.hidden).toBe(true);

    o.showRewards({ credits: 25, xp: 25, newLevel: 1, leveledUp: false });
    const heading = document.querySelector<HTMLElement>(".hud-results-rewards-heading")!;
    expect(heading.hidden).toBe(false);
    expect(heading.textContent).toBe(REWARDS_HEADING);
    // …and it sits between the MVP's stat tiles and the grant it introduces.
    const order = [...document.querySelectorAll(".hud-results-panel > *")].map((el) => el.className);
    expect(order.indexOf("hud-results-stats")).toBeLessThan(order.indexOf("hud-results-rewards-heading"));
    expect(order.indexOf("hud-results-rewards-heading")).toBeLessThan(order.indexOf("hud-results-rewards"));
  });

  it("labels a no-reward line too — 'no rewards' is also about you", () => {
    const o = overlay();
    o.showRewards({ credits: 0, xp: 0, newLevel: 1, leveledUp: false });
    expect(document.querySelector<HTMLElement>(".hud-results-rewards-heading")?.hidden).toBe(false);
  });
});

describe("results card typography", () => {
  it("fits a long MVP name rather than breaking it mid-word", () => {
    // "VortexFall_99" rendered as "VORTEXFALL_9" with a lone "9" beneath it
    // (playtest finding 18) — a nickname split into two reads as two pilots.
    injectHudStyle();
    const css = document.getElementById("hud-style")?.textContent ?? "";
    const block = css.slice(css.indexOf(".hud-results--mvp .hud-results-title {"));
    const body = block.slice(0, block.indexOf("}"));
    expect(body).not.toMatch(/overflow-wrap:\s*anywhere/);
    expect(body).toMatch(/overflow-wrap:\s*normal/);
    expect(body).toMatch(/word-break:\s*normal/);
    expect(body).toMatch(/text-overflow:\s*ellipsis/);
    document.head.replaceChildren();
  });
});

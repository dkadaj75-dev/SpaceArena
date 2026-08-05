import { afterEach, describe, expect, it, vi } from "vitest";
import type { Snapshot } from "@space-arena/shared";
import type { GameSession } from "../GameSession.js";
import { ResultsOverlay } from "./ResultsOverlay.js";

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
});

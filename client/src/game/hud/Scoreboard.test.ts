// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GameSession } from "../GameSession.js";
import { Scoreboard } from "./Scoreboard.js";
import { teamPerspective, viewerTeam } from "./matchPresentation.js";

function session(playerId = 1): GameSession {
  const lines = new Map([
    [1, { entityId: 1, kills: 4, deaths: 1, assists: 2, flagsTaken: 0, flagsReturned: 0, flagsCaptured: 0 }],
    [2, { entityId: 2, kills: 2, deaths: 3, assists: 1, flagsTaken: 0, flagsReturned: 0, flagsCaptured: 0 }],
  ]);
  return {
    playerId,
    sim: { world: { gamemode: {} } },
    displayNameFor: (id: number) => (id === 1 ? "YOU" : "RIVAL"),
    isBotFor: (id: number) => id === 2,
    matchStats: { forEach: (visit: (line: (typeof lines extends Map<number, infer T> ? T : never)) => void) => lines.forEach(visit), line: (id: number) => lines.get(id)! },
  } as unknown as GameSession;
}

afterEach(() => document.body.replaceChildren());

describe("Scoreboard", () => {
  it("marks only the local player's row for both scoreboard presentations", () => {
    const board = new Scoreboard(document.body, session(), { onPlayAgain: vi.fn(), onMenu: vi.fn() });
    board.update({ ships: [{ id: 1, team: 0 }, { id: 2, team: 0 }] } as never);

    expect(document.querySelector("tr[data-entity-id='1']")?.classList.contains("hud-scoreboard-local-player")).toBe(true);
    expect(document.querySelector("tr[data-entity-id='2']")?.classList.contains("hud-scoreboard-local-player")).toBe(false);
    board.showFinal();
    expect(document.querySelector(".hud-scoreboard.final tr[data-entity-id='1']")?.classList.contains("hud-scoreboard-local-player")).toBe(true);
    board.dispose();
  });

  /**
   * Playtest finding 1: with a steering thumb held, the SCORE button was dead —
   * a second touch point synthesizes no `click`, and the timeline recorded
   * `scoreboard opened: false` for a whole match. It is a pointer tap now.
   */
  it("opens from a POINTER tap, with a steering finger already on the screen", () => {
    const board = new Scoreboard(document.body, session(), { onPlayAgain: vi.fn(), onMenu: vi.fn() });
    board.update({ ships: [{ id: 1, team: 0 }] } as never);
    const button = document.querySelector<HTMLButtonElement>(".hud-scoreboard-btn")!;
    const root = document.querySelector(".hud-scoreboard")!;
    expect(root.classList.contains("visible")).toBe(false);

    // Pointer 1 steers; pointer 2 taps SCORE. No click event is dispatched.
    document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1 }));
    button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 2 }));
    button.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 2 }));
    expect(root.classList.contains("visible")).toBe(true);
    expect(button.textContent).toBe("CLOSE");

    // …and the same tap closes it, exactly once per tap.
    button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 3 }));
    button.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 3 }));
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(root.classList.contains("visible")).toBe(false);
    board.dispose();
  });

  it("discloses bots beside their replicated player-like name", () => {
    const board = new Scoreboard(document.body, session(), { onPlayAgain: vi.fn(), onMenu: vi.fn() });
    board.update({ ships: [{ id: 1, team: 0 }, { id: 2, team: 1 }] } as never);
    expect(document.querySelector("tr[data-entity-id='1'] td")?.textContent).toBe("YOU");
    expect(document.querySelector("tr[data-entity-id='2'] td")?.textContent).toBe("RIVAL [BOT]");
    board.dispose();
  });

  it("maps teams from the current viewer's ship, with team zero as the spectator fallback", () => {
    const snapshot = { ships: [{ id: 1, team: 1 }, { id: 2, team: 0 }] } as never;
    expect(viewerTeam(snapshot, 1)).toBe(1);
    expect(teamPerspective(1, viewerTeam(snapshot, 1))).toBe("ally");
    expect(teamPerspective(0, viewerTeam(snapshot, 1))).toBe("enemy");
    expect(viewerTeam({ ships: [] } as never, 1)).toBe(0);
  });

  it("uses blue ally and red enemy table classes from the viewer's perspective", () => {
    const board = new Scoreboard(document.body, session(), { onPlayAgain: vi.fn(), onMenu: vi.fn() });
    board.update({ ships: [{ id: 1, team: 1 }, { id: 2, team: 0 }] } as never);

    expect(document.querySelector("table[data-team='1']")?.classList.contains("hud-scoreboard-team--ally")).toBe(true);
    expect(document.querySelector("table[data-team='0']")?.classList.contains("hud-scoreboard-team--enemy")).toBe(true);
    board.update({ ships: [{ id: 1, team: 0 }, { id: 2, team: 1 }] } as never);
    expect(document.querySelector("table[data-team='0']")?.classList.contains("hud-scoreboard-team--ally")).toBe(true);
    expect(document.querySelector("table[data-team='1']")?.classList.contains("hud-scoreboard-team--enemy")).toBe(true);
    expect(document.querySelector("tr[data-entity-id='1']")?.classList.contains("hud-scoreboard-local-player")).toBe(true);
    board.dispose();
  });

  it("switches the score control label and accessible name with the panel", () => {
    const board = new Scoreboard(document.body, session(), { onPlayAgain: vi.fn(), onMenu: vi.fn() });
    const button = document.querySelector<HTMLButtonElement>(".hud-scoreboard-btn")!;
    expect(button.textContent).toBe("SCORE");
    expect(button.getAttribute("aria-label")).toBe("SCORE");
    button.click();
    expect(button.textContent).toBe("CLOSE");
    expect(button.getAttribute("aria-label")).toBe("CLOSE");
    button.click();
    expect(button.textContent).toBe("SCORE");
    expect(button.getAttribute("aria-label")).toBe("SCORE");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    expect(button.textContent).toBe("CLOSE");
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Tab" }));
    expect(button.textContent).toBe("SCORE");
    button.click();
    board.lockForEnd();
    expect(button.textContent).toBe("SCORE");
    expect(button.getAttribute("aria-label")).toBe("SCORE");
    board.dispose();
  });
});

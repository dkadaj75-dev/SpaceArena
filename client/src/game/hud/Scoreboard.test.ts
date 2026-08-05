// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GameSession } from "../GameSession.js";
import { Scoreboard } from "./Scoreboard.js";

function session(): GameSession {
  const lines = new Map([
    [1, { entityId: 1, kills: 4, deaths: 1, assists: 2, flagsTaken: 0, flagsReturned: 0, flagsCaptured: 0 }],
    [2, { entityId: 2, kills: 2, deaths: 3, assists: 1, flagsTaken: 0, flagsReturned: 0, flagsCaptured: 0 }],
  ]);
  return {
    playerId: 1,
    sim: { world: { gamemode: {} } },
    displayNameFor: (id: number) => (id === 1 ? "YOU" : "RIVAL"),
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
});

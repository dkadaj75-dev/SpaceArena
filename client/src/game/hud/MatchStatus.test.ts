import { describe, expect, it, vi } from "vitest";
import type { GamemodeConfig } from "@space-arena/shared";
import type { GameSession } from "../GameSession.js";
import { ELIMINATION_OBJECTIVE, MatchStatus, matchObjectiveLabel } from "./MatchStatus.js";

type ModeShape = Pick<GamemodeConfig, "winCondition" | "eliminationEndsMatch" | "respawn">;

function mode(over: Partial<ModeShape> = {}): ModeShape {
  return {
    winCondition: { type: "fragLimit", count: 10 },
    eliminationEndsMatch: false,
    respawn: { enabled: true, delay: 4 },
    ...over,
  } as ModeShape;
}

describe("score banner objective", () => {
  /**
   * Playtest finding 21. `gamemode.duel-1v1` authors `fragLimit: 5` AND
   * `eliminationEndsMatch: true` with `respawn.enabled: false` — so the first
   * kill ends it. The banner read "0 FIRST TO 5 0" and then jumped straight to
   * "0 MATCH OVER 1": it promised a race that cannot happen.
   */
  it("calls the Duel what it is instead of promising a race to five", () => {
    expect(
      matchObjectiveLabel(mode({
        winCondition: { type: "fragLimit", count: 5 },
        eliminationEndsMatch: true,
        respawn: { enabled: false, delay: 4 },
      })),
    ).toBe(ELIMINATION_OBJECTIVE);
  });

  it("keeps the frag target wherever pilots come back", () => {
    // The elimination rule is harmless in a respawn mode — a team is only
    // momentarily wiped — so the count is still the honest objective.
    expect(matchObjectiveLabel(mode())).toBe("FIRST TO 10");
    expect(matchObjectiveLabel(mode({ eliminationEndsMatch: true }))).toBe("FIRST TO 10");
  });

  it("reads captures, not kills, where the mode is scored in captures", () => {
    expect(matchObjectiveLabel(mode({ winCondition: { type: "captureLimit", count: 3 } }))).toBe("FIRST TO 3");
  });

  it("names no objective for a mode whose clock beside it already says everything", () => {
    expect(matchObjectiveLabel(mode({ winCondition: { type: "timeLimit", seconds: 300 } }))).toBeUndefined();
  });

  it("puts the honest objective on the live banner", () => {
    const root = document.createElement("div");
    const status = new MatchStatus(root, {
      playerId: 1,
      sim: {
        world: {
          gamemode: mode({
            winCondition: { type: "fragLimit", count: 5 },
            eliminationEndsMatch: true,
            respawn: { enabled: false, delay: 4 },
          }),
        },
      },
      order: vi.fn(),
    } as unknown as GameSession);
    status.update({
      phase: "live",
      elapsed: 0,
      teamScores: [{ team: 0, kills: 0, captures: 0 }],
      ships: [{ id: 1, team: 0 }],
    } as never);
    expect(root.querySelector(".hud-match-meta")?.textContent).toBe(ELIMINATION_OBJECTIVE);
    status.dispose();
  });
});

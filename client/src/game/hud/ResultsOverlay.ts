import type { EntityId, Snapshot } from "@space-arena/shared";
import type { GameSession } from "../GameSession.js";

/**
 * Results overlay (§6 1.9): shown once the sim reaches `phase: "ended"`. Its
 * "Play again" button just calls back into `main.ts`, which disposes the
 * current match runtime and builds a fresh one — this component only owns
 * display state, not session lifecycle.
 */
export class ResultsOverlay {
  private readonly root: HTMLDivElement;
  private readonly titleEl: HTMLDivElement;
  private shown = false;

  constructor(
    parent: HTMLElement,
    private readonly session: GameSession,
    private readonly playerId: EntityId,
    onPlayAgain: () => void,
  ) {
    this.root = document.createElement("div");
    this.root.className = "hud-results";

    const panel = document.createElement("div");
    panel.className = "hud-results-panel";

    this.titleEl = document.createElement("div");
    this.titleEl.className = "hud-results-title";

    const btn = document.createElement("button");
    btn.className = "hud-results-btn";
    btn.textContent = "Play Again";
    btn.addEventListener("click", () => onPlayAgain());

    panel.appendChild(this.titleEl);
    panel.appendChild(btn);
    this.root.appendChild(panel);
    parent.appendChild(this.root);
  }

  update(cur: Snapshot): void {
    if (cur.phase !== "ended") return;
    if (this.shown) return;
    this.shown = true;

    const playerTeam = this.session.teamOf(this.playerId);
    const text =
      cur.winnerTeam === null
        ? "Draw"
        : cur.winnerTeam === playerTeam
          ? "Victory"
          : "Defeat";
    this.titleEl.textContent = text;
    this.root.classList.add("visible");
  }

  dispose(): void {
    this.root.remove();
  }
}

import type { EntityId, Snapshot } from "@space-arena/shared";
import type { GameSession } from "../GameSession.js";

/** Per-player progression summary (matches the net `matchRewards` message). */
export interface MatchRewards {
  credits: number;
  xp: number;
  newLevel: number;
  leveledUp: boolean;
}

/**
 * Results overlay (§6 1.9): shown once the sim reaches `phase: "ended"`. Its
 * "Play again" button just calls back into `main.ts`, which disposes the
 * current match runtime and builds a fresh one — this component only owns
 * display state, not session lifecycle.
 *
 * Online matches additionally receive a `matchRewards` net message (§8 3.3)
 * for authenticated participants only; `showRewards` renders it whenever it
 * arrives (which may be a frame or two after `phase: "ended"` is first seen,
 * or never, for practice/anonymous sessions).
 */
export class ResultsOverlay {
  private readonly root: HTMLDivElement;
  private readonly titleEl: HTMLDivElement;
  private readonly rewardsEl: HTMLDivElement;
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

    this.rewardsEl = document.createElement("div");
    this.rewardsEl.className = "hud-results-rewards";

    const btn = document.createElement("button");
    btn.className = "hud-results-btn";
    btn.textContent = "Play Again";
    btn.addEventListener("click", () => onPlayAgain());

    panel.appendChild(this.titleEl);
    panel.appendChild(this.rewardsEl);
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

  /** Renders the reward summary; called from `main.ts` when the net event arrives. */
  showRewards(rewards: MatchRewards): void {
    this.rewardsEl.textContent = "";

    const line = document.createElement("div");
    line.className = "hud-results-rewards-line";
    line.textContent = `+${rewards.credits} credits · +${rewards.xp} xp`;
    this.rewardsEl.appendChild(line);

    if (rewards.leveledUp) {
      const levelUp = document.createElement("div");
      levelUp.className = "hud-results-levelup";
      levelUp.textContent = `Level Up! → Level ${rewards.newLevel}`;
      this.rewardsEl.appendChild(levelUp);
    }
  }

  dispose(): void {
    this.root.remove();
  }
}

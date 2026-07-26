import type { Snapshot } from "@space-arena/shared";
import type { GameSession } from "../GameSession.js";

/**
 * Top-center match status line (§6 1.9): phase + objective progress (e.g.
 * "Targets: 1/3") + a countdown when the gamemode's win condition is a
 * `timeLimit`. Text only changes when the underlying values change.
 */
export class MatchStatus {
  private readonly el: HTMLDivElement;
  private lastText = "";

  constructor(root: HTMLElement, private readonly session: GameSession) {
    this.el = document.createElement("div");
    this.el.className = "hud-match-status";
    root.appendChild(this.el);
  }

  update(cur: Snapshot): void {
    const wc = this.session.sim.world.gamemode.winCondition;
    // The countdown numerals are CountdownOverlay's job; this line only names the
    // phase, so a player glancing at the status bar during the lead-in is not
    // told the match is already live.
    const phase = cur.phase === "ended" ? "MATCH OVER" : cur.phase === "countdown" ? "STANDBY" : "LIVE";

    let objective = "";
    if (wc.type === "destroyTargets") {
      objective = `Targets: ${Math.min(this.session.destroyedTargets, wc.count)}/${wc.count}`;
    } else if (wc.type === "fragLimit") {
      objective = `Frags: ${wc.count}`;
    } else if (wc.type === "timeLimit") {
      const remaining = Math.max(0, wc.seconds - cur.elapsed);
      objective = `Time: ${remaining.toFixed(0)}s`;
    }

    const text = `${phase} — ${objective}`;
    if (text !== this.lastText) {
      this.lastText = text;
      this.el.textContent = text;
    }
  }

  dispose(): void {
    this.el.remove();
  }
}

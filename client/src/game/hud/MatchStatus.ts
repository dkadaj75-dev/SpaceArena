import type { Snapshot } from "@space-arena/shared";
import type { GameSession } from "../GameSession.js";

/**
 * Top-center match status (owner 2026-07-31): a TEAM SCOREBOARD, Overwatch
 * style — the player's team is always BLUE on the left, the enemy team always
 * RED on the right, whatever their sim team ids are. Between them sits the
 * objective/meta line: the frag target ("FIRST TO 10"), the remaining time when
 * the mode carries a hard cap, the legacy objectives for other win conditions,
 * and a RESPAWNING hint while the player's own ship is waiting out its delay.
 * The old "alive"/targets counter is retired for team modes.
 *
 * DOM writes only when a value actually changed, exactly like every other HUD
 * widget on the per-frame path.
 */
export class MatchStatus {
  private readonly el: HTMLDivElement;
  private readonly blueEl: HTMLSpanElement;
  private readonly redEl: HTMLSpanElement;
  private readonly metaEl: HTMLSpanElement;
  private lastBlue = "";
  private lastRed = "";
  private lastMeta = "";

  constructor(root: HTMLElement, private readonly session: GameSession) {
    this.el = document.createElement("div");
    this.el.className = "hud-match-status";
    this.blueEl = document.createElement("span");
    this.blueEl.className = "hud-team-score blue";
    this.metaEl = document.createElement("span");
    this.metaEl.className = "hud-match-meta";
    this.redEl = document.createElement("span");
    this.redEl.className = "hud-team-score red";
    this.el.append(this.blueEl, this.metaEl, this.redEl);
    root.appendChild(this.el);
  }

  update(cur: Snapshot): void {
    const gamemode = this.session.sim.world.gamemode;
    const wc = gamemode.winCondition;

    // Blue is ALWAYS the player's team; red aggregates everyone else (there are
    // only two teams in shipped modes, but a sum is the honest generalisation).
    const playerTeam = this.session.playerTeam;
    let blueKills = 0;
    let redKills = 0;
    for (const score of cur.teamScores) {
      if (score.team === playerTeam) blueKills += score.kills;
      else redKills += score.kills;
    }

    // The countdown numerals are CountdownOverlay's job; this line only names
    // the phase, so a player glancing up during the lead-in is not told the
    // match is already live.
    let meta: string;
    if (cur.phase === "ended") {
      meta = "MATCH OVER";
    } else if (cur.phase === "countdown") {
      meta = "STANDBY";
    } else {
      const parts: string[] = [];
      if (wc.type === "fragLimit") parts.push(`FIRST TO ${wc.count}`);
      else if (wc.type === "destroyTargets") {
        parts.push(`TARGETS ${Math.min(this.session.destroyedTargets, wc.count)}/${wc.count}`);
      }
      const capSec = gamemode.timeLimitCapSec ?? (wc.type === "timeLimit" ? wc.seconds : undefined);
      if (capSec !== undefined) parts.push(formatClock(Math.max(0, capSec - cur.elapsed)));
      // The player's own ship missing while live means one thing: waiting out
      // the respawn delay.
      if (!hasShip(cur, this.session.playerId)) parts.push("RESPAWNING…");
      meta = parts.join(" · ") || "LIVE";
    }

    const blue = String(blueKills);
    const red = String(redKills);
    if (blue !== this.lastBlue) {
      this.lastBlue = blue;
      this.blueEl.textContent = blue;
    }
    if (red !== this.lastRed) {
      this.lastRed = red;
      this.redEl.textContent = red;
    }
    if (meta !== this.lastMeta) {
      this.lastMeta = meta;
      this.metaEl.textContent = meta;
    }
  }

  dispose(): void {
    this.el.remove();
  }
}

/** m:ss for the cap countdown — whole seconds, no sub-second churn. */
function formatClock(seconds: number): string {
  const whole = Math.ceil(seconds);
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return `${m}:${s < 10 ? "0" : ""}${s}`;
}

function hasShip(snapshot: Snapshot, id: number): boolean {
  for (let i = 0; i < snapshot.ships.length; i++) if (snapshot.ships[i]!.id === id) return true;
  return false;
}

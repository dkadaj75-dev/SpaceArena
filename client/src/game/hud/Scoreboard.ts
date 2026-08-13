import type { EntityId, MatchStatLine, Snapshot } from "@space-arena/shared";
import type { GameSession } from "../GameSession.js";
import { HUD_CONTROL_ATTR } from "../inputGuards.js";
import { compareMatchStats, teamPerspective, viewerTeam } from "./matchPresentation.js";

interface Row { tr: HTMLTableRowElement; cells: HTMLTableCellElement[]; signature: string }

export class Scoreboard {
  private readonly root: HTMLDivElement;
  private readonly bodies = new Map<number, HTMLTableSectionElement>();
  private readonly rows = new Map<EntityId, Row>();
  private readonly button: HTMLButtonElement;
  private readonly panel: HTMLDivElement;
  private readonly teamRows: HTMLDivElement;
  private readonly finalActions: HTMLDivElement;
  private visible = false;
  private mode: "play" | "locked" | "final" = "play";
  private readonly ctf: boolean;
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Tab" || this.mode !== "play") return;
    event.preventDefault();
    this.setVisible(true);
  };
  private readonly onKeyUp = (event: KeyboardEvent): void => { if (event.key === "Tab" && this.mode === "play") this.setVisible(false); };

  constructor(parent: HTMLElement, private readonly session: GameSession, callbacks: { onPlayAgain: () => void; onMenu: () => void }) {
    this.ctf = session.sim.world.gamemode.ctf !== undefined;
    this.root = document.createElement("div");
    this.root.className = "hud-scoreboard";
    const panel = document.createElement("div");
    this.panel = panel;
    panel.className = "hud-scoreboard-panel hud-frame";
    const title = document.createElement("h2"); title.textContent = "SCOREBOARD";
    panel.appendChild(title);
    this.teamRows = document.createElement("div");
    this.teamRows.className = "hud-scoreboard-rows";
    panel.appendChild(this.teamRows);
    this.finalActions = document.createElement("div");
    this.finalActions.className = "hud-scoreboard-actions";
    this.finalActions.append(
      actionButton("Play a New Game", "playAgain", callbacks.onPlayAgain),
      actionButton("Quit to Menu", "menu", callbacks.onMenu),
    );
    panel.appendChild(this.finalActions);
    this.root.appendChild(panel);
    parent.appendChild(this.root);
    this.button = document.createElement("button");
    this.button.className = "hud-scoreboard-btn hud-button hud-button--secondary";
    this.button.textContent = "SCORE";
    this.button.setAttribute("aria-label", "SCORE");
    this.button.setAttribute(HUD_CONTROL_ATTR, "");
    this.button.addEventListener("click", () => { if (this.mode === "play") this.setVisible(!this.visible); });
    parent.appendChild(this.button);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
  }

  update(snapshot: Snapshot): void {
    const ownTeam = viewerTeam(snapshot, this.session.playerId);
    for (const ship of snapshot.ships) this.ensureRow(ship.id, ship.team, ownTeam);
    for (const [team, body] of this.bodies) {
      const table = body.parentElement!;
      table.classList.toggle("hud-scoreboard-team--ally", teamPerspective(team, ownTeam) === "ally");
      table.classList.toggle("hud-scoreboard-team--enemy", teamPerspective(team, ownTeam) === "enemy");
    }
    this.session.matchStats.forEach((line) => this.paint(line));
  }

  showFinal(): void {
    this.mode = "final";
    this.root.classList.add("final");
    this.button.style.display = "none";
    this.setVisible(true);
  }

  lockForEnd(): void {
    this.mode = "locked";
    this.button.style.display = "none";
    this.setVisible(false);
  }

  private ensureRow(id: EntityId, team: number, ownTeam: number): void {
    if (this.rows.has(id)) return;
    let body = this.bodies.get(team);
    if (!body) {
      const table = document.createElement("table");
      table.dataset["team"] = String(team);
      table.classList.add(`hud-scoreboard-team--${teamPerspective(team, ownTeam)}`);
      const caption = document.createElement("caption"); caption.textContent = `TEAM ${team + 1}`;
      const head = document.createElement("thead");
      const hr = document.createElement("tr");
      for (const label of ["PILOT", "K", "D", "A", ...(this.ctf ? ["TAKEN", "RETURN", "CAP"] : [])]) { const th = document.createElement("th"); th.textContent = label; hr.appendChild(th); }
      head.appendChild(hr); body = document.createElement("tbody"); table.append(caption, head, body);
      this.teamRows.appendChild(table); this.bodies.set(team, body);
    }
    const tr = document.createElement("tr");
    tr.dataset["entityId"] = String(id);
    // Shared by the hold-Tab and final scoreboards, so one marker styles both.
    tr.classList.toggle("hud-scoreboard-local-player", id === this.session.playerId);
    const cells: HTMLTableCellElement[] = [];
    const count = this.ctf ? 7 : 4;
    for (let i = 0; i < count; i++) { const td = document.createElement("td"); tr.appendChild(td); cells.push(td); }
    body.appendChild(tr); this.rows.set(id, { tr, cells, signature: "" });
    this.paint(this.session.matchStats.line(id));
  }

  private paint(line: Readonly<MatchStatLine>): void {
    const row = this.rows.get(line.entityId); if (!row) return;
    const displayName = this.session.displayNameFor(line.entityId) ?? `Pilot ${line.entityId}`;
    const name = this.session.isBotFor(line.entityId) ? `${displayName} [BOT]` : displayName;
    const sig = `${name}|${line.kills}|${line.deaths}|${line.assists}|${line.flagsTaken}|${line.flagsReturned}|${line.flagsCaptured}`;
    if (sig === row.signature) return;
    row.signature = sig;
    const values: (string | number)[] = [name, line.kills, line.deaths, line.assists];
    if (this.ctf) values.push(line.flagsTaken, line.flagsReturned, line.flagsCaptured);
    for (let i = 0; i < values.length; i++) row.cells[i]!.textContent = String(values[i]);
    const body = row.tr.parentElement!;
    const sorted = [...body.children] as HTMLTableRowElement[];
    sorted.sort((a, b) => {
      const aId = Number(a.dataset["entityId"]);
      const bId = Number(b.dataset["entityId"]);
      return compareMatchStats(this.session.matchStats.line(aId), this.session.matchStats.line(bId), this.ctf);
    });
    for (const tr of sorted) body.appendChild(tr);
  }

  private setVisible(visible: boolean): void {
    this.visible = visible;
    this.root.classList.toggle("visible", visible);
    this.button.textContent = visible ? "CLOSE" : "SCORE";
    this.button.setAttribute("aria-label", visible ? "CLOSE" : "SCORE");
    this.button.setAttribute("aria-pressed", String(visible));
  }
  dispose(): void { window.removeEventListener("keydown", this.onKeyDown); window.removeEventListener("keyup", this.onKeyUp); this.root.remove(); this.button.remove(); }
}

function actionButton(label: string, key: string, callback: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "hud-results-btn";
  button.textContent = label;
  button.dataset["resultsAction"] = key;
  button.addEventListener("click", callback);
  return button;
}

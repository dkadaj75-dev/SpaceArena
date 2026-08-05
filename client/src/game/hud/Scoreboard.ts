import type { EntityId, MatchStatLine, Snapshot } from "@space-arena/shared";
import type { GameSession } from "../GameSession.js";
import { HUD_CONTROL_ATTR } from "../inputGuards.js";

interface Row { tr: HTMLTableRowElement; cells: HTMLTableCellElement[]; signature: string }

export class Scoreboard {
  private readonly root: HTMLDivElement;
  private readonly bodies = new Map<number, HTMLTableSectionElement>();
  private readonly rows = new Map<EntityId, Row>();
  private readonly button: HTMLButtonElement;
  private readonly panel: HTMLDivElement;
  private resultsHost: HTMLElement | null = null;
  private mountedInResults = false;
  private visible = false;
  private readonly ctf: boolean;
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Tab") return;
    event.preventDefault();
    this.setVisible(true);
  };
  private readonly onKeyUp = (event: KeyboardEvent): void => { if (event.key === "Tab") this.setVisible(false); };

  constructor(parent: HTMLElement, private readonly session: GameSession) {
    this.ctf = session.sim.world.gamemode.ctf !== undefined;
    this.root = document.createElement("div");
    this.root.className = "hud-scoreboard";
    const panel = document.createElement("div");
    this.panel = panel;
    panel.className = "hud-scoreboard-panel hud-frame";
    const title = document.createElement("h2"); title.textContent = "SCOREBOARD";
    panel.appendChild(title);
    this.root.appendChild(panel);
    parent.appendChild(this.root);
    this.button = document.createElement("button");
    this.button.className = "hud-scoreboard-btn";
    this.button.textContent = "SCORE";
    this.button.setAttribute(HUD_CONTROL_ATTR, "");
    this.button.addEventListener("click", () => this.setVisible(!this.visible));
    parent.appendChild(this.button);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
  }

  update(snapshot: Snapshot): void {
    for (const ship of snapshot.ships) this.ensureRow(ship.id, ship.team);
    this.session.matchStats.forEach((line) => this.paint(line));
    if (snapshot.phase === "ended" && this.resultsHost && !this.mountedInResults) {
      this.mountedInResults = true;
      this.setVisible(false);
      this.button.style.display = "none";
      this.resultsHost.appendChild(this.panel);
    }
  }

  setResultsHost(host: HTMLElement): void { this.resultsHost = host; }

  private ensureRow(id: EntityId, team: number): void {
    if (this.rows.has(id)) return;
    let body = this.bodies.get(team);
    if (!body) {
      const table = document.createElement("table");
      table.dataset["team"] = String(team);
      const caption = document.createElement("caption"); caption.textContent = `TEAM ${team + 1}`;
      const head = document.createElement("thead");
      const hr = document.createElement("tr");
      for (const label of ["PILOT", "K", "D", "A", ...(this.ctf ? ["TAKEN", "RETURN", "CAP"] : [])]) { const th = document.createElement("th"); th.textContent = label; hr.appendChild(th); }
      head.appendChild(hr); body = document.createElement("tbody"); table.append(caption, head, body);
      this.root.firstElementChild!.appendChild(table); this.bodies.set(team, body);
    }
    const tr = document.createElement("tr");
    const cells: HTMLTableCellElement[] = [];
    const count = this.ctf ? 7 : 4;
    for (let i = 0; i < count; i++) { const td = document.createElement("td"); tr.appendChild(td); cells.push(td); }
    body.appendChild(tr); this.rows.set(id, { tr, cells, signature: "" });
    this.paint(this.session.matchStats.line(id));
  }

  private paint(line: Readonly<MatchStatLine>): void {
    const row = this.rows.get(line.entityId); if (!row) return;
    const name = this.session.displayNameFor(line.entityId) ?? `Pilot ${line.entityId}`;
    const sig = `${name}|${line.kills}|${line.deaths}|${line.assists}|${line.flagsTaken}|${line.flagsReturned}|${line.flagsCaptured}`;
    if (sig === row.signature) return;
    row.signature = sig;
    const values: (string | number)[] = [name, line.kills, line.deaths, line.assists];
    if (this.ctf) values.push(line.flagsTaken, line.flagsReturned, line.flagsCaptured);
    for (let i = 0; i < values.length; i++) row.cells[i]!.textContent = String(values[i]);
    const body = row.tr.parentElement!;
    const sorted = [...body.children] as HTMLTableRowElement[];
    sorted.sort((a, b) => this.score(b) - this.score(a));
    for (const tr of sorted) body.appendChild(tr);
  }

  private score(tr: HTMLTableRowElement): number {
    const c = tr.children;
    return Number(c[1]?.textContent) * 100 - Number(c[2]?.textContent) * 10 + Number(c[3]?.textContent) * 25 + (this.ctf ? Number(c[6]?.textContent) * 1000 + Number(c[5]?.textContent) * 100 : 0);
  }

  private setVisible(visible: boolean): void { this.visible = visible; this.root.classList.toggle("visible", visible); this.button.setAttribute("aria-pressed", String(visible)); }
  dispose(): void { window.removeEventListener("keydown", this.onKeyDown); window.removeEventListener("keyup", this.onKeyUp); this.root.remove(); this.button.remove(); }
}

import { hardpointsOf, type ModuleConfig, type ShipConfig } from "@space-arena/shared";
import type { EditorHost, EditorPanel } from "./EditorShell.js";
import { defaultFitOf, fitMetrics, simulateEngagement, timeToKill, type FitMetrics } from "./balanceMath.js";

/** A comparison row in the balance table. */
interface FitRow {
  key: string;
  label: string;
  ship: ShipConfig;
  modules: (string | null)[];
  metrics: FitMetrics;
}

/**
 * Balance workbench (4.6b) — closed-form comparison of every ship's default fit
 * plus a custom fit, a TTK matrix, and a 60 s sustained-combat simulator that
 * plots module energy over time. All values recompute on `config:changed` for
 * hot balance iteration. Arithmetic over configs only (see balanceMath docs).
 */
export class BalanceWorkbench implements EditorPanel {
  readonly element = document.createElement("div");
  private readonly unsubscribe: () => void;
  private customShipId: string;
  private readonly customModules: (string | null)[] = [];
  private selectedFitKey = "";
  /** Whether the Custom fit accordion is open — see {@link customFitEditor}. */
  private customFitOpen = false;

  constructor(private readonly host: EditorHost, private readonly _report: (message: string | null) => void) {
    void this._report;
    this.customShipId = host.configService.getAll<ShipConfig>("ship")[0]?.id ?? "";
    this.unsubscribe = host.bus.on("config:changed", () => this.render());
    this.render();
  }

  private configs(): EditorHost["configService"] {
    return this.host.configService;
  }

  /** Build every comparison row: each ship's default fit + the custom fit. */
  private rows(): FitRow[] {
    const cfg = this.configs();
    const ships = cfg.getAll<ShipConfig>("ship");
    const rows: FitRow[] = ships.map((ship) => {
      const modules = defaultFitOf(ship);
      return { key: ship.id, label: `${ship.name ?? ship.id} (default)`, ship, modules, metrics: fitMetrics(ship, cfg, modules) };
    });
    const customShip = cfg.get<ShipConfig>("ship", this.customShipId);
    if (customShip) {
      const modules = this.normalizedCustomModules(customShip);
      rows.push({ key: "custom", label: `${customShip.name ?? customShip.id} (custom)`, ship: customShip, modules, metrics: fitMetrics(customShip, cfg, modules) });
    }
    return rows;
  }

  private normalizedCustomModules(ship: ShipConfig): (string | null)[] {
    const count = hardpointsOf(ship).length;
    const out: (string | null)[] = [];
    for (let i = 0; i < count; i++) out.push(this.customModules[i] ?? ship.defaultFitting[i] ?? null);
    return out;
  }

  private render(): void {
    this.element.replaceChildren();
    const rows = this.rows();
    if (rows.length === 0) {
      this.element.append(textEl("p", "No ship configs loaded."));
      return;
    }
    if (!rows.some((r) => r.key === this.selectedFitKey)) this.selectedFitKey = rows[0]!.key;

    this.element.append(textEl("h3", "Stat comparison"));
    this.element.append(this.statTable(rows));
    this.element.append(textEl("h3", "TTK matrix (attacker → defender, seconds)"));
    this.element.append(this.ttkMatrix(rows));
    this.element.append(this.customFitEditor());
    this.element.append(textEl("h3", "60 s engagement simulator"));
    this.element.append(this.engagementPanel(rows));
    const note = textEl("p", "TTK and stats are closed-form over configs (no movement/LoS/shield-reduction). See balanceMath.ts for each simplification.");
    note.className = "ed-note";
    this.element.append(note);
  }

  private statTable(rows: FitRow[]): HTMLElement {
    // Header text carries the UNIT and, where the name is not self-evident, a
    // tooltip of the formula — "Tanks" and "Recharge x" said nothing about what
    // was being counted, and a bare "Speed" could be read as m/s or as a rating.
    const cols: [string, (m: FitMetrics) => string, string][] = [
      ["Hull", (m) => fmt(m.hull), "Base hull pool, before resists."],
      ["EHP", (m) => fmt(m.ehp), "Effective HP: hull x (1 + average resist)."],
      ["Speed (u/s)", (m) => fmt(m.speed), "Engine nominal speed, world units per second."],
      ["Energy tanks", (m) => fmt(m.energyReserve), "Sum of every fitted module's own energy tank."],
      ["Recharge (x)", (m) => fmt(m.rechargeMult), "Hull-wide recharge multiplier: generator + passives."],
      ["Burst DPS", (m) => fmt(m.burstDps), "Sum of weapon damage / cycle time — the trigger-down rate."],
      ["Sustained DPS", (m) => fmt(m.sustainedDps), "Burst DPS with each weapon's magazine downtime paid."],
      ["Shield", (m) => fmt(m.shieldPool), "Total fitted shield pool."],
    ];
    const table = document.createElement("table");
    table.className = "ed-table";
    const head = table.insertRow();
    head.append(th("Fit"));
    for (const [name, , doc] of cols) {
      const cell = th(name);
      cell.title = doc;
      head.append(cell);
    }
    for (const r of rows) {
      const tr = table.insertRow();
      tr.append(td(r.label, true));
      for (const [, get] of cols) tr.append(td(get(r.metrics)));
    }
    return table;
  }

  private ttkMatrix(rows: FitRow[]): HTMLElement {
    const table = document.createElement("table");
    table.className = "ed-table";
    const head = table.insertRow();
    head.append(th("Attacker \\ defender"));
    for (const r of rows) head.append(th(shortLabel(r.label)));
    for (const atk of rows) {
      const tr = table.insertRow();
      tr.append(td(shortLabel(atk.label), true));
      for (const def of rows) tr.append(td(fmtTime(timeToKill(atk.metrics, def.metrics))));
    }
    return table;
  }

  private customFitEditor(): HTMLElement {
    const box = document.createElement("details");
    // Folded: the workbench is read first (the tables above are the answer) and
    // authored second, so the fit builder should not push the comparison it
    // exists to feed off the screen. {@link customFitOpen} survives the panel
    // rebuild each fit change causes.
    box.open = this.customFitOpen;
    box.addEventListener("toggle", () => { this.customFitOpen = box.open; });
    const summary = document.createElement("summary");
    summary.textContent = "Custom fit";
    box.append(summary);

    const cfg = this.configs();
    const shipSelect = document.createElement("select");
    for (const s of cfg.getAll<ShipConfig>("ship")) shipSelect.append(new Option(s.name ?? s.id, s.id, false, s.id === this.customShipId));
    shipSelect.addEventListener("change", () => {
      this.customShipId = shipSelect.value;
      this.customModules.length = 0;
      this.render();
    });
    box.append(labeled("Ship", shipSelect));

    const ship = cfg.get<ShipConfig>("ship", this.customShipId);
    if (ship) {
      const modules = cfg.getAll<ModuleConfig>("module");
      const current = this.normalizedCustomModules(ship);
      hardpointsOf(ship).forEach((hp, i) => {
        const sel = document.createElement("select");
        sel.append(new Option("(none)", "", false, !current[i]));
        for (const m of modules.filter((mod) => hp.accepts.includes(mod.family))) {
          sel.append(new Option(`${m.name ?? m.id} [${m.family}]`, m.id, false, m.id === current[i]));
        }
        sel.addEventListener("change", () => {
          this.customModules[i] = sel.value || null;
          this.render();
        });
        box.append(labeled(`#${i} ${hp.id}`, sel));
      });
    }
    return box;
  }

  private engagementPanel(rows: FitRow[]): HTMLElement {
    const box = document.createElement("div");
    const select = document.createElement("select");
    for (const r of rows) select.append(new Option(r.label, r.key, false, r.key === this.selectedFitKey));
    select.addEventListener("change", () => {
      this.selectedFitKey = select.value;
      this.render();
    });
    box.append(labeled("Fit", select));

    const row = rows.find((r) => r.key === this.selectedFitKey);
    if (!row) return box;
    const result = simulateEngagement(row.ship, this.configs(), row.modules);

    const canvas = document.createElement("canvas");
    canvas.width = 340;
    canvas.height = 140;
    canvas.className = "ed-chart";
    box.append(canvas);
    // The tank series is already a 0..1 fraction of each module's OWN store,
    // which is the only way to draw one line for a fit whose tanks differ in
    // size. The second series counts modules actually running, scaled to its
    // own peak so a fit with one tanked module still fills the chart.
    const working = result.samples.map((s) => s.activeCount);
    const peak = Math.max(1, ...working);
    this.plot(canvas, result.samples.map((s) => s.energy), 1, "#57d8ff", working, peak, "#ff9a3c");

    const legend = textEl("p", `emptiest tank (cyan) · modules working (orange, peak ${peak}) · uptime ${fmt(result.uptime * 100)}% · ${result.flameouts} flameout(s)`);
    legend.className = "ed-legend";
    box.append(legend);
    return box;
  }

  /** Two normalized series on one canvas (no chart lib). */
  private plot(canvas: HTMLCanvasElement, a: number[], aMax: number, aColor: string, b: number[], bMax: number, bColor: string): void {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { width: w, height: h } = canvas;
    ctx.clearRect(0, 0, w, h);
    const line = (series: number[], max: number, color: string): void => {
      if (series.length === 0 || max <= 0) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      series.forEach((v, i) => {
        const x = (i / (series.length - 1)) * (w - 2) + 1;
        const y = h - 1 - (Math.max(0, Math.min(max, v)) / max) * (h - 2);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    };
    line(a, aMax, aColor);
    line(b, bMax, bColor);
  }

  dispose(): void {
    this.unsubscribe();
    this.element.replaceChildren();
  }
}

// ------------------------------------------------------------- helpers ----

function fmt(v: number): string {
  if (!isFinite(v)) return "∞";
  return Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1);
}
function fmtTime(v: number): string {
  return isFinite(v) ? `${v.toFixed(1)}s` : "∞";
}
function shortLabel(label: string): string {
  return label.replace(/\s*\(.*\)$/, "").slice(0, 10);
}
function textEl(tag: string, content: string): HTMLElement {
  const el = document.createElement(tag);
  el.textContent = content;
  return el;
}
function th(content: string): HTMLTableCellElement {
  const cell = document.createElement("th");
  cell.textContent = content;
  return cell;
}
function td(content: string, head = false): HTMLTableCellElement {
  const cell = document.createElement("td");
  cell.textContent = content;
  if (head) cell.className = "ed-cell-head";
  return cell;
}
function labeled(label: string, control: Node): HTMLElement {
  const wrap = document.createElement("label");
  wrap.className = "editor-field";
  const span = document.createElement("span");
  span.textContent = label;
  wrap.append(span, control);
  return wrap;
}

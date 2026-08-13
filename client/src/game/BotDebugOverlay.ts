import { Color3, MeshBuilder, Vector3, type LinesMesh, type Scene } from "@babylonjs/core";
import type { BotDriver, EntityId, LosCircle, Snapshot, StaticLosWorld } from "@space-arena/shared";
import {
  BOT_OVERLAY_EVENT,
  BOT_OVERLAY_KEY,
  botOverlayEnabled,
  collectBlockers,
  setBotOverlayEnabled,
  updateBotOverlayRows,
  type BotOverlayRow,
} from "./botOverlayModel.js";

const LINE_Y = 0.25;
const MOVE_COLOR = new Color3(0.45, 0.85, 1.0);
const LOS_CLEAR_COLOR = new Color3(0.3, 1.0, 0.45);
const LOS_BLOCKED_COLOR = new Color3(1.0, 0.3, 0.3);
/** Half-width of the diamond drawn at a bot's chosen move point. */
const MARKER_SIZE = 1.6;

const STYLE_ID = "sa-botdbg-style";
const CSS = `
.sa-botdbg{position:fixed;left:8px;top:8px;z-index:29;display:flex;flex-direction:column;gap:6px;
  pointer-events:none;font:11px/1.45 ui-monospace,"Cascadia Mono",Consolas,monospace;color:#cfe8ff;max-width:280px}
.sa-botdbg-card{background:rgba(4,10,18,.82);border:1px solid rgba(80,190,255,.35);border-left:2px solid #57d8ff;padding:5px 7px}
.sa-botdbg-head{display:flex;justify-content:space-between;gap:8px;color:#9fe6ff;letter-spacing:.04em}
.sa-botdbg-behavior{color:#ffd166;font-weight:700}
.sa-botdbg-flags{color:#7fa6c0}
.sa-botdbg-bar{display:grid;grid-template-columns:64px 1fr 34px;align-items:center;gap:4px}
.sa-botdbg-track{height:5px;background:rgba(120,180,220,.18)}
.sa-botdbg-fill{display:block;height:100%;background:#3aa0d8}
.sa-botdbg-bar.is-chosen .sa-botdbg-fill{background:#ffd166}
.sa-botdbg-val{text-align:right;color:#8fb8d4}
.sa-botdbg-mods{color:#9ad7a5;white-space:pre-line}
.sa-botdbg-dead{color:#ff7a7a}
`;

/** One bot's pooled DOM card. */
interface CardNodes {
  root: HTMLDivElement;
  name: HTMLSpanElement;
  behavior: HTMLSpanElement;
  flags: HTMLDivElement;
  bars: HTMLDivElement;
  barPool: { row: HTMLDivElement; key: HTMLSpanElement; fill: HTMLSpanElement; value: HTMLSpanElement }[];
  mods: HTMLDivElement;
  /** Decision + bot the text/bars were last drawn from (skips redundant DOM writes). */
  drawn: unknown;
  drawnId: EntityId;
}

/** One bot's pooled in-scene lines. */
interface LineNodes {
  move: LinesMesh;
  marker: LinesMesh;
  los: LinesMesh;
}

/**
 * DEV-only live view of what every bot in a practice match is thinking
 * (ROADMAP 5.3): a HUD card per bot — profile, winning behaviour, per-behaviour
 * utility bars, engaged flag, module toggles — plus in-scene lines to the
 * chosen move point and a line-of-sight ray to the target (green = clear,
 * red = blocked).
 *
 * Toggled with {@link BOT_OVERLAY_KEY} or the Bots tab's "show live overlay"
 * checkbox (persisted in localStorage). Completely inert while hidden: no DOM
 * writes, no snapshot scans, no meshes enabled. Every visible-frame update
 * mutates pooled rows/meshes — no per-frame allocation.
 */
export class BotDebugOverlay {
  private readonly host: HTMLDivElement;
  private readonly cards: CardNodes[] = [];
  private readonly lines: LineNodes[] = [];
  private readonly rows: BotOverlayRow[] = [];
  private readonly blockers: LosCircle[] = [];
  /** Reused endpoints for the two 2-point lines. */
  private readonly seg = [new Vector3(), new Vector3()];
  /** User flag (F8 / editor checkbox). */
  private enabled: boolean;
  /** Forced off while the editor owns the canvas (see `setGameVisible`). */
  private suppressed = false;
  private visible = false;

  private readonly onKey = (event: KeyboardEvent): void => {
    if (event.key !== BOT_OVERLAY_KEY || event.repeat) return;
    event.preventDefault();
    setBotOverlayEnabled(!this.enabled); // fires BOT_OVERLAY_EVENT → onFlag
  };
  private readonly onFlag = (event: Event): void => {
    this.setVisible((event as CustomEvent<boolean>).detail === true);
  };

  constructor(
    private readonly scene: Scene,
    private readonly session: { bots: ReadonlyMap<EntityId, BotDriver>; curSnapshot: Snapshot; botStaticWorld?: StaticLosWorld },
  ) {
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.append(style);
    }
    this.host = document.createElement("div");
    this.host.className = "sa-botdbg";
    document.body.append(this.host);

    this.enabled = botOverlayEnabled();
    this.apply();
    window.addEventListener("keydown", this.onKey);
    window.addEventListener(BOT_OVERLAY_EVENT, this.onFlag);
  }

  get isVisible(): boolean {
    return this.visible;
  }

  /** Turn the overlay on/off (the persisted user flag). */
  setVisible(enabled: boolean): void {
    this.enabled = enabled;
    this.apply();
  }

  /**
   * Force the overlay off without touching the user flag — used while the dev
   * editor hides the live match, so debug cards/lines don't float over its
   * viewport.
   */
  setSuppressed(suppressed: boolean): void {
    this.suppressed = suppressed;
    this.apply();
  }

  private apply(): void {
    const visible = this.enabled && !this.suppressed;
    if (visible === this.visible) return;
    this.visible = visible;
    this.host.hidden = !visible;
    if (!visible) for (const line of this.lines) this.disableLines(line);
  }

  /** Call once per render frame. Returns immediately while hidden. */
  update(): void {
    if (!this.visible) return;
    const snapshot = this.session.curSnapshot;
    collectBlockers(snapshot, this.blockers);
    const count = updateBotOverlayRows(this.rows, this.session.bots.values(), snapshot, this.blockers, this.session.botStaticWorld);
    for (let i = 0; i < count; i++) this.drawRow(i, this.rows[i]!);
    for (let i = count; i < this.cards.length; i++) this.cards[i]!.root.hidden = true;
    for (let i = count; i < this.lines.length; i++) this.disableLines(this.lines[i]!);
  }

  private drawRow(index: number, row: BotOverlayRow): void {
    const card = this.cards[index] ?? this.createCard();
    card.root.hidden = false;

    // Text + bars only change on a decision tick, not every frame.
    if (card.drawn !== row.decision || card.drawnId !== row.entityId) {
      card.drawn = row.decision;
      card.drawnId = row.entityId;
      card.name.textContent = `#${row.entityId} ${row.profileName}`;
      card.behavior.textContent = row.behavior;
      card.flags.textContent = `${row.engaged ? "engaged" : "disengaged"} · ${row.profileId}`;
      this.drawBars(card, row);
      card.mods.textContent = formatModules(row);
    }
    card.root.classList.toggle("sa-botdbg-dead", !row.alive);

    const lines = this.lines[index] ?? this.createLines(index);
    if (!row.alive) {
      this.disableLines(lines);
      return;
    }
    if (row.hasMove) {
      this.seg[0]!.set(row.posX, LINE_Y, row.posZ);
      this.seg[1]!.set(row.moveX, LINE_Y, row.moveZ);
      MeshBuilder.CreateLines("botDbgMove", { points: this.seg, instance: lines.move });
      lines.move.setEnabled(true);
      lines.marker.position.set(row.moveX, LINE_Y, row.moveZ);
      lines.marker.setEnabled(true);
    } else {
      lines.move.setEnabled(false);
      lines.marker.setEnabled(false);
    }
    if (row.hasTarget) {
      this.seg[0]!.set(row.posX, LINE_Y, row.posZ);
      this.seg[1]!.set(row.targetX, LINE_Y, row.targetZ);
      MeshBuilder.CreateLines("botDbgLos", { points: this.seg, instance: lines.los });
      lines.los.color = row.losClear ? LOS_CLEAR_COLOR : LOS_BLOCKED_COLOR;
      lines.los.setEnabled(true);
    } else {
      lines.los.setEnabled(false);
    }
  }

  private drawBars(card: CardNodes, row: BotOverlayRow): void {
    for (let i = 0; i < row.scoreCount; i++) {
      const score = row.scores[i]!;
      let bar = card.barPool[i];
      if (!bar) {
        const barRow = document.createElement("div");
        barRow.className = "sa-botdbg-bar";
        const key = document.createElement("span");
        const track = document.createElement("span");
        track.className = "sa-botdbg-track";
        const fill = document.createElement("span");
        fill.className = "sa-botdbg-fill";
        track.append(fill);
        const value = document.createElement("span");
        value.className = "sa-botdbg-val";
        barRow.append(key, track, value);
        card.bars.append(barRow);
        bar = { row: barRow, key, fill, value };
        card.barPool.push(bar);
      }
      bar.row.hidden = false;
      bar.row.classList.toggle("is-chosen", score.chosen);
      bar.key.textContent = score.key;
      bar.fill.style.width = `${Math.round(score.fraction * 100)}%`;
      bar.value.textContent = score.score.toFixed(2);
    }
    for (let i = row.scoreCount; i < card.barPool.length; i++) card.barPool[i]!.row.hidden = true;
  }

  private createCard(): CardNodes {
    const root = document.createElement("div");
    root.className = "sa-botdbg-card";
    const head = document.createElement("div");
    head.className = "sa-botdbg-head";
    const name = document.createElement("span");
    const behavior = document.createElement("span");
    behavior.className = "sa-botdbg-behavior";
    head.append(name, behavior);
    const flags = document.createElement("div");
    flags.className = "sa-botdbg-flags";
    const bars = document.createElement("div");
    const mods = document.createElement("div");
    mods.className = "sa-botdbg-mods";
    root.append(head, flags, bars, mods);
    this.host.append(root);
    const card: CardNodes = { root, name, behavior, flags, bars, barPool: [], mods, drawn: undefined, drawnId: -1 };
    this.cards.push(card);
    return card;
  }

  private createLines(index: number): LineNodes {
    const move = MeshBuilder.CreateLines(
      `botDbgMove.${index}`,
      { points: [new Vector3(), new Vector3()], updatable: true },
      this.scene,
    );
    move.color = MOVE_COLOR;
    const los = MeshBuilder.CreateLines(
      `botDbgLos.${index}`,
      { points: [new Vector3(), new Vector3()], updatable: true },
      this.scene,
    );
    los.color = LOS_CLEAR_COLOR;
    // Static diamond, moved by its transform (never re-tessellated).
    const marker = MeshBuilder.CreateLines(`botDbgMark.${index}`, { points: diamond() }, this.scene);
    marker.color = MOVE_COLOR;
    const nodes: LineNodes = { move, marker, los };
    for (const mesh of [move, los, marker]) {
      mesh.isPickable = false;
      mesh.setEnabled(false);
    }
    this.lines.push(nodes);
    return nodes;
  }

  private disableLines(nodes: LineNodes): void {
    nodes.move.setEnabled(false);
    nodes.marker.setEnabled(false);
    nodes.los.setEnabled(false);
  }

  dispose(): void {
    window.removeEventListener("keydown", this.onKey);
    window.removeEventListener(BOT_OVERLAY_EVENT, this.onFlag);
    for (const nodes of this.lines) {
      nodes.move.dispose();
      nodes.marker.dispose();
      nodes.los.dispose();
    }
    this.lines.length = 0;
    this.host.remove();
  }
}

/** Closed 4-point diamond outline around the origin. */
function diamond(): Vector3[] {
  return [
    new Vector3(-MARKER_SIZE, 0, 0),
    new Vector3(0, 0, MARKER_SIZE),
    new Vector3(MARKER_SIZE, 0, 0),
    new Vector3(0, 0, -MARKER_SIZE),
    new Vector3(-MARKER_SIZE, 0, 0),
  ];
}

/** One line per module toggle the discipline layer emitted this decision. */
function formatModules(row: BotOverlayRow): string {
  if (row.modules.length === 0) return "";
  let out = "";
  for (const decision of row.modules) {
    out += `${out ? "\n" : ""}${decision.activate ? "▲" : "▼"} ${decision.moduleId} (${decision.reason})`;
  }
  return out;
}

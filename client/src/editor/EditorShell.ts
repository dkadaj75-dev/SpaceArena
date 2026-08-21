import type { Scene } from "@babylonjs/core";
import { CONFIG_SCHEMAS, type ConfigEvents, type ConfigService, type EventBus } from "@space-arena/shared";
import { MapEditor } from "./MapEditor.js";
import { SchemaFormGen } from "./SchemaFormGen.js";
import { arenaSchema, type ArenaConfig } from "@space-arena/shared";
import { TuningPanel } from "./TuningPanel.js";
import { AssetEditor } from "./AssetEditor.js";
import { ActionEditor } from "./ActionEditor.js";
import { NotificationEditor } from "./NotificationEditor.js";
import { ShipManager } from "./ShipManager.js";
import { SkinEditor } from "./SkinEditor.js";
import { BalanceWorkbench } from "./BalanceWorkbench.js";
import { BotProfileEditor } from "./BotProfileEditor.js";
import { GamemodeEditor } from "./GamemodeEditor.js";
import { ThemeEditor } from "./ThemeEditor.js";
import { QualityEditor } from "./QualityEditor.js";
import { ConsolePanel } from "./ConsolePanel.js";
import { EditorStage } from "./EditorStage.js";
import { onConfigSaved, saveConfig } from "./saveConfig.js";
import "./editor.css";
import { applicationNotice } from "./applicationScope.js";

export interface EditorHost {
  scene: Scene;
  configService: ConfigService;
  bus: EventBus<ConfigEvents>;
  pauseSim(): void;
  resumeSim(): void;
  /**
   * Rebuild the scene's static arena. Pass the arena being EDITED — the host
   * otherwise falls back to the last-played arena, which is wrong the moment
   * the Map tool's arena dropdown moves off it (floor/skybox would stay stale).
   * `onlyIfStale` skips the (expensive) rebuild when that arena is already
   * staged — for opening the Map tab, not for committing edits.
   */
  rebuildArena(arenaId?: string, onlyIfStale?: boolean): void;
  /**
   * Hide/show the live match entirely — HUD, entity views, order markers — and
   * gate gameplay tap orders. The editor owns the canvas while it is open.
   */
  setGameVisible(visible: boolean): void;
  /** Hide/show the static arena (bounds, skybox, ground AND its light rig). */
  setArenaVisible(visible: boolean): void;
  /**
   * Force the team spawn gizmos on while the editor owns the canvas, and release
   * the override on close. Every shipped quality tier turns them OFF (they are an
   * authoring aid, not match furniture), but the Map editor and arena Inspector
   * place spawns against this scene and designers must see them.
   */
  setSpawnMarkersForced(forced: boolean): void;
  /** Make arena prop instances selectable only for the editor session. */
  setPropPickingForced(forced: boolean): void;
  /** Close the editor and start an offline session on the edited arena. */
  launchPlaytest(arenaId: string, gamemodeId: string): Promise<void>;
  /** Freeze the editor camera's pointer gestures (used during gizmo drags). */
  suspendCameraGestures(suspended: boolean): void;
}

export type EditorPanelFactory = (host: EditorHost, report: (message: string | null) => void) => EditorPanel;
export interface EditorPanel {
  element: HTMLElement;
  dispose(): void;
  /**
   * Write the panel's edited config(s) to disk. Panels that edit configs expose
   * their own "Save to disk" action here too, so the shell can offer one
   * always-visible Save in the top bar regardless of which tool is open.
   */
  save?(): Promise<void>;
}

const TAB_STORAGE_KEY = "sa-editor.tab";
/**
 * Two-level navigation: a category row in the top bar, a tool row under it.
 * Fifteen flat tabs in one scrolling strip is not navigable on a phone, and the
 * grouping is the only thing that makes the tool set legible on a desktop
 * either. Order here IS the order in the category row.
 */
const GROUP_ORDER = ["World", "Ships", "Content", "Balance", "System"] as const;
/** Where a panel lands when {@link EditorShell.registerPanel} names no group. */
const DEFAULT_GROUP = "Content";
/**
 * Group of every panel the shell (or main.ts) registers by name. Keyed by name
 * rather than passed at every call site so the 2-argument `registerPanel`
 * signature stays valid for external registrations.
 */
const PANEL_GROUPS: Record<string, string> = {
  Map: "World",
  Inspector: "World",
  Ships: "Ships",
  Skins: "Ships",
  Modules: "Ships",
  Assets: "Content",
  Actions: "Content",
  Notifications: "Content",
  Modes: "Content",
  Bots: "Content",
  Balance: "Balance",
  Tuning: "Balance",
  Theme: "System",
  Quality: "System",
  Console: "System",
  Problems: "System",
};
/**
 * Which tools want the real arena behind them. Tools that stage their own
 * subject (a ship, an asset, a chart) get a clean, arena-free backdrop instead
 * — see {@link EditorStage} for the lighting/grid that replaces it.
 */
const ARENA_VISIBLE_TABS: Record<string, boolean> = {
  Map: true,
  Inspector: true,
  Tuning: true,
  Console: true,
  Problems: true,
  Actions: true,
  Notifications: true,
  Bots: true,
  Modes: true,
  Theme: true,
  Quality: true,
  Ships: false,
  Skins: false,
  Assets: false,
  Balance: false,
};
/** Mobile bottom-sheet heights, cycled by tapping the drag handle. */
const SHEET_STATES = ["half", "full", "collapsed"] as const;
type SheetState = (typeof SHEET_STATES)[number];

/** Anything `getBoundingClientRect()` returns — the only part this file reads. */
export interface RectLike { left: number; top: number; width: number; height: number }

/**
 * The screen rectangle the 3D canvas must occupy while the editor is open.
 *
 * The canvas is fullscreen behind the overlay, so a right-docked inspector used
 * to cover the right half of a subject that is centred on the WHOLE window. The
 * fix is a real split: inset the canvas to the viewport cell and `engine.resize()`.
 *
 * Desktop needs nothing beyond the spacer's own rect (the inspector is a grid
 * column, so the cell already stops at its edge). On a phone the inspector is a
 * FIXED bottom sheet drawn over the full-width viewport cell, so its top edge is
 * the real bottom of the viewport — except when collapsed, where the 36px handle
 * is not worth shrinking the scene for.
 */
export function viewportRectFor(spacer: RectLike, inspector: RectLike | null, sheetCollapsed: boolean): RectLike {
  let bottom = spacer.top + spacer.height;
  if (inspector && !sheetCollapsed && inspector.top > spacer.top) {
    // A bottom sheet spans the whole cell width; a docked column never does.
    const spansCell = inspector.left <= spacer.left + 1 && inspector.left + inspector.width >= spacer.left + spacer.width - 1;
    if (spansCell) bottom = Math.min(bottom, inspector.top);
  }
  return { left: spacer.left, top: spacer.top, width: Math.max(1, spacer.width), height: Math.max(1, bottom - spacer.top) };
}

/** Canvas inline styles the shell overwrites, so close() can put them back verbatim. */
const CANVAS_STYLE_KEYS = ["position", "left", "top", "right", "bottom", "width", "height"] as const;

/**
 * Dev editor dock (F10, and the temporary settings-screen entry). The live 3D
 * scene *is* the viewport: the shell is a full-screen grid overlay whose
 * viewport cell passes pointer events straight through to the canvas, with a
 * HUD-styled top bar and a right-hand inspector (a bottom sheet on phones).
 *
 * Two things the shell owns that a panel must not fight:
 *  - the canvas RECT. The canvas is fullscreen behind the overlay, so the shell
 *    insets it to the viewport cell and calls `engine.resize()` whenever the
 *    chrome moves (see {@link viewportRectFor}). Panels keep projecting through
 *    `canvas.getBoundingClientRect()` and stay correct.
 *  - NAVIGATION. Tools are grouped (World / Ships / Content / Balance / System)
 *    and reached through a category row plus a tool row; panels are registered
 *    rather than hard-coded so later phases extend the set without touching it.
 */
export class EditorShell {
  private readonly panels = new Map<string, { factory: EditorPanelFactory; group: string }>();
  private readonly problems: string[] = [];
  private root: HTMLDivElement | null = null;
  private active: EditorPanel | null = null;
  private unsubscribe: (() => void) | null = null;

  private groupsBar: HTMLDivElement | null = null;
  private tabsBar: HTMLDivElement | null = null;
  private body: HTMLDivElement | null = null;
  private title: HTMLSpanElement | null = null;
  private crumb: HTMLSpanElement | null = null;
  private statusButton: HTMLButtonElement | null = null;
  private statusCount: HTMLSpanElement | null = null;
  private saveButton: HTMLButtonElement | null = null;
  private dirtyBadge: HTMLSpanElement | null = null;
  /**
   * Configs edited (via `config:changed`) but not yet written to disk, keyed
   * `type:id`. Survives shell close/reopen — the edits live in the in-memory
   * ConfigService either way, and are only truly lost on page unload, which is
   * what the beforeunload guard below covers.
   */
  private readonly dirtyConfigs = new Set<string>();
  private readonly onBeforeUnload = (event: BeforeUnloadEvent): void => {
    if (this.dirtyConfigs.size === 0) return;
    event.preventDefault();
    // Chrome requires returnValue for the prompt to show.
    event.returnValue = "";
  };
  private renderProblems: (() => void) | null = null;
  private sheet: SheetState = "half";
  private stage: EditorStage | null = null;
  private group: string = GROUP_ORDER[0];

  private viewport: HTMLDivElement | null = null;
  private inspector: HTMLElement | null = null;
  private chromeObserver: ResizeObserver | null = null;
  private readonly onWindowResize = (): void => this.applyViewportRect();
  /** Canvas inline styles as they were before the editor inset them. */
  private canvasStyles: Partial<Record<(typeof CANVAS_STYLE_KEYS)[number], string>> | null = null;

  constructor(private readonly host: EditorHost) {
    // Dirty tracking outlives open/close: edits sit in the ConfigService until
    // saved, so the unload guard must too. The shell instance is a singleton
    // held by main.ts, so neither listener needs a teardown path.
    this.host.bus.on("config:changed", ({ id, type }) => { this.dirtyConfigs.add(`${type}:${id}`); this.updateStatus(); });
    onConfigSaved((config) => { this.dirtyConfigs.delete(`${config.type}:${config.id}`); this.updateStatus(); });
    window.addEventListener("beforeunload", this.onBeforeUnload);
    this.registerPanel("Map", (h, report) => new MapEditor(h, report));
    this.registerPanel("Inspector", (host, report) => arenaInspector(host, report));
    this.registerPanel("Tuning", (h, report) => new TuningPanel(h, report));
    this.registerPanel("Ships", (h, report) => new ShipManager(h, report));
    this.registerPanel("Skins", (h, report) => new SkinEditor(h, report));
    this.registerPanel("Balance", (h, report) => new BalanceWorkbench(h, report));
    this.registerPanel("Assets", (h, report) => new AssetEditor(h, report));
    this.registerPanel("Actions", (h, report) => new ActionEditor(h, report));
    this.registerPanel("Notifications", (h, report) => new NotificationEditor(h, report));
    this.registerPanel("Bots", (h, report) => new BotProfileEditor(h, report));
    this.registerPanel("Modes", (h, report) => new GamemodeEditor(h, report));
    this.registerPanel("Theme", (h, report) => new ThemeEditor(h, report));
    this.registerPanel("Quality", (h, report) => new QualityEditor(h, report));
    this.registerPanel("Console", (h, report) => new ConsolePanel(h, report));
    this.registerPanel("Problems", () => this.problemsPanel());
  }

  /**
   * Register (or replace) a tool. `group` is optional so the 2-argument calls
   * from main.ts keep working — a name without a hint lands in {@link PANEL_GROUPS}
   * or, failing that, in {@link DEFAULT_GROUP}.
   */
  registerPanel(name: string, factory: EditorPanelFactory, group?: string): void {
    this.panels.set(name, { factory, group: group ?? PANEL_GROUPS[name] ?? DEFAULT_GROUP });
  }
  toggle(): void { if (this.root) this.close(); else this.open(); }

  /** Groups in declared order, then any group a late registration invented. */
  private groupNames(): string[] {
    const used = new Set<string>();
    for (const entry of this.panels.values()) used.add(entry.group);
    const ordered: string[] = GROUP_ORDER.filter((name) => used.has(name));
    return [...ordered, ...[...used].filter((name) => !ordered.includes(name))];
  }

  private panelsIn(group: string): string[] {
    return [...this.panels].filter(([, entry]) => entry.group === group).map(([name]) => name);
  }

  private open(): void {
    this.host.pauseSim();
    // The live match must be completely invisible behind the editor: each tool
    // stages its own 3D content on this canvas.
    this.host.setGameVisible(false);
    // Spawn points are invisible in a shipped match; a designer editing the map
    // needs them back. Held for the whole editor session rather than per tab, so
    // switching Map → Inspector → Map never costs an extra arena rebuild.
    this.host.setSpawnMarkersForced(true);
    this.host.setPropPickingForced(true);
    this.stage = new EditorStage(this.host.scene);
    this.validateAll();

    const root = document.createElement("div");
    root.id = "space-arena-editor";
    root.className = "sa-editor";
    root.dataset.sheet = this.sheet;
    this.root = root;

    const topbar = this.buildTopBar();
    root.append(topbar, this.buildToolRow(), this.buildViewportSpacer(), this.buildInspector());
    document.body.append(root);

    // The canvas is fullscreen behind this overlay; inset it to the viewport
    // cell so the subject is centred in what the designer can actually see.
    this.captureCanvasStyles();
    this.applyViewportRect();
    if (typeof ResizeObserver !== "undefined") {
      // The inspector carries a CSS resize handle and the top bar can wrap, so
      // both re-drive the inset; the root covers window/orientation changes.
      this.chromeObserver = new ResizeObserver(() => this.applyViewportRect());
      for (const el of [root, topbar, this.inspector]) if (el) this.chromeObserver.observe(el);
    }
    window.addEventListener("resize", this.onWindowResize);

    this.unsubscribe = this.host.bus.on("config:changed", () => { this.validateAll(); this.renderProblems?.(); });
    this.updateStatus();
    this.show(this.restoreTab());
  }

  private buildTopBar(): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "ed-topbar";

    const brand = document.createElement("div");
    brand.className = "ed-brand";
    brand.textContent = "Constellation";

    const groups = document.createElement("div");
    groups.className = "ed-groups";
    groups.setAttribute("role", "tablist");
    groups.setAttribute("aria-label", "Tool categories");
    for (const name of this.groupNames()) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ed-nav-group";
      button.dataset.group = name;
      button.textContent = name;
      // Picking a category shows its first tool — a category is never a
      // dead end that leaves the tool row pointing somewhere else.
      button.addEventListener("click", () => {
        const first = this.panelsIn(name)[0];
        if (first) this.show(first);
      });
      groups.append(button);
    }
    this.groupsBar = groups;

    const right = document.createElement("div");
    right.className = "ed-topbar-right";

    const status = document.createElement("button");
    status.type = "button";
    status.className = "ed-status";
    status.title = "Validation status — click to open Problems";
    const dot = document.createElement("span");
    dot.className = "ed-status-dot";
    const count = document.createElement("span");
    count.className = "ed-status-count";
    status.append(dot, count);
    status.addEventListener("click", () => this.show("Problems"));
    this.statusButton = status;
    this.statusCount = count;

    // One always-visible Save regardless of which tool is open: it forwards to
    // the active panel's own save. Edits live only in the in-memory
    // ConfigService until saved, so this must never be buried inside a panel.
    const save = document.createElement("button");
    save.type = "button";
    save.className = "ed-btn ed-btn--primary";
    save.textContent = "Save to disk";
    save.addEventListener("click", () => void this.saveActive());
    this.saveButton = save;

    const dirty = document.createElement("span");
    dirty.className = "ed-dirty";
    dirty.title = "Configs edited since their last save to disk";
    this.dirtyBadge = dirty;

    const close = document.createElement("button");
    close.type = "button";
    close.className = "ed-btn ed-btn--danger";
    // Labelled for the phone, where there is no F10 to name.
    close.textContent = "Exit";
    close.title = "Close the designer (F10)";
    close.addEventListener("click", () => this.close());

    right.append(dirty, save, status, close);
    bar.append(brand, groups, right);
    return bar;
  }

  /** Second nav level: the tools of the active category. Rebuilt on group change. */
  private buildToolRow(): HTMLElement {
    const tabs = document.createElement("div");
    tabs.className = "ed-tabs ed-toolrow";
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "Tools");
    this.tabsBar = tabs;
    return tabs;
  }

  private renderToolRow(active: string): void {
    const tabs = this.tabsBar;
    if (!tabs) return;
    tabs.replaceChildren(...this.panelsIn(this.group).map((name) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ed-tab";
      button.dataset.tab = name;
      button.textContent = name;
      button.setAttribute("role", "tab");
      button.classList.toggle("is-active", name === active);
      button.setAttribute("aria-selected", String(name === active));
      button.addEventListener("click", () => this.show(name));
      return button;
    }));
  }

  /** Transparent column over the live scene — must not eat pointer events. */
  private buildViewportSpacer(): HTMLElement {
    const spacer = document.createElement("div");
    spacer.className = "ed-viewport";
    this.viewport = spacer;
    return spacer;
  }

  private buildInspector(): HTMLElement {
    const inspector = document.createElement("aside");
    inspector.className = "ed-inspector ed-frame";

    const handle = document.createElement("button");
    handle.type = "button";
    handle.className = "ed-sheet-handle";
    const grip = document.createElement("span");
    grip.className = "ed-sheet-grip";
    const handleLabel = document.createElement("span");
    handleLabel.className = "ed-sheet-label";
    handleLabel.textContent = "Drag / tap";
    handle.append(grip, handleLabel);
    handle.addEventListener("click", () => this.cycleSheet());

    const head = document.createElement("div");
    head.className = "ed-inspector-head";
    const crumb = document.createElement("span");
    crumb.className = "ed-inspector-crumb";
    const title = document.createElement("span");
    title.className = "ed-inspector-title";
    head.append(crumb, title);
    this.crumb = crumb;
    this.title = title;

    const body = document.createElement("div");
    body.className = "ed-inspector-body";
    this.body = body;

    inspector.append(handle, head, body);
    this.inspector = inspector;
    return inspector;
  }

  private cycleSheet(): void {
    const next = SHEET_STATES[(SHEET_STATES.indexOf(this.sheet) + 1) % SHEET_STATES.length]!;
    this.sheet = next;
    if (this.root) this.root.dataset.sheet = next;
    // The sheet height IS the viewport's bottom edge on a phone.
    this.applyViewportRect();
  }

  /** Snapshot the canvas's own inline layout so close() restores it exactly. */
  private captureCanvasStyles(): void {
    const canvas = this.renderCanvas();
    if (!canvas || this.canvasStyles) return;
    const saved: Partial<Record<(typeof CANVAS_STYLE_KEYS)[number], string>> = {};
    for (const key of CANVAS_STYLE_KEYS) saved[key] = canvas.style[key];
    this.canvasStyles = saved;
  }

  private renderCanvas(): HTMLCanvasElement | null {
    // Host-agnostic on purpose: the engine already owns the canvas, so the
    // EditorHost interface does not have to grow a viewport method for this.
    return this.host.scene.getEngine().getRenderingCanvas();
  }

  /** Size the 3D canvas to the viewport cell (see {@link viewportRectFor}). */
  private applyViewportRect(): void {
    const canvas = this.renderCanvas();
    const spacer = this.viewport;
    if (!canvas || !spacer || !this.root) return;
    const rect = viewportRectFor(
      spacer.getBoundingClientRect(),
      this.inspector?.getBoundingClientRect() ?? null,
      this.sheet === "collapsed",
    );
    canvas.style.position = "fixed";
    canvas.style.left = `${Math.round(rect.left)}px`;
    canvas.style.top = `${Math.round(rect.top)}px`;
    canvas.style.right = "auto";
    canvas.style.bottom = "auto";
    canvas.style.width = `${Math.round(rect.width)}px`;
    canvas.style.height = `${Math.round(rect.height)}px`;
    this.host.scene.getEngine().resize();
  }

  private restoreCanvasRect(): void {
    const canvas = this.renderCanvas();
    const saved = this.canvasStyles;
    this.canvasStyles = null;
    if (!canvas || !saved) return;
    for (const key of CANVAS_STYLE_KEYS) canvas.style[key] = saved[key] ?? "";
    this.host.scene.getEngine().resize();
  }

  private restoreTab(): string {
    let stored: string | null = null;
    try { stored = localStorage.getItem(TAB_STORAGE_KEY); } catch { stored = null; }
    return stored && this.panels.has(stored) ? stored : "Map";
  }

  private show(name: string): void {
    const body = this.body;
    if (!this.root || !body) return;
    const entry = this.panels.get(name);
    if (!entry) return;

    this.active?.dispose(); this.active = null;
    this.renderProblems = null;
    body.replaceChildren();

    try { localStorage.setItem(TAB_STORAGE_KEY, name); } catch { /* private mode — ignore */ }
    this.group = entry.group;
    if (this.title) this.title.textContent = name;
    if (this.crumb) this.crumb.textContent = entry.group;
    for (const button of this.groupsBar?.querySelectorAll<HTMLElement>(".ed-nav-group") ?? []) {
      button.classList.toggle("is-active", button.dataset.group === entry.group);
      button.setAttribute("aria-selected", String(button.dataset.group === entry.group));
    }
    this.renderToolRow(name);
    // Arena visible for world-space tools; clean lit stage for the rest.
    const arenaVisible = ARENA_VISIBLE_TABS[name] ?? true;
    this.host.setArenaVisible(arenaVisible);
    this.stage?.setEnabled(!arenaVisible);

    // Opening a tool on a phone should reveal the sheet if it was collapsed.
    if (this.sheet === "collapsed") { this.sheet = "half"; this.root.dataset.sheet = "half"; }

    this.active = entry.factory(this.host, (message) => {
      if (message) { this.problems.push(message); this.updateStatus(); }
    });
    this.active.element.classList.add("editor-panel", "ed-panel-root");
    body.append(this.active.element);
    // The top-bar Save follows the active tool (enabled only when it can save).
    this.updateStatus();
  }

  private problemsPanel(): EditorPanel {
    const element = document.createElement("div");
    element.className = "ed-problems";
    const render = (): void => {
      if (!this.problems.length) {
        const empty = document.createElement("div");
        empty.className = "ed-empty";
        empty.textContent = "No current validation problems.";
        element.replaceChildren(empty);
        return;
      }
      element.replaceChildren(...this.problems.map((p) => {
        const row = document.createElement("p");
        row.className = "ed-problem";
        row.textContent = p;
        return row;
      }));
    };
    render();
    this.renderProblems = render;
    return { element, dispose: () => { this.renderProblems = null; } };
  }

  private validateAll(): void {
    this.problems.length = 0;
    for (const [type, schema] of Object.entries(CONFIG_SCHEMAS)) {
      for (const config of this.host.configService.getAll(type as keyof typeof CONFIG_SCHEMAS)) {
        const result = schema.safeParse(config);
        if (!result.success) for (const issue of result.error.issues) this.problems.push(`${config.id} ${issue.path.join(".")}: ${issue.message}`);
      }
    }
    this.updateStatus();
  }

  private updateStatus(): void {
    const count = this.problems.length;
    this.statusButton?.classList.toggle("is-bad", count > 0);
    if (this.statusCount) this.statusCount.textContent = count > 0 ? String(count) : "OK";
    if (this.statusButton) this.statusButton.title = count > 0 ? `${count} validation problem(s) — click to open Problems` : "No validation problems";
    const dirty = this.dirtyConfigs.size;
    if (this.dirtyBadge) {
      this.dirtyBadge.textContent = dirty > 0 ? `${dirty} unsaved` : "";
      this.dirtyBadge.classList.toggle("is-dirty", dirty > 0);
    }
    if (this.saveButton) {
      const savable = typeof this.active?.save === "function";
      this.saveButton.disabled = !savable;
      this.saveButton.title = savable
        ? "Write this tool's edited config(s) to content/ on disk"
        : "This tool has no file of its own to save — use a tool's Save for its configs";
    }
  }

  /** The top-bar Save: forward to the active panel's own save-to-disk. */
  private async saveActive(): Promise<void> {
    if (!this.active?.save) return;
    await this.active.save();
    this.updateStatus();
  }

  close(): void {
    this.active?.dispose(); this.active = null; this.unsubscribe?.(); this.unsubscribe = null;
    this.renderProblems = null;
    this.chromeObserver?.disconnect(); this.chromeObserver = null;
    window.removeEventListener("resize", this.onWindowResize);
    // Hand the canvas back fullscreen BEFORE the game returns: the HUD projects
    // against the canvas rect, and the match must not inherit the editor split.
    this.restoreCanvasRect();
    this.viewport = null; this.inspector = null;
    this.groupsBar = null; this.crumb = null;
    this.tabsBar = null; this.body = null; this.title = null; this.statusButton = null; this.statusCount = null;
    this.saveButton = null; this.dirtyBadge = null;
    this.stage?.dispose(); this.stage = null;
    this.host.suspendCameraGestures(false);
    this.host.setSpawnMarkersForced(false);
    this.host.setPropPickingForced(false);
    this.host.setArenaVisible(true);
    this.host.setGameVisible(true);
    this.root?.remove(); this.root = null; this.host.resumeSim();
  }
}
function placeholder(message: string): EditorPanel { return { element: text(message), dispose() {} }; }
function text(message: string): HTMLDivElement { const element = document.createElement("div"); element.textContent = message; element.className = "ed-empty"; return element; }
/**
 * World ▸ Inspector: the raw generated form over ONE arena, for reading and
 * editing fields the Map tool's viewport does not draw handles for.
 *
 * It deliberately has no arena picker — Map owns choosing the arena, and two
 * pickers disagreeing about "the arena" is how a designer ends up editing the
 * one they are not looking at. It does now SAY which arena it is showing, and
 * exposes save() so the shell's always-visible Save writes this arena's file
 * instead of sitting disabled on a panel that plainly edits a config.
 */
function arenaInspector(host: EditorHost, report: (message: string | null) => void): EditorPanel {
  const arena = host.configService.getAll<ArenaConfig>("arena")[0];
  if (!arena) return placeholder("No arena config loaded.");
  const form = new SchemaFormGen({ schema: arenaSchema, value: arena, configService: host.configService, onProblem: (p) => report(p ? `${arena.id} ${p.path}: ${p.message}` : null), onSaved: () => host.rebuildArena(arena.id) });
  const element = document.createElement("div");
  const subject = document.createElement("div");
  subject.className = "ed-note";
  subject.textContent = `Showing ${arena.name ?? arena.id} (${arena.id}). Switch arenas in World ▸ Map.`;
  element.append(subject, applicationNotice("arena"), form.element);
  return {
    element,
    async save() {
      report(await saveConfig(form.getValue()));
    },
    dispose() {},
  };
}

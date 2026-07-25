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
import { BalanceWorkbench } from "./BalanceWorkbench.js";
import { BotProfileEditor } from "./BotProfileEditor.js";
import { GamemodeEditor } from "./GamemodeEditor.js";
import { ThemeEditor } from "./ThemeEditor.js";
import { ConsolePanel } from "./ConsolePanel.js";
import { EditorStage } from "./EditorStage.js";
import "./editor.css";

export interface EditorHost {
  scene: Scene;
  configService: ConfigService;
  bus: EventBus<ConfigEvents>;
  pauseSim(): void;
  resumeSim(): void;
  rebuildArena(): void;
  /**
   * Hide/show the live match entirely — HUD, entity views, order markers — and
   * gate gameplay tap orders. The editor owns the canvas while it is open.
   */
  setGameVisible(visible: boolean): void;
  /** Hide/show the static arena (bounds, skybox, ground AND its light rig). */
  setArenaVisible(visible: boolean): void;
  /** Freeze the editor camera's pointer gestures (used during gizmo drags). */
  suspendCameraGestures(suspended: boolean): void;
}

export type EditorPanelFactory = (host: EditorHost, report: (message: string | null) => void) => EditorPanel;
export interface EditorPanel { element: HTMLElement; dispose(): void; }

const TAB_STORAGE_KEY = "sa-editor.tab";
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
  Ships: false,
  Assets: false,
  Balance: false,
};
/** Mobile bottom-sheet heights, cycled by tapping the drag handle. */
const SHEET_STATES = ["half", "full", "collapsed"] as const;
type SheetState = (typeof SHEET_STATES)[number];

/**
 * Dev editor dock (F10). The live 3D scene *is* the viewport: the shell is a
 * transparent full-screen grid overlay whose left column passes pointer events
 * straight through to the canvas, with a HUD-styled top bar and a right-hand
 * inspector (a bottom sheet on phones).
 *
 * Panels are registered rather than hard-coded so later phases can extend the
 * tool set without touching the shell.
 */
export class EditorShell {
  private readonly panels = new Map<string, EditorPanelFactory>();
  private readonly problems: string[] = [];
  private root: HTMLDivElement | null = null;
  private active: EditorPanel | null = null;
  private unsubscribe: (() => void) | null = null;

  private tabsBar: HTMLDivElement | null = null;
  private body: HTMLDivElement | null = null;
  private title: HTMLSpanElement | null = null;
  private statusButton: HTMLButtonElement | null = null;
  private statusCount: HTMLSpanElement | null = null;
  private renderProblems: (() => void) | null = null;
  private sheet: SheetState = "half";
  private stage: EditorStage | null = null;

  constructor(private readonly host: EditorHost) {
    this.registerPanel("Map", (h, report) => new MapEditor(h, report));
    this.registerPanel("Inspector", (host, report) => arenaInspector(host, report));
    this.registerPanel("Tuning", (h, report) => new TuningPanel(h, report));
    this.registerPanel("Ships", (h, report) => new ShipManager(h, report));
    this.registerPanel("Balance", (h, report) => new BalanceWorkbench(h, report));
    this.registerPanel("Assets", (h, report) => new AssetEditor(h, report));
    this.registerPanel("Actions", (h, report) => new ActionEditor(h, report));
    this.registerPanel("Notifications", (h, report) => new NotificationEditor(h, report));
    this.registerPanel("Bots", (h, report) => new BotProfileEditor(h, report));
    this.registerPanel("Modes", (h, report) => new GamemodeEditor(h, report));
    this.registerPanel("Theme", (h, report) => new ThemeEditor(h, report));
    this.registerPanel("Console", (h, report) => new ConsolePanel(h, report));
    this.registerPanel("Problems", () => this.problemsPanel());
  }

  registerPanel(name: string, factory: EditorPanelFactory): void { this.panels.set(name, factory); }
  toggle(): void { if (this.root) this.close(); else this.open(); }

  private open(): void {
    this.host.pauseSim();
    // The live match must be completely invisible behind the editor: each tool
    // stages its own 3D content on this canvas.
    this.host.setGameVisible(false);
    this.stage = new EditorStage(this.host.scene);
    this.validateAll();

    const root = document.createElement("div");
    root.id = "space-arena-editor";
    root.className = "sa-editor";
    root.dataset.sheet = this.sheet;
    this.root = root;

    root.append(this.buildTopBar(), this.buildViewportSpacer(), this.buildInspector());
    document.body.append(root);

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

    const tabs = document.createElement("div");
    tabs.className = "ed-tabs";
    tabs.setAttribute("role", "tablist");
    for (const name of this.panels.keys()) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ed-tab";
      button.dataset.tab = name;
      button.textContent = name;
      button.addEventListener("click", () => this.show(name));
      tabs.append(button);
    }
    this.tabsBar = tabs;

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

    const close = document.createElement("button");
    close.type = "button";
    close.className = "ed-btn ed-btn--danger";
    close.textContent = "Exit (F10)";
    close.addEventListener("click", () => this.close());

    right.append(status, close);
    bar.append(brand, tabs, right);
    return bar;
  }

  /** Transparent column over the live scene — must not eat pointer events. */
  private buildViewportSpacer(): HTMLElement {
    const spacer = document.createElement("div");
    spacer.className = "ed-viewport";
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
    const title = document.createElement("span");
    title.className = "ed-inspector-title";
    head.append(title);
    this.title = title;

    const body = document.createElement("div");
    body.className = "ed-inspector-body";
    this.body = body;

    inspector.append(handle, head, body);
    return inspector;
  }

  private cycleSheet(): void {
    const next = SHEET_STATES[(SHEET_STATES.indexOf(this.sheet) + 1) % SHEET_STATES.length]!;
    this.sheet = next;
    if (this.root) this.root.dataset.sheet = next;
  }

  private restoreTab(): string {
    let stored: string | null = null;
    try { stored = localStorage.getItem(TAB_STORAGE_KEY); } catch { stored = null; }
    return stored && this.panels.has(stored) ? stored : "Map";
  }

  private show(name: string): void {
    const body = this.body;
    if (!this.root || !body) return;
    const factory = this.panels.get(name);
    if (!factory) return;

    this.active?.dispose(); this.active = null;
    this.renderProblems = null;
    body.replaceChildren();

    try { localStorage.setItem(TAB_STORAGE_KEY, name); } catch { /* private mode — ignore */ }
    if (this.title) this.title.textContent = name;
    for (const tab of this.tabsBar?.querySelectorAll<HTMLElement>(".ed-tab") ?? []) {
      tab.classList.toggle("is-active", tab.dataset.tab === name);
      tab.setAttribute("aria-selected", String(tab.dataset.tab === name));
    }
    // Arena visible for world-space tools; clean lit stage for the rest.
    const arenaVisible = ARENA_VISIBLE_TABS[name] ?? true;
    this.host.setArenaVisible(arenaVisible);
    this.stage?.setEnabled(!arenaVisible);

    // Opening a tool on a phone should reveal the sheet if it was collapsed.
    if (this.sheet === "collapsed") { this.sheet = "half"; this.root.dataset.sheet = "half"; }

    this.active = factory(this.host, (message) => {
      if (message) { this.problems.push(message); this.updateStatus(); }
    });
    this.active.element.classList.add("editor-panel", "ed-panel-root");
    body.append(this.active.element);
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
  }

  private close(): void {
    this.active?.dispose(); this.active = null; this.unsubscribe?.(); this.unsubscribe = null;
    this.renderProblems = null;
    this.tabsBar = null; this.body = null; this.title = null; this.statusButton = null; this.statusCount = null;
    this.stage?.dispose(); this.stage = null;
    this.host.suspendCameraGestures(false);
    this.host.setArenaVisible(true);
    this.host.setGameVisible(true);
    this.root?.remove(); this.root = null; this.host.resumeSim();
  }
}
function placeholder(message: string): EditorPanel { return { element: text(message), dispose() {} }; }
function text(message: string): HTMLDivElement { const element = document.createElement("div"); element.textContent = message; element.className = "ed-empty"; return element; }
function arenaInspector(host: EditorHost, report: (message: string | null) => void): EditorPanel {
  const arena = host.configService.getAll<ArenaConfig>("arena")[0];
  if (!arena) return placeholder("No arena config loaded.");
  const form = new SchemaFormGen({ schema: arenaSchema, value: arena, configService: host.configService, onProblem: (p) => report(p ? `${arena.id} ${p.path}: ${p.message}` : null), onSaved: () => host.rebuildArena() });
  return { element: form.element, dispose() {} };
}

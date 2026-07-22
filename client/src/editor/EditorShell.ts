import type { Scene } from "@babylonjs/core";
import { CONFIG_SCHEMAS, type ConfigEvents, type ConfigService, type EventBus } from "@space-arena/shared";
import { MapEditor } from "./MapEditor.js";
import { SchemaFormGen } from "./SchemaFormGen.js";
import { arenaSchema, type ArenaConfig } from "@space-arena/shared";
import { TuningPanel } from "./TuningPanel.js";
import { AssetEditor } from "./AssetEditor.js";
import { ActionEditor } from "./ActionEditor.js";
import { NotificationEditor } from "./NotificationEditor.js";

export interface EditorHost {
  scene: Scene;
  configService: ConfigService;
  bus: EventBus<ConfigEvents>;
  pauseSim(): void;
  resumeSim(): void;
  rebuildArena(): void;
}

export type EditorPanelFactory = (host: EditorHost, report: (message: string | null) => void) => EditorPanel;
export interface EditorPanel { element: HTMLElement; dispose(): void; }

/** Dev editor dock. Panels are registered rather than hard-coded for Phase 1B. */
export class EditorShell {
  private readonly panels = new Map<string, EditorPanelFactory>();
  private readonly problems: string[] = [];
  private root: HTMLDivElement | null = null;
  private active: EditorPanel | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly host: EditorHost) {
    this.registerPanel("Map", (h, report) => new MapEditor(h, report));
    this.registerPanel("Inspector", (host, report) => arenaInspector(host, report));
    this.registerPanel("Tuning", (h, report) => new TuningPanel(h, report));
    this.registerPanel("Assets", (h, report) => new AssetEditor(h, report));
    this.registerPanel("Actions", (h, report) => new ActionEditor(h, report));
    this.registerPanel("Notifications", (h, report) => new NotificationEditor(h, report));
    this.registerPanel("Problems", () => this.problemsPanel());
  }

  registerPanel(name: string, factory: EditorPanelFactory): void { this.panels.set(name, factory); }
  toggle(): void { if (this.root) this.close(); else this.open(); }

  private open(): void {
    this.host.pauseSim();
    this.validateAll();
    this.root = document.createElement("div");
    this.root.id = "space-arena-editor";
    Object.assign(this.root.style, { position: "fixed", right: "0", top: "0", bottom: "0", width: "390px", minWidth: "280px", maxWidth: "70vw", resize: "horizontal", overflow: "auto", zIndex: "1000", background: "#101726ee", color: "#e8f1ff", font: "13px system-ui", padding: "10px", borderLeft: "1px solid #4d6b90" });
    const tabs = document.createElement("div");
    for (const name of this.panels.keys()) {
      const button = document.createElement("button"); button.textContent = name;
      button.addEventListener("click", () => this.show(name)); tabs.append(button);
    }
    const close = document.createElement("button"); close.textContent = "Exit editor (F10)"; close.addEventListener("click", () => this.close()); tabs.append(close);
    this.root.append(tabs);
    document.body.append(this.root);
    this.unsubscribe = this.host.bus.on("config:changed", () => this.validateAll());
    this.show("Map");
  }
  private show(name: string): void {
    if (!this.root) return;
    this.active?.dispose(); this.active = null;
    this.root.querySelector(".editor-panel")?.remove();
    const factory = this.panels.get(name); if (!factory) return;
    this.active = factory(this.host, (message) => { if (message) this.problems.push(message); });
    this.active.element.classList.add("editor-panel"); this.root.append(this.active.element);
  }
  private problemsPanel(): EditorPanel {
    const element = document.createElement("div");
    const render = () => { element.replaceChildren(...(this.problems.length ? this.problems.map((p) => { const row = document.createElement("p"); row.textContent = p; return row; }) : [text("No current validation problems.")])); };
    render(); return { element, dispose() {} };
  }
  private validateAll(): void {
    this.problems.length = 0;
    for (const [type, schema] of Object.entries(CONFIG_SCHEMAS)) {
      for (const config of this.host.configService.getAll(type as keyof typeof CONFIG_SCHEMAS)) {
        const result = schema.safeParse(config);
        if (!result.success) for (const issue of result.error.issues) this.problems.push(`${config.id} ${issue.path.join(".")}: ${issue.message}`);
      }
    }
  }
  private close(): void {
    this.active?.dispose(); this.active = null; this.unsubscribe?.(); this.unsubscribe = null;
    this.root?.remove(); this.root = null; this.host.resumeSim();
  }
}
function placeholder(message: string): EditorPanel { return { element: text(message), dispose() {} }; }
function text(message: string): HTMLDivElement { const element = document.createElement("div"); element.textContent = message; return element; }
function arenaInspector(host: EditorHost, report: (message: string | null) => void): EditorPanel {
  const arena = host.configService.getAll<ArenaConfig>("arena")[0];
  if (!arena) return placeholder("No arena config loaded.");
  const form = new SchemaFormGen({ schema: arenaSchema, value: arena, configService: host.configService, onProblem: (p) => report(p ? `${arena.id} ${p.path}: ${p.message}` : null), onSaved: () => host.rebuildArena() });
  return { element: form.element, dispose() {} };
}

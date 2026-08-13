import type { ConfigService, Snapshot, ThemeConfig } from "@space-arena/shared";

const DEFAULT_FLAVOR = "Scanning nearby sectors...";

/** Room-lobby status driven only by replicated server state. */
export class LobbyWaitingOverlay {
  private readonly root: HTMLDivElement;
  private readonly title: HTMLDivElement;
  private readonly flavor: HTMLDivElement;
  private readonly lines: readonly string[];
  private lastText = "";

  constructor(parent: HTMLElement, configs: ConfigService) {
    this.root = document.createElement("div");
    this.root.className = "hud-lobby-waiting";
    this.root.setAttribute("role", "status");
    this.root.setAttribute("aria-live", "polite");
    const panel = document.createElement("div");
    panel.className = "hud-lobby-waiting-panel hud-frame";
    this.title = document.createElement("div");
    this.title.className = "hud-lobby-waiting-title";
    this.flavor = document.createElement("div");
    this.flavor.className = "hud-lobby-waiting-flavor";
    panel.append(this.title, this.flavor);
    this.root.append(panel);
    parent.append(this.root);
    this.lines = configs.get<ThemeConfig>("theme", "theme.default")?.menu?.matchmaking?.flavorLines ?? [DEFAULT_FLAVOR];
  }

  update(snapshot: Snapshot): void {
    const waiting = snapshot.phase === "waiting";
    this.root.classList.toggle("visible", waiting);
    if (!waiting) return;
    const seconds = Math.max(0, Math.ceil(snapshot.lobbyRemainingSec ?? 0));
    const text = `Looking for players… ${seconds}s`;
    if (text === this.lastText) return;
    this.lastText = text;
    this.title.textContent = text;
    this.flavor.textContent = this.lines[seconds % this.lines.length] ?? DEFAULT_FLAVOR;
  }

  dispose(): void {
    this.root.remove();
  }
}

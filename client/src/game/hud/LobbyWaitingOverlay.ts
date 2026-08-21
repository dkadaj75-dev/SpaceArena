import type { ConfigService, Snapshot, ThemeConfig } from "@space-arena/shared";

const DEFAULT_FLAVOR = "Scanning nearby sectors...";

/**
 * Flavor cadence used when a pack authors no
 * `theme.menu.matchmaking.flavorRotationMs`. One line per second is what this
 * overlay did unconditionally before the authored value was honoured, so an
 * un-authored pack keeps exactly its old rhythm.
 */
const DEFAULT_FLAVOR_ROTATION_MS = 1000;

/** Room-lobby status driven only by replicated server state. */
export class LobbyWaitingOverlay {
  private readonly root: HTMLDivElement;
  private readonly title: HTMLDivElement;
  private readonly flavor: HTMLDivElement;
  private readonly lines: readonly string[];
  /**
   * How long one flavor line holds, from
   * `theme.menu.matchmaking.flavorRotationMs`. The line used to be keyed
   * straight off the countdown second, so the authored value (4000 in the
   * shipped theme) did nothing at all and the copy flickered once a second.
   */
  private readonly rotationMs: number;
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
    const matchmaking = configs.get<ThemeConfig>("theme", "theme.default")?.menu?.matchmaking;
    this.lines = matchmaking?.flavorLines ?? [DEFAULT_FLAVOR];
    this.rotationMs = matchmaking?.flavorRotationMs ?? DEFAULT_FLAVOR_ROTATION_MS;
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
    // The countdown is the only clock this overlay has (it is driven by
    // replicated snapshots, not a timer of its own), so the rotation is a
    // division of it rather than an interval — which also keeps the line
    // stable across the several snapshots that land within one second.
    const step = Math.floor((seconds * 1000) / this.rotationMs);
    this.flavor.textContent = this.lines[step % this.lines.length] ?? DEFAULT_FLAVOR;
  }

  dispose(): void {
    this.root.remove();
  }
}

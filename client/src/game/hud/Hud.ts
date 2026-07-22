import type {
  ConfigService,
  EntityId,
  EventBus,
  ConfigEvents,
  Snapshot,
  SimEvent,
  ThemeConfig,
} from "@space-arena/shared";
import { createLogger } from "@space-arena/shared";
import type { GameSession } from "../GameSession.js";
import { ModuleButtons } from "./ModuleButtons.js";
import { Gauges } from "./Gauges.js";
import { Minimap } from "./Minimap.js";
import { NotificationCenter } from "./Notifications.js";
import { DamageFeedback } from "./DamageFeedback.js";
import { MatchStatus } from "./MatchStatus.js";
import { ResultsOverlay } from "./ResultsOverlay.js";
import { injectHudStyle } from "./hudStyle.js";

const log = createLogger("Hud");

const THEME_ID = "theme.default";

/**
 * Orchestrates the HTML/CSS HUD overlay (§2.3 / §6 tasks 1.8-1.9). Mounted into
 * the `#hud` root (pointer-events:none; interactive children opt back in via
 * CSS). Sub-components own their own DOM and only touch it on change — no
 * per-frame allocation or unconditional `textContent`/style writes.
 */
export class Hud {
  private readonly moduleButtons: ModuleButtons;
  private readonly gauges: Gauges;
  private readonly minimap: Minimap;
  private readonly notifications: NotificationCenter;
  private readonly damageFx: DamageFeedback;
  private readonly matchStatus: MatchStatus;
  private readonly resultsOverlay: ResultsOverlay;
  private readonly fpsEl: HTMLDivElement;
  private readonly unsubscribeTheme: () => void;

  private lastFpsText = "";

  constructor(
    private readonly root: HTMLElement,
    private readonly configs: ConfigService,
    private readonly bus: EventBus<ConfigEvents>,
    private readonly session: GameSession,
    private readonly playerId: EntityId,
    onPlayAgain: () => void,
  ) {
    injectHudStyle();
    this.root.innerHTML = "";
    this.root.classList.add("hud-root");

    this.applyTheme();
    this.unsubscribeTheme = this.bus.on("config:changed", (evt) => {
      if (evt.type === "theme") this.applyTheme();
    });

    this.fpsEl = document.createElement("div");
    this.fpsEl.className = "hud-fps";
    this.fpsEl.textContent = "FPS: --";
    this.root.appendChild(this.fpsEl);

    this.minimap = new Minimap(this.root, configs, bus, session);
    this.gauges = new Gauges(this.root, configs, bus, playerId);
    this.moduleButtons = new ModuleButtons(this.root, configs, bus, session, playerId);
    this.notifications = new NotificationCenter(this.root, configs);
    this.damageFx = new DamageFeedback(this.root, playerId);
    this.matchStatus = new MatchStatus(this.root, session);
    this.resultsOverlay = new ResultsOverlay(this.root, session, playerId, onPlayAgain);
  }

  private applyTheme(): void {
    const theme = this.configs.get<ThemeConfig>("theme", THEME_ID);
    if (!theme) {
      log.warn(`theme config not found: ${THEME_ID}`);
      return;
    }
    for (const [prop, value] of Object.entries(theme.colors)) {
      this.root.style.setProperty(prop, value);
    }
    const hud = theme.hud ?? {};
    this.root.style.setProperty("--hud-scale", String(hud.scale ?? 1));
    this.root.style.setProperty("--hud-module-btn-radius", `${hud.moduleButtonRadiusPx ?? 34}px`);
    this.root.style.setProperty("--hud-safe-inset", `${hud.safeAreaInsetPx ?? 12}px`);
    this.root.style.setProperty("--hud-module-gap", `${hud.moduleButtonGapPx ?? 14}px`);
    this.root.style.setProperty("--hud-minimap-size", `${hud.minimapSizePx ?? 128}px`);
    this.root.style.setProperty("--hud-gauge-width", `${hud.gaugeWidthPx ?? 140}px`);
  }

  /** Call once per render frame after events have been drained for the frame. */
  update(cur: Snapshot, prev: Snapshot, dtMs: number, fps: number): void {
    this.updateFps(fps);
    this.gauges.update(cur);
    this.moduleButtons.update(cur);
    this.minimap.update(cur, dtMs);
    this.matchStatus.update(cur);
    this.notifications.update(dtMs);
    this.damageFx.update(dtMs);
    this.resultsOverlay.update(cur);
  }

  /** Forward this frame's drained sim events to whichever sub-components care. */
  consumeEvents(events: readonly SimEvent[]): void {
    this.notifications.consumeEvents(events, this.configs);
    this.damageFx.consumeEvents(events);
  }

  private updateFps(fps: number): void {
    const text = `FPS: ${Number.isFinite(fps) ? fps.toFixed(0) : "--"}`;
    if (text !== this.lastFpsText) {
      this.lastFpsText = text;
      this.fpsEl.textContent = text;
    }
  }

  dispose(): void {
    this.unsubscribeTheme();
    this.moduleButtons.dispose();
    this.gauges.dispose();
    this.minimap.dispose();
    this.notifications.dispose();
    this.damageFx.dispose();
    this.matchStatus.dispose();
    this.resultsOverlay.dispose();
    this.root.innerHTML = "";
  }
}

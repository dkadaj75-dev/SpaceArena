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
import { ResultsOverlay, type MatchRewards } from "./ResultsOverlay.js";
import { injectHudStyle } from "./hudStyle.js";
import { Haptics } from "./Haptics.js";
import { hudCssVars, resolveHudLayout, type HudLayout } from "./hudLayout.js";

const log = createLogger("Hud");

const THEME_ID = "theme.default";

/** Current viewport in CSS px — the input to the portrait/landscape switch. */
function viewportSize(): { width: number; height: number } {
  return { width: viewportWidth(), height: viewportHeight() };
}

// Split accessors so the per-frame staleness check in `update()` can compare
// numbers without allocating a `{width, height}` object every single frame.
function viewportWidth(): number {
  if (typeof window === "undefined") return 0;
  return window.visualViewport?.width ?? window.innerWidth;
}

function viewportHeight(): number {
  if (typeof window === "undefined") return 0;
  return window.visualViewport?.height ?? window.innerHeight;
}

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
  private readonly haptics: Haptics;
  private readonly fpsEl: HTMLDivElement;
  private readonly unsubscribeTheme: () => void;
  private readonly onViewportChange: () => void;

  private lastFps = Number.POSITIVE_INFINITY;
  private layout: HudLayout;

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
    this.haptics = new Haptics(configs, playerId);

    this.layout = resolveHudLayout(this.configs.get<ThemeConfig>("theme", THEME_ID), viewportSize());
    this.applyTheme();
    this.unsubscribeTheme = this.bus.on("config:changed", (evt) => {
      if (evt.type === "theme") {
        this.applyTheme();
        this.haptics.refresh();
      }
    });

    // Rotating the device swaps the theme's portrait/landscape block; the
    // visual viewport also changes when the mobile URL bar collapses.
    this.onViewportChange = () => this.applyTheme();
    window.addEventListener("resize", this.onViewportChange);
    window.addEventListener("orientationchange", this.onViewportChange);
    window.visualViewport?.addEventListener("resize", this.onViewportChange);
  }

  /**
   * Pushes the theme's colors and the resolved (orientation-aware, scaled)
   * layout onto the HUD root as CSS custom properties, then hands the module
   * cluster geometry to {@link ModuleButtons}. Re-run on theme hot-reload and
   * on every viewport/orientation change.
   */
  private applyTheme(): void {
    const theme = this.configs.get<ThemeConfig>("theme", THEME_ID);
    if (!theme) log.warn(`theme config not found: ${THEME_ID}`);
    for (const [prop, value] of Object.entries(theme?.colors ?? {})) {
      this.root.style.setProperty(prop, value);
    }
    this.layout = resolveHudLayout(theme, viewportSize());
    for (const [prop, value] of Object.entries(hudCssVars(this.layout))) {
      this.root.style.setProperty(prop, value);
    }
    this.root.dataset["orientation"] = this.layout.orientation;
    this.moduleButtons.applyLayout(this.layout);
  }

  /** The layout currently driving the HUD — exposed for the one-thumb audit / debug hook. */
  get currentLayout(): HudLayout {
    return this.layout;
  }

  /** Call once per render frame after events have been drained for the frame. */
  update(cur: Snapshot, prev: Snapshot, dtMs: number, fps: number): void {
    // Belt-and-braces for the resize/orientationchange listeners: two number
    // comparisons per frame, and only then any DOM write. Some mobile browsers
    // resize the visual viewport (URL bar collapse, split-screen) without
    // firing a usable event, and a stale layout would break the thumb zone.
    if (
      viewportWidth() !== this.layout.viewport.width ||
      viewportHeight() !== this.layout.viewport.height
    ) {
      this.applyTheme();
    }
    this.updateFps(fps);
    this.gauges.update(cur);
    this.moduleButtons.update(cur);
    this.minimap.update(cur, dtMs);
    this.matchStatus.update(cur);
    this.notifications.update(dtMs);
    this.damageFx.update(dtMs);
    this.resultsOverlay.update(cur);
  }

  /** Direct toast for client-side feedback (e.g. rejected online orders). */
  showToast(text: string): void {
    this.notifications.showText(text);
  }

  /** Forwards a match's credit/xp/level-up summary to the results overlay. */
  showMatchRewards(rewards: MatchRewards): void {
    this.resultsOverlay.showRewards(rewards);
  }

  /** Forward this frame's drained sim events to whichever sub-components care. */
  consumeEvents(events: readonly SimEvent[]): void {
    this.notifications.consumeEvents(events, this.configs);
    this.damageFx.consumeEvents(events);
    this.haptics.consumeEvents(events);
  }

  /**
   * DOM write only when the *rounded* value changes — comparing the numbers
   * first means no template string is built on the ~59 frames out of 60 where
   * the reading is unchanged.
   */
  private updateFps(fps: number): void {
    const rounded = Number.isFinite(fps) ? Math.round(fps) : Number.NaN;
    if (Object.is(rounded, this.lastFps)) return;
    this.lastFps = rounded;
    this.fpsEl.textContent = `FPS: ${Number.isNaN(rounded) ? "--" : rounded}`;
  }

  dispose(): void {
    this.unsubscribeTheme();
    window.removeEventListener("resize", this.onViewportChange);
    window.removeEventListener("orientationchange", this.onViewportChange);
    window.visualViewport?.removeEventListener("resize", this.onViewportChange);
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

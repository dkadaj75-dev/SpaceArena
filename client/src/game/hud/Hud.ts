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
import { VitalArcs } from "./VitalArcs.js";
import { Minimap } from "./Minimap.js";
import { NotificationCenter } from "./Notifications.js";
import { DamageFeedback } from "./DamageFeedback.js";
import { FloatingDamageText } from "./FloatingDamageText.js";
import { MatchStatus } from "./MatchStatus.js";
import { CountdownOverlay } from "./CountdownOverlay.js";
import { KillAnnouncements } from "./KillAnnouncements.js";
import { ResultsOverlay, type MatchRewards, type ResultsCallbacks } from "./ResultsOverlay.js";
import { injectHudStyle } from "./hudStyle.js";
import { Haptics } from "./Haptics.js";
import { hudCssVars, resolveHudLayout, type HudLayout } from "./hudLayout.js";
import { FlightControls, type FlightHudBinding } from "./FlightControls.js";
import { flightCssVars, resolveFlightHudLayout, type FlightHudLayout } from "./flightHudLayout.js";
import { HUD_CONTROL_ATTR } from "../inputGuards.js";
import { BoundaryWarningLatch } from "../../core/boundaryProximity.js";
import { BlockedPullFeedback } from "./BlockedPullFeedback.js";
import { KillFeed } from "./KillFeed.js";
import { Scoreboard } from "./Scoreboard.js";
import { MatchPresentationFlow } from "./matchPresentation.js";

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
 * Monotonic clock for the flight order debounce. `performance.now()` where it
 * exists (every browser this ships to), `Date.now()` as the last resort — this
 * is presentation timing, never sim timing, so it is outside the determinism
 * rules that ban a clock read inside `shared/src/sim`.
 */
function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/**
 * Everything the HUD hands back to `main.ts`: the three results-screen exits
 * (5.8) plus the in-match settings affordance. `onSettings` is optional —
 * omitting it hides the gear button entirely.
 */
export interface HudCallbacks extends ResultsCallbacks {
  onSettings?: () => void;
}

export interface HudOptions {
  /** Offline practice: the results screen shows no reward animation (5.8). */
  offline?: boolean;
  /**
   * Flight controls (FLIGHT.md §4). Present ⇒ the HUD mounts the joystick,
   * throttle lever, FIRE button and lock reticle and starts emitting `flight`
   * orders. Absent ⇒ no flight HUD at all, which is what tests and any non-match
   * mounting want — the 3D bindings (projection, camera geometry) are the only
   * thing the HUD cannot supply for itself.
   */
  flight?: FlightHudBinding;
  /** Optional client audio path for the theme's blocked-trigger cue. */
  playSound?: (id: string) => void;
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
  private readonly vitalArcs: VitalArcs;
  private readonly minimap: Minimap;
  private readonly notifications: NotificationCenter;
  private readonly damageFx: DamageFeedback;
  private readonly floatingDamage: FloatingDamageText;
  private readonly matchStatus: MatchStatus;
  /** Match-start 3-2-1-GO numerals, driven by the sim-authoritative countdown. */
  private readonly countdown: CountdownOverlay;
  private readonly killAnnouncements: KillAnnouncements;
  private readonly killFeed: KillFeed;
  private readonly scoreboard: Scoreboard;
  private readonly resultsOverlay: ResultsOverlay;
  private readonly presentation = new MatchPresentationFlow();
  private readonly haptics: Haptics;
  /** Flight controls (FLIGHT.md §4), or null when the caller passed no 3D binding. */
  private readonly flight: FlightControls | null;
  private readonly boundaryWarning = new BoundaryWarningLatch();
  private readonly blockedPullFeedback: BlockedPullFeedback;
  private readonly unsubscribeTheme: () => void;
  private readonly unsubscribeShipConfig: () => void;
  private readonly onViewportChange: () => void;

  private layout: HudLayout;
  private flightLayout: FlightHudLayout;

  constructor(
    private readonly root: HTMLElement,
    private readonly configs: ConfigService,
    private readonly bus: EventBus<ConfigEvents>,
    private readonly session: GameSession,
    private readonly playerId: EntityId,
    callbacks: HudCallbacks,
    options: HudOptions = {},
  ) {
    injectHudStyle();
    this.root.innerHTML = "";
    this.root.classList.add("hud-root");

    // In-match settings (5.8). Marked as a HUD control so the 5.4 palm-rejection
    // guard exempts it — it sits close to the top edge on phones.
    if (callbacks.onSettings) {
      const settingsBtn = document.createElement("button");
      settingsBtn.className = "hud-settings-btn";
      settingsBtn.textContent = "⚙";
      settingsBtn.title = "Settings";
      settingsBtn.setAttribute("aria-label", "Settings");
      settingsBtn.setAttribute(HUD_CONTROL_ATTR, "");
      settingsBtn.dataset["hudSettings"] = "";
      settingsBtn.addEventListener("click", callbacks.onSettings);
      this.root.appendChild(settingsBtn);
    }

    this.minimap = new Minimap(this.root, configs, bus, session);
    this.gauges = new Gauges(this.root, configs, bus, playerId);
    this.vitalArcs = new VitalArcs(this.root, configs, playerId);
    this.moduleButtons = new ModuleButtons(this.root, configs, bus, session, playerId);
    this.notifications = new NotificationCenter(this.root, configs);
    this.damageFx = new DamageFeedback(this.root, playerId);
    this.floatingDamage = new FloatingDamageText(this.root, playerId, options.flight ?? null);
    this.matchStatus = new MatchStatus(this.root, session);
    this.countdown = new CountdownOverlay(this.root);
    this.killAnnouncements = new KillAnnouncements(this.root, playerId);
    this.killFeed = new KillFeed(this.root, session, playerId);
    this.scoreboard = new Scoreboard(this.root, session, callbacks);
    this.resultsOverlay = new ResultsOverlay(this.root, session, playerId, callbacks, {
      offline: options.offline ?? false,
    });
    this.resultsOverlay.setScoreboardAction(() => {
      if (!this.presentation.next()) return;
      this.root.dataset["presentation"] = "scoreboard";
      this.scoreboard.showFinal();
    });
    this.haptics = new Haptics(configs, playerId);
    this.blockedPullFeedback = new BlockedPullFeedback(
      configs,
      this.notifications,
      this.haptics,
      options.playSound ?? null,
    );

    const theme = this.configs.get<ThemeConfig>("theme", THEME_ID);
    this.layout = resolveHudLayout(theme, viewportSize());
    this.flightLayout = resolveFlightHudLayout(theme, viewportSize());
    this.flight = options.flight
      ? new FlightControls(
          this.root,
          configs,
          session,
          playerId,
          options.flight,
          this.flightLayout,
          () => this.blockedPullFeedback.trigger(this.flightLayout.fire.blockedNotification),
        )
      : null;
    this.applyTheme();
    this.unsubscribeTheme = this.bus.on("config:changed", (evt) => {
      if (evt.type === "theme") {
        this.applyTheme();
        this.haptics.refresh();
      }
    });
    // The reticle sizes itself from the player's RESOLVED sensor cone, so a
    // ship/module/upgrade edit has to invalidate that cache the same way a theme
    // edit re-lays out the widgets.
    this.unsubscribeShipConfig = this.bus.on("config:changed", (evt) => {
      if (evt.type === "ship" || evt.type === "module" || evt.type === "upgrade") this.flight?.refresh();
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
    // Fonts used to stop at the menu screens; the results banner and the gauge
    // labels want the same faces the lobby wordmark uses.
    if (theme?.fonts?.body) this.root.style.setProperty("--hud-font-body", theme.fonts.body);
    if (theme?.fonts?.display) this.root.style.setProperty("--hud-font-display", theme.fonts.display);
    this.layout = resolveHudLayout(theme, viewportSize());
    for (const [prop, value] of Object.entries(hudCssVars(this.layout))) {
      this.root.style.setProperty(prop, value);
    }
    this.root.dataset["orientation"] = this.layout.orientation;
    this.moduleButtons.applyLayout(this.layout);
    this.gauges.applyLayout(this.layout);
    this.vitalArcs.applyLayout(this.layout);
    this.minimap.applyLayout(this.layout);

    // Flight geometry resolves from the same theme + viewport, through its own
    // portrait/landscape block (FLIGHT.md §4). Its CSS vars land on the same
    // root. Gauges now resolve their own orientation-aware bottom-left geometry.
    this.flightLayout = resolveFlightHudLayout(theme, viewportSize());
    if (this.flight) {
      for (const [prop, value] of Object.entries(flightCssVars(this.flightLayout))) {
        this.root.style.setProperty(prop, value);
      }
      this.flight.applyLayout(this.flightLayout);
    }
  }

  /** The flight layout currently driving the controls — debug hook / tests. */
  get currentFlightLayout(): FlightHudLayout {
    return this.flightLayout;
  }

  /** The layout currently driving the HUD — exposed for the one-thumb audit / debug hook. */
  get currentLayout(): HudLayout {
    return this.layout;
  }

  /**
   * Call once per render frame after events have been drained for the frame.
   * `alpha` is the render loop's interpolation factor between `prev` and `cur`;
   * the flight reticle uses it so the target bracket tracks the same
   * interpolated ship the 3D view draws instead of stepping at the sim rate.
   */
  update(cur: Snapshot, prev: Snapshot, dtMs: number, alpha = 1): void {
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
    if (cur.phase === "ended" && this.presentation.end()) {
      this.root.dataset["presentation"] = "mvp";
      this.scoreboard.lockForEnd();
    }
    const presenting = this.presentation.state !== "playing";
    if (!presenting) this.flight?.update(cur, prev, alpha, dtMs, nowMs());
    this.gauges.update(cur);
    this.vitalArcs.update(cur);
    this.moduleButtons.update(cur);
    this.minimap.update(cur, dtMs);
    this.matchStatus.update(cur);
    // Flag calls are phrased from the viewer's side, so the announcer needs to
    // know which team that is; it can change across a match (respawn, rejoin).
    this.killAnnouncements.setPlayerTeam(cur.ships.find((s) => s.id === this.playerId)?.team ?? null);
    this.countdown.update(cur, dtMs);
    this.notifications.update(dtMs);
    this.damageFx.update(dtMs);
    this.floatingDamage.update(cur, prev, alpha, dtMs);
    this.resultsOverlay.update(cur, dtMs);
    this.killFeed.update(dtMs);
    this.scoreboard.update(cur);
  }

  /** Direct toast for client-side feedback (e.g. rejected online orders). */
  showToast(text: string): void {
    this.notifications.showText(text);
  }

  /**
   * Fire the authored warning only on entry. The per-match latch rearms after
   * the player leaves the warning zone, so sustained proximity cannot spam.
   */
  updateBoundaryProximity(
    distanceToBoundary: number,
    warnDistance: number,
    notificationId: string,
  ): void {
    if (this.boundaryWarning.update(distanceToBoundary, warnDistance)) {
      this.notifications.showConfig(this.configs, notificationId);
    }
  }

  /**
   * Player-level haptics opt-out (5.8 settings). The theme keeps its own master
   * switch — this only ever disables further, never enables what content
   * turned off.
   */
  setHapticsEnabled(enabled: boolean): void {
    this.haptics.setUserEnabled(enabled);
  }

  /**
   * Player-level pitch-axis invert (5.8 settings, BUBBLE.md §C). A no-op when the
   * HUD was mounted without flight controls.
   */
  setInvertPitch(invert: boolean): void {
    this.flight?.setInvertPitch(invert);
  }

  /** Player multipliers over the theme-owned relative-steer baselines. */
  setSteerSensitivity(mouseMultiplier: number, touchMultiplier: number): void {
    this.flight?.setSteerSensitivity(mouseMultiplier, touchMultiplier);
  }

  /** Forwards a match's credit/xp/level-up summary to the results overlay. */
  showMatchRewards(rewards: MatchRewards): void {
    this.resultsOverlay.showRewards(rewards);
  }

  /** Forward this frame's drained sim events to whichever sub-components care. */
  consumeEvents(events: readonly SimEvent[]): void {
    if (
      events.some(
        (event) => event.type === "entityDestroyed" && event.entityId === this.playerId,
      )
    ) {
      // Respawns can occur inside the warning zone. Death is a new warning
      // lifecycle even if no outside-zone frame occurred to rearm the latch.
      this.boundaryWarning.reset();
    }
    this.notifications.consumeEvents(events, this.configs);
    this.damageFx.consumeEvents(events);
    this.floatingDamage.consumeEvents(events);
    this.haptics.consumeEvents(events);
    this.killAnnouncements.consumeEvents(events);
    this.killFeed.consumeEvents(events);
  }

  dispose(): void {
    this.unsubscribeTheme();
    this.unsubscribeShipConfig();
    this.flight?.dispose();
    window.removeEventListener("resize", this.onViewportChange);
    window.removeEventListener("orientationchange", this.onViewportChange);
    window.visualViewport?.removeEventListener("resize", this.onViewportChange);
    this.moduleButtons.dispose();
    this.killAnnouncements.dispose();
    this.killFeed.dispose();
    this.scoreboard.dispose();
    this.gauges.dispose();
    this.vitalArcs.dispose();
    this.minimap.dispose();
    this.notifications.dispose();
    this.damageFx.dispose();
    this.floatingDamage.dispose();
    this.matchStatus.dispose();
    this.countdown.dispose();
    this.resultsOverlay.dispose();
    this.root.innerHTML = "";
  }
}

import {
  createLogger,
  menuSectionOf,
  type ConfigEvents,
  type ConfigService,
  type EventBus,
  type GamemodeConfig,
  type ThemeConfig,
  type TutorialConfig,
} from "@space-arena/shared";
import type { AuthService, AuthState } from "../../core/AuthService.js";
import {
  SERVER_OFFLINE_HINT,
  SERVER_OFFLINE_MESSAGE,
  type ServerHealthState,
} from "../../core/serverHealth.js";
import { applyMenuTheme, createMenuBackdrop, injectScreenStyle } from "./screenStyle.js";
import type { MenuTheme } from "./menuTheme.js";

const log = createLogger("Lobby");

const THEME_ID = "theme.default";
export const OFFLINE_HEALTH_REFRESH_MS = 10_000;

export type LobbyChoice =
  /** Offline bot practice. Every choice names its concrete gamemode. */
  | { kind: "practice"; gamemode: string }
  /** Flight school (offline, no rewards) — its own entry, not a practice row. */
  | { kind: "tutorial" }
  | { kind: "online"; gamemode: string; options?: { minPlayers?: number } }
  | { kind: "matchmaking"; mode: "duel-1v1"; gamemode: "gamemode.duel-1v1" };

interface TrackedButton {
  el: HTMLButtonElement;
  /** Online buttons are disabled while anonymous (§8 3.3: practice always works offline). */
  online: boolean;
}

export interface LobbyCallbacks {
  onChoose: (choice: LobbyChoice) => void;
  onLogout: () => void;
  onAccountRequested: (tab: "login" | "register") => void;
  onHangarRequested: () => void;
  /** SHOP — hulls, modules and paints; a Fleet destination like the Hangar. */
  onShopRequested: () => void;
  /** Gear button — opens the 5.8 settings screen over the lobby. */
  onSettingsRequested: () => void;
}

/**
 * The tutorial's own menu entry (owner 2026-08-08). It heads the Practice
 * section rather than living in a section of its own: onboarding IS practice,
 * and a first-time pilot reads down from the top.
 */
const TUTORIAL_LABEL = "Tutorial";

/**
 * Main menu (ROADMAP §7 2.8 client, restyled by §10 5.8).
 *
 * Structure is deliberately data-first: the *sections* are fixed (Practice /
 * Online / Fleet) but their buttons are generated from the gamemode configs, so
 * a content pack that adds a mode gets a menu entry with no code change. The
 * look — nebula backdrop, cyan/orange accents, title treatment — comes from
 * `theme.menu` through {@link applyMenuTheme}, and hot-reloads with the theme.
 *
 * Behaviour preserved from the pre-5.8 screen: online entries are disabled
 * while anonymous, every button is disabled while a match is being started, and
 * connection errors land in the status line.
 */
export class Lobby {
  private readonly root: HTMLDivElement;
  private readonly header: HTMLDivElement;
  private readonly status: HTMLDivElement;
  private readonly titleEl: HTMLHeadingElement;
  private readonly subtitleEl: HTMLDivElement;
  private readonly sections: HTMLDivElement;
  private readonly buttons: TrackedButton[] = [];
  private readonly unsubscribeAuth: () => void;
  private readonly unsubscribeHealth: () => void;
  private readonly unsubscribeTheme: (() => void) | null = null;
  private readonly callbacks: LobbyCallbacks;
  /** Persistent "the game server did not answer" banner on the Online section. */
  private readonly offlineBadge: HTMLDivElement;
  private readonly offlineDetail: HTMLSpanElement;
  private healthRefreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    parent: HTMLElement,
    private readonly configs: ConfigService,
    private readonly auth: AuthService,
    private readonly serverHealth: ServerHealthState,
    callbacks: LobbyCallbacks,
    bus?: EventBus<ConfigEvents>,
  ) {
    this.callbacks = callbacks;
    injectScreenStyle();
    this.root = document.createElement("div");
    this.root.className = "lobby-overlay game-screen sa-screen sa-menu";
    this.root.style.zIndex = "20";
    this.root.append(createMenuBackdrop());

    this.header = document.createElement("div");
    this.header.className = "sa-screen-header";
    this.root.append(this.header);

    const titleWrap = document.createElement("div");
    titleWrap.className = "sa-menu-titlewrap";
    this.titleEl = document.createElement("h1");
    this.titleEl.className = "sa-screen-title";
    this.subtitleEl = document.createElement("div");
    this.subtitleEl.className = "sa-menu-subtitle";
    const rule = document.createElement("div");
    rule.className = "sa-menu-rule";
    titleWrap.append(this.titleEl, this.subtitleEl, rule);
    this.root.append(titleWrap);

    // Built before buildSections() so the Online section can adopt it as its
    // first child; hidden until someone reports the server missing.
    this.offlineBadge = document.createElement("div");
    this.offlineBadge.className = "sa-menu-offline-badge";
    this.offlineBadge.dataset["serverOffline"] = "";
    this.offlineBadge.setAttribute("role", "status");
    this.offlineDetail = span("detail", "");
    this.offlineBadge.append(dot(), span("text", SERVER_OFFLINE_MESSAGE), this.offlineDetail);

    this.sections = document.createElement("div");
    this.sections.className = "sa-menu-sections";
    this.root.append(this.sections);
    this.buildSections();

    this.status = document.createElement("div");
    this.status.className = "sa-screen-status";
    this.root.append(this.status);

    parent.append(this.root);

    this.applyTheme();
    if (bus) {
      this.unsubscribeTheme = bus.on("config:changed", (evt) => {
        if (evt.type === "theme") this.applyTheme();
      });
    }

    this.unsubscribeAuth = this.auth.onChange((state) => this.renderHeader(state));
    this.unsubscribeHealth = this.serverHealth.subscribe((health) => this.renderServerHealth(health.online, health.detail));
    this.renderHeader(this.auth.getState());
  }

  /** Push `theme.menu` at the screen (initial paint + every theme hot-reload). */
  private applyTheme(): void {
    const menu: MenuTheme = applyMenuTheme(this.root, this.configs.get<ThemeConfig>("theme", THEME_ID));
    this.titleEl.textContent = menu.titleText;
    this.subtitleEl.textContent = menu.titleSubtitle;
  }

  /**
   * Play sections. Practice modes (anything offline-capable) come first because
   * they work without an account; online modes are grouped under their own
   * heading, and the Hangar sits in its own accent-marked section since it is a
   * destination rather than a match.
   */
  private buildSections(): void {
    const gamemodes = this.configs.getAll<GamemodeConfig>("gamemode");

    const practice = this.section("Practice", "primary");
    // Onboarding first, and only when the pack actually ships one: the tutorial
    // is a content config, so a pack without it simply has no button.
    if (this.hasTutorial()) {
      this.addButton(practice, TUTORIAL_LABEL, () => this.choose({ kind: "tutorial" }), false, undefined, "tutorial");
    }
    // Any gamemode the pack files under Practice (by default: one declaring a
    // bot roster) is an offline mode.
    for (const gm of gamemodes) {
      if (menuSectionOf(gm) !== "practice") continue;
      // The gamemode's own name is the label — a pack that adds an offline mode
      // gets a menu entry with no code change (and no invented suffix).
      this.addButton(practice, gm.name ?? gm.id, () => this.choose({ kind: "practice", gamemode: gm.id }), false);
    }

    const online = this.section("Online", "primary");
    online.append(this.offlineBadge);
    for (const gm of gamemodes) {
      if (menuSectionOf(gm) !== "online") continue;
      const choice: LobbyChoice =
        gm.id === "gamemode.duel-1v1"
          ? { kind: "matchmaking", mode: "duel-1v1", gamemode: "gamemode.duel-1v1" }
          : { kind: "online", gamemode: gm.id };
      this.addButton(online, `${gm.name ?? gm.id}`, () => this.choose(choice), true);
    }

    const fleet = this.section("Fleet", "accent");
    this.addButton(fleet, "Hangar", () => this.callbacks.onHangarRequested(), false, "accent", "hangar");
    // Offline-capable like the Hangar: the ledger is local without an account,
    // so a pilot with no login can still buy (contract §3).
    this.addButton(fleet, "Shop", () => this.callbacks.onShopRequested(), false, "accent", "shop");
  }

  private section(title: string, accent: "primary" | "accent"): HTMLDivElement {
    const box = document.createElement("div");
    box.className = "sa-menu-section";
    box.dataset["accent"] = accent;
    box.dataset["section"] = title.toLowerCase();
    const heading = document.createElement("div");
    heading.className = "sa-menu-section-title";
    heading.textContent = title;
    box.append(heading);
    this.sections.append(box);
    return box;
  }

  /** Whether this pack ships a tutorial for the button to launch. */
  private hasTutorial(): boolean {
    return this.configs.getAll<TutorialConfig>("tutorial").length > 0;
  }

  private addButton(
    parent: HTMLElement,
    label: string,
    onClick: () => void,
    online: boolean,
    variant?: "primary" | "accent",
    /** Stable hook for the tutorial's coach mark (and for tests) to find a destination. */
    action?: string,
  ): void {
    const b = document.createElement("button");
    b.textContent = label;
    b.className = `sa-screen-btn sa-button sa-button--${variant === "primary" ? "primary" : "secondary"}${variant ? ` sa-screen-btn--${variant}` : ""}`;
    if (action) b.dataset["lobbyAction"] = action;
    b.addEventListener("click", onClick);
    this.buttons.push({ el: b, online });
    parent.append(b);
  }

  private renderHeader(state: AuthState): void {
    this.header.innerHTML = "";
    const chip = document.createElement("span");
    chip.className = "sa-menu-account";

    if (state.status === "authed") {
      const { displayName, level, credits } = state.profile;
      chip.append(
        span("name", displayName),
        span("sep", "·"),
        span("level", `Lv ${level}`),
        span("sep", "·"),
        span("credits", `${credits} cr`),
      );
      this.header.append(chip);
      if (state.profile.isGuest) {
        this.header.append(this.link("Upgrade account", () => this.callbacks.onAccountRequested("register")));
      }
      const logout = document.createElement("button");
      logout.textContent = "Log out";
      logout.className = "sa-screen-chip";
      logout.addEventListener("click", () => this.callbacks.onLogout());
      this.header.append(logout);
    } else {
      chip.classList.add("offline");
      chip.append(span("name", "Playing offline"));
      this.header.append(chip, this.link("Log in / Sign up", () => this.callbacks.onAccountRequested("login")));
    }

    const settings = document.createElement("button");
    settings.className = "sa-screen-icon-btn sa-icon-button";
    settings.textContent = "⚙";
    settings.title = "Settings";
    settings.setAttribute("aria-label", "Settings");
    settings.dataset["lobbySettings"] = "";
    settings.addEventListener("click", () => this.callbacks.onSettingsRequested());
    this.header.append(settings);

    this.applyOnlineButtonState(state.status === "authed");
  }

  private link(label: string, onClick: () => void): HTMLAnchorElement {
    const a = document.createElement("a");
    a.href = "#";
    a.textContent = label;
    a.className = "sa-screen-link";
    a.addEventListener("click", (e) => {
      e.preventDefault();
      onClick();
    });
    return a;
  }

  /**
   * Report the game server's reachability (the boot health probe, and any later
   * join that failed with a network error). An offline server disables every
   * online entry and raises the persistent badge — offline practice is
   * deliberately untouched, because it needs nothing but the content pack.
   */
  setServerOnline(online: boolean, detail = ""): void {
    this.serverHealth.set({ online, detail });
  }

  private renderServerHealth(online: boolean, detail = ""): void {
    this.offlineBadge.classList.toggle("visible", !online);
    // Parenthesised so the probe's own words read as an aside next to the
    // headline rather than running into it.
    this.offlineDetail.textContent = online || !detail ? "" : `(${detail})`;
    this.applyOnlineButtonState(this.auth.getState().status === "authed");
    this.syncHealthRefreshTimer();
  }

  /** Whether the lobby currently believes the game server is reachable. */
  get serverReachable(): boolean {
    return this.serverHealth.current.online;
  }

  /**
   * A join attempt died because nothing answered. Raises the same badge the
   * boot probe uses and clears the busy state, so the player is never left
   * reading a raw `NetworkError when attempting to fetch resource.` toast.
   */
  showServerOffline(detail = ""): void {
    this.setServerOnline(false, detail);
    this.setBusy(false, SERVER_OFFLINE_MESSAGE);
  }

  private applyOnlineButtonState(authed: boolean): void {
    for (const { el, online } of this.buttons) {
      if (!online) continue;
      el.disabled = !authed || !this.serverHealth.current.online;
      el.title = !this.serverHealth.current.online
        ? SERVER_OFFLINE_HINT
        : authed
          ? ""
          : "Log in or play as a guest to play online";
    }
  }

  private choose(choice: LobbyChoice): void {
    log.info("choice", choice);
    this.setBusy(true, choice.kind === "online" ? "Connecting…" : "");
    this.callbacks.onChoose(choice);
  }

  setBusy(busy: boolean, message = ""): void {
    const authed = this.auth.getState().status === "authed";
    for (const { el, online } of this.buttons) {
      el.disabled = busy || (online && (!authed || !this.serverHealth.current.online));
    }
    this.status.textContent = message;
  }

  showError(message: string): void {
    this.setBusy(false, `⚠ ${message}`);
  }

  show(): void {
    this.root.style.display = "flex";
    this.setBusy(false, "");
    void this.serverHealth.refresh();
    this.syncHealthRefreshTimer();
  }
  hide(): void {
    this.root.style.display = "none";
    this.stopHealthRefreshTimer();
  }
  dispose(): void {
    this.unsubscribeAuth();
    this.unsubscribeHealth();
    this.unsubscribeTheme?.();
    this.stopHealthRefreshTimer();
    this.root.remove();
  }

  private syncHealthRefreshTimer(): void {
    const visible = this.root.style.display !== "none";
    if (!visible || this.serverHealth.current.online) {
      this.stopHealthRefreshTimer();
      return;
    }
    if (this.healthRefreshTimer) return;
    this.healthRefreshTimer = setInterval(() => void this.serverHealth.refresh(), OFFLINE_HEALTH_REFRESH_MS);
  }

  private stopHealthRefreshTimer(): void {
    if (this.healthRefreshTimer) clearInterval(this.healthRefreshTimer);
    this.healthRefreshTimer = null;
  }
}

function span(className: string, text: string): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = className;
  el.textContent = text;
  return el;
}

/** The pulsing status lamp on the offline badge. */
function dot(): HTMLSpanElement {
  const el = span("dot", "");
  el.setAttribute("aria-hidden", "true");
  return el;
}

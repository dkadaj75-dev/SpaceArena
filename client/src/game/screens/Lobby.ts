import {
  createLogger,
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
import { iconElement } from "./menuIcons.js";
import { menuGroups } from "./menuModes.js";
import type { MenuTheme } from "./menuTheme.js";

const log = createLogger("Lobby");

const THEME_ID = "theme.default";
export const OFFLINE_HEALTH_REFRESH_MS = 10_000;

export type LobbyChoice =
  /** Flight school (offline, no rewards) — its own entry, not a practice row. */
  | { kind: "tutorial" }
  | { kind: "online"; gamemode: string };

interface TrackedButton {
  el: HTMLButtonElement;
  /** Server-backed when reachable; locally bot-backed when it is not. */
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
  /**
   * Called whenever the menu appears or disappears, so the caller can raise and
   * drop the 3D diorama behind it. The lobby is shown from a dozen call sites,
   * which is exactly why the backdrop is driven from here rather than from each
   * of them.
   */
  onVisibilityChange?: (visible: boolean) => void;
}

/**
 * The tutorial's own menu entry closes the single Play list; preceding mode
 * rows are online and share one launch path.
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
 * When the server is reachable, mode entries require an identity and join an
 * authoritative room. When it is absent (including GitHub Pages), the same
 * entries stay enabled and launch the local simulation with bot-filled teams.
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
    // The CSS nebula is the FALLBACK backdrop. When the pack stages a 3D scene
    // it renders behind this overlay instead, so the flat backdrop would simply
    // hide it.
    if ((this.configs.get<ThemeConfig>("theme", THEME_ID)?.menu?.scene?.kind ?? "none") === "none") {
      this.root.append(createMenuBackdrop());
    } else {
      this.root.dataset["diorama"] = "on";
    }

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
   * The Play grid, then the destinations row.
   *
   * Modes are grouped by their authored `menu.group` — the sections' SHAPE is
   * fixed here, their content is not, so a pack that adds a mode still gets a
   * menu entry with no code change. Destinations (Hangar, Shop, Tutorial) are
   * deliberately a different shape from modes: they are places you go, not
   * matches you start, and a player should never have to read a label to tell
   * the two apart.
   */
  private buildSections(): void {
    const gamemodes = this.configs.getAll<GamemodeConfig>("gamemode");

    // The badge is about the SERVER, not about one group, so it sits above the
    // whole grid rather than inside it — as a child of the wrapping grid it
    // shared a row with the first group and sat on its heading.
    this.sections.append(this.offlineBadge);

    const play = document.createElement("div");
    play.className = "sa-menu-play";

    for (const group of menuGroups(gamemodes)) {
      const box = document.createElement("div");
      box.className = "sa-menu-group";
      box.dataset["group"] = group.title.toLowerCase();

      const heading = document.createElement("h2");
      heading.className = "sa-menu-group-title";
      heading.textContent = group.title;
      box.append(heading);

      const cards = document.createElement("div");
      cards.className = "sa-menu-cards";
      for (const mode of group.modes) {
        cards.append(this.modeCard(mode.id, mode.label, mode.blurb, mode.icon, mode.teams));
      }
      box.append(cards);
      play.append(box);
    }
    this.sections.append(play);

    const destinations = document.createElement("div");
    destinations.className = "sa-menu-destinations";
    destinations.append(
      this.destination("Hangar", "Fit and paint your ship", "hangar", () => this.callbacks.onHangarRequested()),
      // Offline-capable like the Hangar: the ledger is local without an account,
      // so a pilot with no login can still buy (contract §3).
      this.destination("Shop", "Hulls, modules, skins", "shop", () => this.callbacks.onShopRequested()),
    );
    // The tutorial is a content config, so a pack without it has no button.
    if (this.hasTutorial()) {
      destinations.append(
        this.destination(TUTORIAL_LABEL, "Learn to fly", "tutorial", () => this.choose({ kind: "tutorial" })),
      );
    }
    this.sections.append(destinations);
  }

  /** A match you can start: icon, the short label, and what it actually is. */
  private modeCard(
    gamemode: string,
    label: string,
    blurb: string,
    icon: string | undefined,
    teams: string,
  ): HTMLButtonElement {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "sa-menu-card";
    card.dataset["gamemode"] = gamemode;
    card.append(iconElement(icon, teams));

    const text = document.createElement("span");
    text.className = "sa-menu-card-text";
    const name = document.createElement("span");
    name.className = "sa-menu-card-label";
    name.textContent = label;
    text.append(name);
    if (blurb) {
      const sub = document.createElement("span");
      sub.className = "sa-menu-card-blurb";
      sub.textContent = blurb;
      text.append(sub);
    }
    card.append(text);
    card.addEventListener("click", () => this.choose({ kind: "online", gamemode }));
    this.buttons.push({ el: card, online: true });
    return card;
  }

  /** A place you go rather than a match you start — quieter, and wider. */
  private destination(label: string, blurb: string, icon: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "sa-menu-destination";
    button.dataset["lobbyAction"] = icon;
    button.append(iconElement(icon));

    const text = document.createElement("span");
    text.className = "sa-menu-card-text";
    const name = document.createElement("span");
    name.className = "sa-menu-card-label";
    name.textContent = label;
    const sub = document.createElement("span");
    sub.className = "sa-menu-card-blurb";
    sub.textContent = blurb;
    text.append(name, sub);
    button.append(text);

    button.addEventListener("click", onClick);
    this.buttons.push({ el: button, online: false });
    return button;
  }

  /** Whether this pack ships a tutorial for the button to launch. */
  private hasTutorial(): boolean {
    return this.configs.getAll<TutorialConfig>("tutorial").length > 0;
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
   * join that failed with a network error). The persistent badge explains that
   * mode buttons now launch local bot matches instead of authoritative rooms.
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
      el.disabled = this.serverHealth.current.online && !authed;
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
      el.disabled = busy || (online && this.serverHealth.current.online && !authed);
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
    this.callbacks.onVisibilityChange?.(true);
  }
  /** Whether the menu is the screen currently on show. */
  get visible(): boolean {
    return this.root.style.display !== "none";
  }

  hide(): void {
    this.root.style.display = "none";
    this.stopHealthRefreshTimer();
    this.callbacks.onVisibilityChange?.(false);
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

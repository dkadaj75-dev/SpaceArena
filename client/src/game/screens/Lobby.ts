import {
  createLogger,
  type ConfigEvents,
  type ConfigService,
  type EventBus,
  type GamemodeConfig,
  type ThemeConfig,
} from "@space-arena/shared";
import type { AuthService, AuthState } from "../../core/AuthService.js";
import { applyMenuTheme, createMenuBackdrop, injectScreenStyle } from "./screenStyle.js";
import type { MenuTheme } from "./menuTheme.js";

const log = createLogger("Lobby");

const THEME_ID = "theme.default";

export type LobbyChoice =
  /** Offline practice. `gamemode` defaults to `gamemode.practice` (static dummies). */
  | { kind: "practice"; gamemode?: string }
  | { kind: "online"; gamemode: string; options?: { practiceTarget?: boolean; minPlayers?: number } };

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
  /** Gear button — opens the 5.8 settings screen over the lobby. */
  onSettingsRequested: () => void;
}

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
  private readonly unsubscribeTheme: (() => void) | null = null;
  private readonly callbacks: LobbyCallbacks;

  constructor(
    parent: HTMLElement,
    private readonly configs: ConfigService,
    private readonly auth: AuthService,
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
    this.addButton(practice, "Practice — Dummies", () => this.choose({ kind: "practice" }), false, "primary");
    // Any gamemode declaring a bot roster (5.1) is an offline practice mode.
    for (const gm of gamemodes) {
      if (!gm.bots?.roster?.length) continue;
      // The gamemode's own name is the label — a pack that adds an offline mode
      // gets a menu entry with no code change (and no invented suffix).
      this.addButton(practice, gm.name ?? gm.id, () => this.choose({ kind: "practice", gamemode: gm.id }), false);
    }

    const online = this.section("Online", "primary");
    for (const gm of gamemodes) {
      if (gm.id === "gamemode.practice" || gm.bots?.roster?.length) continue;
      this.addButton(online, `${gm.name ?? gm.id}`, () => this.choose({ kind: "online", gamemode: gm.id }), true);
    }
    this.addButton(
      online,
      "Solo test (vs dummies)",
      () =>
        this.choose({
          kind: "online",
          gamemode: "gamemode.duel-1v1",
          options: { practiceTarget: true, minPlayers: 1 },
        }),
      true,
    );

    const fleet = this.section("Fleet", "accent");
    this.addButton(fleet, "Hangar", () => this.callbacks.onHangarRequested(), false, "accent");
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

  private addButton(
    parent: HTMLElement,
    label: string,
    onClick: () => void,
    online: boolean,
    variant?: "primary" | "accent",
  ): void {
    const b = document.createElement("button");
    b.textContent = label;
    b.className = `sa-screen-btn${variant ? ` sa-screen-btn--${variant}` : ""}`;
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
    settings.className = "sa-screen-icon-btn";
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

  private applyOnlineButtonState(authed: boolean): void {
    for (const { el, online } of this.buttons) {
      if (!online) continue;
      el.disabled = !authed;
      el.title = authed ? "" : "Log in or play as a guest to play online";
    }
  }

  private choose(choice: LobbyChoice): void {
    log.info("choice", choice);
    this.setBusy(true, choice.kind === "online" ? "Connecting…" : "");
    this.callbacks.onChoose(choice);
  }

  setBusy(busy: boolean, message = ""): void {
    const authed = this.auth.getState().status === "authed";
    for (const { el, online } of this.buttons) el.disabled = busy || (online && !authed);
    this.status.textContent = message;
  }

  showError(message: string): void {
    this.setBusy(false, `⚠ ${message}`);
  }

  show(): void {
    this.root.style.display = "flex";
    this.setBusy(false, "");
  }
  hide(): void {
    this.root.style.display = "none";
  }
  dispose(): void {
    this.unsubscribeAuth();
    this.unsubscribeTheme?.();
    this.root.remove();
  }
}

function span(className: string, text: string): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = className;
  el.textContent = text;
  return el;
}

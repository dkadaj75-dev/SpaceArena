import { createLogger, type ConfigService, type GamemodeConfig } from "@space-arena/shared";
import type { AuthService, AuthState } from "../../core/AuthService.js";
import { injectScreenStyle } from "./screenStyle.js";

const log = createLogger("Lobby");

export type LobbyChoice =
  /** Offline practice. `gamemode` defaults to `gamemode.practice` (static dummies). */
  | { kind: "practice"; gamemode?: string }
  | { kind: "online"; gamemode: string; options?: { practiceTarget?: boolean; minPlayers?: number } };

interface TrackedButton {
  el: HTMLButtonElement;
  /** Online buttons are disabled while anonymous (§8 3.3: practice always works offline). */
  online: boolean;
}

/**
 * Minimal pre-match overlay (ROADMAP §7 2.8 client): mode buttons generated
 * from gamemode configs plus an offline practice entry, plus (§8 3.3) an
 * account header row wired to {@link AuthService}. Phase 5 restyles this.
 */
export class Lobby {
  private readonly root: HTMLDivElement;
  private readonly header: HTMLDivElement;
  private readonly status: HTMLDivElement;
  private readonly buttons: TrackedButton[] = [];
  private readonly unsubscribeAuth: () => void;

  constructor(
    parent: HTMLElement,
    private readonly configs: ConfigService,
    private readonly auth: AuthService,
    private readonly onChoose: (choice: LobbyChoice) => void,
    private readonly onLogout: () => void,
    private readonly onAccountRequested: (tab: "login" | "register") => void,
    private readonly onHangarRequested: () => void,
  ) {
    injectScreenStyle();
    this.root = document.createElement("div");
    this.root.className = "lobby-overlay game-screen sa-screen";
    this.root.style.background = "rgba(4,8,16,.88)";
    this.root.style.zIndex = "20";

    this.header = document.createElement("div");
    this.header.className = "sa-screen-header";
    this.root.append(this.header);

    const title = document.createElement("h1");
    title.textContent = "SPACE ARENA";
    title.className = "sa-screen-title";
    this.root.append(title);

    this.addButton("Practice (offline)", () => this.choose({ kind: "practice" }), false);
    // Any gamemode declaring a bot roster (5.1) is an offline practice mode.
    for (const gm of this.configs.getAll<GamemodeConfig>("gamemode")) {
      if (!gm.bots?.roster?.length) continue;
      this.addButton(
        `${gm.name ?? gm.id} (offline)`,
        () => this.choose({ kind: "practice", gamemode: gm.id }),
        false,
      );
    }
    this.addButton("Hangar", () => this.onHangarRequested(), false);
    for (const gm of this.configs.getAll<GamemodeConfig>("gamemode")) {
      if (gm.id === "gamemode.practice" || gm.bots?.roster?.length) continue;
      this.addButton(`Play Online — ${gm.name ?? gm.id}`, () => this.choose({ kind: "online", gamemode: gm.id }), true);
    }
    this.addButton(
      "Online solo test (vs dummies)",
      () => this.choose({ kind: "online", gamemode: "gamemode.duel-1v1", options: { practiceTarget: true, minPlayers: 1 } }),
      true,
    );

    this.status = document.createElement("div");
    this.status.className = "sa-screen-status";
    this.root.append(this.status);

    parent.append(this.root);

    this.unsubscribeAuth = this.auth.onChange((state) => this.renderHeader(state));
    this.renderHeader(this.auth.getState());
  }

  private addButton(label: string, onClick: () => void, online: boolean): void {
    const b = document.createElement("button");
    b.textContent = label;
    b.className = "sa-screen-btn";
    b.addEventListener("click", onClick);
    this.buttons.push({ el: b, online });
    this.root.append(b);
  }

  private renderHeader(state: AuthState): void {
    this.header.innerHTML = "";
    const info = document.createElement("span");
    if (state.status === "authed") {
      info.textContent = `${state.profile.displayName} · Lv ${state.profile.level} · ${state.profile.credits}cr`;
      this.header.append(info);
      if (state.profile.isGuest) this.header.append(this.link("Upgrade account", () => this.onAccountRequested("register")));
      const logout = document.createElement("button");
      logout.textContent = "Log out";
      logout.className = "sa-screen-chip";
      logout.addEventListener("click", () => this.onLogout());
      this.header.append(logout);
    } else {
      info.textContent = "Playing offline";
      this.header.append(info);
      this.header.append(this.link("Log in / Sign up", () => this.onAccountRequested("login")));
    }
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
    this.onChoose(choice);
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
    this.root.remove();
  }
}

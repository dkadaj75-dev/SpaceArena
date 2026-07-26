import { createLogger, type ConfigService, type ThemeConfig } from "@space-arena/shared";
import { ApiRequestError, type AuthService } from "../../core/AuthService.js";
import { looksLikeServerUnreachable, SERVER_OFFLINE_MESSAGE } from "../../core/serverHealth.js";
import { applyMenuTheme, createMenuBackdrop, injectScreenStyle } from "./screenStyle.js";

const log = createLogger("AuthScreen");

type Tab = "login" | "register";

/**
 * Pre-Lobby account gate (ROADMAP §8 3.3). Guest is the one-tap path; login
 * and register live behind a collapsible toggle so the primary flow stays
 * uncluttered. Styling matches {@link import("./Lobby.js").Lobby} (dark,
 * cyan accents, system-ui) since the two screens are shown back-to-back.
 */
export class AuthScreen {
  private readonly root: HTMLDivElement;
  private readonly errorEl: HTMLDivElement;
  private readonly formsWrap: HTMLDivElement;
  private readonly tabButtons: Record<Tab, HTMLButtonElement>;
  private readonly panels: Record<Tab, HTMLDivElement>;
  private readonly actionButtons: HTMLButtonElement[] = [];
  private expanded = false;

  constructor(
    parent: HTMLElement,
    private readonly auth: AuthService,
    private readonly onAuthed: () => void,
    private readonly onSkipOffline: () => void,
    /**
     * Optional so every existing caller (and every test) keeps working. When
     * present the gate wears the Lobby's nebula backdrop and `theme.menu`
     * palette instead of a flat wash — the two screens are shown back to back,
     * and this one is the first thing a new player sees after the boot panel.
     */
    configs?: ConfigService,
  ) {
    injectScreenStyle();
    this.root = document.createElement("div");
    this.root.className = "auth-overlay game-screen sa-screen sa-menu";
    this.root.style.zIndex = "30";
    this.root.append(createMenuBackdrop());
    applyMenuTheme(this.root, configs?.get<ThemeConfig>("theme", "theme.default"));

    const titleWrap = document.createElement("div");
    titleWrap.className = "sa-menu-titlewrap";
    const title = document.createElement("h1");
    title.textContent = "SPACE ARENA";
    title.className = "sa-screen-title";
    const rule = document.createElement("div");
    rule.className = "sa-menu-rule";
    rule.setAttribute("aria-hidden", "true");
    titleWrap.append(title, rule);
    this.root.append(titleWrap);

    const guestBtn = this.bigButton("Play as Guest");
    guestBtn.addEventListener("click", () => void this.run(() => this.auth.guest()));
    this.root.append(guestBtn);

    this.errorEl = document.createElement("div");
    this.errorEl.className = "sa-screen-error";
    this.root.append(this.errorEl);

    const toggle = document.createElement("a");
    toggle.href = "#";
    toggle.textContent = "Log in / Register";
    toggle.className = "sa-screen-link";
    toggle.addEventListener("click", (e) => {
      e.preventDefault();
      this.setExpanded(!this.expanded);
    });
    this.root.append(toggle);

    this.formsWrap = document.createElement("div");
    this.formsWrap.className = "sa-screen-forms";

    const tabsRow = document.createElement("div");
    tabsRow.className = "sa-screen-tabs";
    const loginTabBtn = this.tabButton("Log In");
    const registerTabBtn = this.tabButton("Register");
    loginTabBtn.addEventListener("click", () => this.selectTab("login"));
    registerTabBtn.addEventListener("click", () => this.selectTab("register"));
    tabsRow.append(loginTabBtn, registerTabBtn);
    this.tabButtons = { login: loginTabBtn, register: registerTabBtn };
    this.formsWrap.append(tabsRow);

    const loginPanel = this.buildLoginForm();
    const registerPanel = this.buildRegisterForm();
    this.panels = { login: loginPanel, register: registerPanel };
    this.formsWrap.append(loginPanel, registerPanel);

    this.root.append(this.formsWrap);

    const skip = document.createElement("a");
    skip.href = "#";
    skip.textContent = "Skip (offline practice)";
    skip.className = "sa-screen-link muted";
    skip.addEventListener("click", (e) => {
      e.preventDefault();
      this.onSkipOffline();
    });
    this.root.append(skip);

    this.selectTab("login");
    parent.append(this.root);
  }

  private buildLoginForm(): HTMLDivElement {
    const panel = document.createElement("div");
    panel.className = "sa-screen-panel";
    const email = this.textInput("email", "Email");
    const password = this.textInput("password", "Password");
    const submit = this.formButton("Log In");
    submit.addEventListener("click", () =>
      void this.run(() => this.auth.login(email.value.trim(), password.value)),
    );
    panel.append(email, password, submit);
    return panel;
  }

  private buildRegisterForm(): HTMLDivElement {
    const panel = document.createElement("div");
    panel.className = "sa-screen-panel";
    const displayName = this.textInput("text", "Display name (optional)");
    const email = this.textInput("email", "Email");
    const password = this.textInput("password", "Password (min 8 chars)");
    const submit = this.formButton("Register");
    submit.addEventListener("click", () =>
      void this.run(() =>
        this.auth.register(email.value.trim(), password.value, displayName.value.trim() || undefined),
      ),
    );
    panel.append(displayName, email, password, submit);
    return panel;
  }

  private textInput(type: string, placeholder: string): HTMLInputElement {
    const input = document.createElement("input");
    input.type = type;
    input.placeholder = placeholder;
    input.className = "sa-screen-input";
    return input;
  }

  private bigButton(label: string): HTMLButtonElement {
    const b = document.createElement("button");
    b.textContent = label;
    b.className = "sa-screen-btn";
    this.actionButtons.push(b);
    return b;
  }

  private formButton(label: string): HTMLButtonElement {
    const b = document.createElement("button");
    b.textContent = label;
    b.className = "sa-screen-formbtn";
    this.actionButtons.push(b);
    return b;
  }

  private tabButton(label: string): HTMLButtonElement {
    const b = document.createElement("button");
    b.textContent = label;
    b.className = "sa-screen-tab";
    return b;
  }

  private selectTab(tab: Tab): void {
    for (const key of ["login", "register"] as const) {
      const active = key === tab;
      this.panels[key].style.display = active ? "flex" : "none";
      this.tabButtons[key].classList.toggle("active", active);
    }
  }

  private setExpanded(expanded: boolean): void {
    this.expanded = expanded;
    this.formsWrap.classList.toggle("open", expanded);
  }

  /** Opens the panel directly on the Register tab — used for the guest "Upgrade account" flow. */
  showRegisterTab(): void {
    this.setExpanded(true);
    this.selectTab("register");
  }

  /** Opens the panel directly on the Log In tab — used for the Lobby's "Log in / Sign up" link. */
  showLoginTab(): void {
    this.setExpanded(true);
    this.selectTab("login");
  }

  private async run(action: () => Promise<void>): Promise<void> {
    this.setBusy(true);
    this.errorEl.textContent = "";
    try {
      await action();
      this.onAuthed();
    } catch (err) {
      // A refused connection surfaces as a browser-specific TypeError
      // ("NetworkError when attempting to fetch resource.", "Failed to fetch",
      // "Load failed"). That string told the player nothing; every auth path
      // that dies because nothing answered says the same honest sentence, and
      // "Skip (offline practice)" right below is the way out.
      const message = looksLikeServerUnreachable(err)
        ? `${SERVER_OFFLINE_MESSAGE} — you can still Skip to offline practice.`
        : err instanceof ApiRequestError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Something went wrong";
      log.warn("auth action failed", err);
      this.errorEl.textContent = message;
    } finally {
      this.setBusy(false);
    }
  }

  private setBusy(busy: boolean): void {
    for (const b of this.actionButtons) b.disabled = busy;
  }

  show(): void {
    this.root.style.display = "flex";
    this.errorEl.textContent = "";
  }
  hide(): void {
    this.root.style.display = "none";
  }
  dispose(): void {
    this.root.remove();
  }
}

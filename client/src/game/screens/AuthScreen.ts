import { createLogger } from "@space-arena/shared";
import { ApiRequestError, type AuthService } from "../../core/AuthService.js";

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
  ) {
    this.root = document.createElement("div");
    this.root.className = "auth-overlay";
    this.root.style.cssText =
      "position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;" +
      "background:rgba(4,8,16,.92);z-index:30;color:#e8f1ff;font-family:system-ui";

    const title = document.createElement("h1");
    title.textContent = "SPACE ARENA";
    title.style.cssText = "letter-spacing:.3em;font-weight:300;color:#57d8ff;margin:0 0 8px";
    this.root.append(title);

    const guestBtn = this.bigButton("Play as Guest");
    guestBtn.addEventListener("click", () => void this.run(() => this.auth.guest()));
    this.root.append(guestBtn);

    this.errorEl = document.createElement("div");
    this.errorEl.style.cssText = "min-height:1.4em;color:#ff8080;font-size:13px;max-width:320px;text-align:center";
    this.root.append(this.errorEl);

    const toggle = document.createElement("a");
    toggle.href = "#";
    toggle.textContent = "Log in / Register";
    toggle.style.cssText = "color:#57d8ff;text-decoration:underline;cursor:pointer;font-size:13px";
    toggle.addEventListener("click", (e) => {
      e.preventDefault();
      this.setExpanded(!this.expanded);
    });
    this.root.append(toggle);

    this.formsWrap = document.createElement("div");
    this.formsWrap.style.cssText = "display:none;flex-direction:column;align-items:center;gap:10px;width:280px";

    const tabsRow = document.createElement("div");
    tabsRow.style.cssText = "display:flex;gap:8px;width:100%";
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
    skip.style.cssText = "color:#6f84a0;text-decoration:underline;cursor:pointer;font-size:12px;margin-top:8px";
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
    panel.style.cssText = "display:flex;flex-direction:column;gap:8px;width:100%";
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
    panel.style.cssText = "display:flex;flex-direction:column;gap:8px;width:100%";
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
    input.style.cssText =
      "padding:8px 10px;font-size:14px;background:#0c1526;color:#e8f1ff;border:1px solid #2f6fb8;border-radius:6px";
    return input;
  }

  private bigButton(label: string): HTMLButtonElement {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.cssText =
      "min-width:280px;padding:12px 24px;font-size:16px;background:#12203a;color:#e8f1ff;" +
      "border:1px solid #2f6fb8;border-radius:8px;cursor:pointer";
    this.actionButtons.push(b);
    return b;
  }

  private formButton(label: string): HTMLButtonElement {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.cssText =
      "padding:10px;font-size:14px;background:#57d8ff;color:#04101f;font-weight:600;" +
      "border:none;border-radius:6px;cursor:pointer";
    this.actionButtons.push(b);
    return b;
  }

  private tabButton(label: string): HTMLButtonElement {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.cssText =
      "flex:1;padding:6px;font-size:12px;letter-spacing:.04em;text-transform:uppercase;" +
      "background:#0c1526;color:#9fb4d0;border:1px solid #2f6fb8;border-radius:6px;cursor:pointer";
    return b;
  }

  private selectTab(tab: Tab): void {
    for (const key of ["login", "register"] as const) {
      const active = key === tab;
      this.panels[key].style.display = active ? "flex" : "none";
      this.tabButtons[key].style.background = active ? "#1c3a5e" : "#0c1526";
      this.tabButtons[key].style.color = active ? "#e8f1ff" : "#9fb4d0";
    }
  }

  private setExpanded(expanded: boolean): void {
    this.expanded = expanded;
    this.formsWrap.style.display = expanded ? "flex" : "none";
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
      const message =
        err instanceof ApiRequestError ? err.message : err instanceof Error ? err.message : "Something went wrong";
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

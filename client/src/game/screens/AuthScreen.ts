import { createLogger, type ConfigService, type ThemeConfig } from "@space-arena/shared";
import { ApiRequestError, type AuthService } from "../../core/AuthService.js";
import { looksLikeServerUnreachable, SERVER_OFFLINE_MESSAGE } from "../../core/serverHealth.js";
import { applyMenuTheme, createMenuBackdrop, injectScreenStyle } from "./screenStyle.js";

const log = createLogger("AuthScreen");

type Tab = "login" | "register";

/** The form fields, by the name the server's validation errors use for them. */
type FieldName = "identifier" | "displayName" | "email" | "password";

/**
 * A validation failure, aimed at the box that caused it.
 *
 * `field` is null for anything that is about the whole attempt (bad
 * credentials, an unreachable server) rather than about one input.
 */
export interface AuthFieldError {
  field: FieldName | null;
  message: string;
}

/** One built input, plus a live read of what is typed in it. */
interface AuthField {
  wrap: HTMLDivElement;
  readonly value: string;
}

/**
 * Friendly copy for one raw validation string (findings 5 and 6).
 *
 * The server validates with zod and reports the first issue verbatim, prefixed
 * by its path (`server/src/api/http.ts` `parseBody`) — so the player was being
 * shown `password: Too small: expected string to have >=8 characters`, which is
 * a schema's words, not a sentence. Mapping here rather than server-side keeps
 * the API's errors machine-readable for every other consumer and keeps the
 * copy next to the form that has to say it.
 *
 * Unmatched text still reaches the player: an unhelpful message beats a
 * swallowed one, and the field prefix is at least stripped off it.
 */
export function authFieldError(raw: string): AuthFieldError {
  const match = /^([A-Za-z][\w.]*): ([\s\S]+)$/.exec(raw.trim());
  const field = match ? asFieldName(match[1]!) : null;
  const detail = (match && field ? match[2]! : raw).trim();
  return { field, message: friendlyDetail(field, detail) };
}

function asFieldName(path: string): FieldName | null {
  const head = path.split(".")[0];
  return head === "identifier" || head === "displayName" || head === "email" || head === "password"
    ? head
    : null;
}

function friendlyDetail(field: FieldName | null, detail: string): string {
  const tooSmall = /too.?small|at least|>=|minimum/i.test(detail);
  const tooBig = /too.?big|at most|<=|maximum/i.test(detail);
  if (field === "password") {
    if (tooSmall) return "Password needs at least 8 characters";
    if (tooBig) return "That password is too long";
  }
  if (field === "displayName") {
    if (tooSmall) return "Choose a nickname";
    if (tooBig) return "That nickname is too long";
  }
  if (field === "identifier" && tooSmall) return "Enter your nickname (or email)";
  if (field === "email" && /invalid|email|format/i.test(detail)) return "That email address doesn't look right";
  return detail;
}

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
  private readonly submitButtons: Record<Tab, HTMLButtonElement>;
  private readonly actionButtons: HTMLButtonElement[] = [];
  /**
   * One error line per input, keyed `${tab}.${field}` — both forms have a
   * `password`, and an error must land on the one the player is looking at.
   */
  private readonly fieldErrors = new Map<string, HTMLDivElement>();
  /** The "there is more below" mark; the gate scrolls when a form is open. */
  private readonly scrollHint: HTMLDivElement;
  private expanded = false;
  private tab: Tab = "login";

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
    title.textContent = "ORION'S ARM";
    title.className = "sa-screen-title";
    const rule = document.createElement("div");
    rule.className = "sa-menu-rule";
    rule.setAttribute("aria-hidden", "true");
    titleWrap.append(title, rule);
    this.root.append(titleWrap);

    const guestBtn = this.bigButton("Play as Guest");
    guestBtn.addEventListener("click", () => void this.run(this.tab, () => this.auth.guest()));
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

    const login = this.buildLoginForm();
    const register = this.buildRegisterForm();
    this.panels = { login: login.panel, register: register.panel };
    this.submitButtons = { login: login.submit, register: register.submit };
    this.formsWrap.append(login.panel, register.panel);

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

    // The gate is a scroll container (`.sa-screen`) and, on a landscape phone
    // with a form open, it scrolls — silently, because a touch device draws no
    // scrollbar. This is the affordance that says so (finding 4 / match 5).
    this.scrollHint = document.createElement("div");
    this.scrollHint.className = "sa-screen-scrollhint";
    this.scrollHint.setAttribute("aria-hidden", "true");
    this.scrollHint.textContent = "▾ more below";
    this.root.append(this.scrollHint);
    this.root.addEventListener("scroll", () => this.syncScrollHint());
    window.addEventListener("resize", this.onResize);

    this.selectTab("login");
    parent.append(this.root);
    this.syncScrollHint();
  }

  private buildLoginForm(): { panel: HTMLDivElement; submit: HTMLButtonElement } {
    const panel = document.createElement("div");
    panel.className = "sa-screen-panel";
    // Type "text", not "email": accounts registered without an email log in by
    // nickname, and the browser's email validation would reject one.
    const identifier = this.field("login", "identifier", "text", "Nickname or email");
    const password = this.field("login", "password", "password", "Password");
    const submit = this.formButton("Log In");
    submit.addEventListener("click", () => {
      this.clearErrors();
      const id = identifier.value.trim();
      if (!id) {
        this.showError({ field: "identifier", message: "Enter your nickname (or email)" }, "login");
        return;
      }
      void this.run("login", () => this.auth.login(id, password.value));
    });
    panel.append(identifier.wrap, password.wrap, submit);
    return { panel, submit };
  }

  private buildRegisterForm(): { panel: HTMLDivElement; submit: HTMLButtonElement } {
    const panel = document.createElement("div");
    panel.className = "sa-screen-panel";
    const displayName = this.field("register", "displayName", "text", "Nickname");
    const email = this.field("register", "email", "email", "Email (optional)");
    const password = this.field("register", "password", "password", "Password (min 8 chars)");
    const submit = this.formButton("Register");
    submit.addEventListener("click", () => {
      this.clearErrors();
      const nickname = displayName.value.trim();
      // The one field the server cannot invent for us — caught here so the
      // player is told which box is empty instead of reading a 400.
      if (!nickname) {
        this.showError({ field: "displayName", message: "Choose a nickname" }, "register");
        return;
      }
      void this.run("register", () =>
        this.auth.register(nickname, password.value, email.value.trim() || undefined),
      );
    });
    panel.append(displayName.wrap, email.wrap, password.wrap, submit);
    return { panel, submit };
  }

  /**
   * One input and the line that reports what is wrong with IT.
   *
   * The single error line above the form (finding 5) put the complaint between
   * "Play as Guest" and the toggle link — up to a whole form away from the box
   * it was about, and on the register tab it could scroll off while typing.
   */
  private field(tab: Tab, name: FieldName, type: string, placeholder: string): AuthField {
    const wrap = document.createElement("div");
    wrap.className = "sa-screen-field";
    const input = document.createElement("input");
    input.type = type;
    input.placeholder = placeholder;
    input.className = "sa-screen-input";
    input.dataset["field"] = name;
    const error = document.createElement("div");
    error.className = "sa-screen-fielderror";
    error.dataset["fieldError"] = name;
    // Typing is the player answering the complaint; keep it only until then.
    input.addEventListener("input", () => {
      error.textContent = "";
    });
    wrap.append(input, error);
    this.fieldErrors.set(`${tab}.${name}`, error);
    return {
      wrap,
      get value(): string {
        return input.value;
      },
    };
  }

  private bigButton(label: string): HTMLButtonElement {
    const b = document.createElement("button");
    b.textContent = label;
    b.className = "sa-screen-btn sa-button sa-button--secondary";
    this.actionButtons.push(b);
    return b;
  }

  private formButton(label: string): HTMLButtonElement {
    const b = document.createElement("button");
    b.textContent = label;
    b.className = "sa-screen-formbtn sa-button sa-button--primary";
    this.actionButtons.push(b);
    return b;
  }

  private tabButton(label: string): HTMLButtonElement {
    const b = document.createElement("button");
    b.textContent = label;
    b.className = "sa-screen-tab sa-tab";
    return b;
  }

  private selectTab(tab: Tab): void {
    this.tab = tab;
    this.clearErrors();
    for (const key of ["login", "register"] as const) {
      const active = key === tab;
      this.panels[key].style.display = active ? "flex" : "none";
      this.tabButtons[key].classList.toggle("active", active);
    }
    if (this.expanded) this.revealSubmit();
  }

  private setExpanded(expanded: boolean): void {
    this.expanded = expanded;
    this.formsWrap.classList.toggle("open", expanded);
    if (expanded) this.revealSubmit();
    else this.syncScrollHint();
  }

  /**
   * Bring the submit button into view when a form opens.
   *
   * Opening the panel adds ~250 px to a gate that already filled a 412 px
   * landscape viewport, so "LOG IN" landed under the bottom edge with nothing
   * to say the screen had scrolled (finding 4 / match 5). The landscape rhythm
   * in `screenStyle.ts` is what makes the whole gate fit; this is the guarantee
   * that the ACTION is reachable at any size, including the ones nobody
   * measured.
   */
  private revealSubmit(): void {
    const submit = this.submitButtons[this.tab];
    submit.scrollIntoView?.({ block: "nearest" });
    this.syncScrollHint();
  }

  /** Show the "more below" mark only while there is more below. */
  private syncScrollHint(): void {
    const hidden = this.root.scrollHeight - this.root.clientHeight - this.root.scrollTop <= 8;
    this.scrollHint.dataset["visible"] = String(!hidden);
  }

  private readonly onResize = (): void => this.syncScrollHint();

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

  /** Put one complaint where the player can act on it — beside its box, or above the form. */
  private showError(error: AuthFieldError, tab: Tab): void {
    const target = error.field === null ? undefined : this.fieldErrors.get(`${tab}.${error.field}`);
    if (target) target.textContent = error.message;
    else this.errorEl.textContent = error.message;
  }

  private clearErrors(): void {
    this.errorEl.textContent = "";
    for (const el of this.fieldErrors.values()) el.textContent = "";
  }

  private async run(tab: Tab, action: () => Promise<void>): Promise<void> {
    this.setBusy(true);
    this.clearErrors();
    try {
      await action();
      this.onAuthed();
    } catch (err) {
      // A refused connection surfaces as a browser-specific TypeError
      // ("NetworkError when attempting to fetch resource.", "Failed to fetch",
      // "Load failed"). That string told the player nothing; every auth path
      // that dies because nothing answered says the same honest sentence, and
      // "Skip (offline practice)" right below is the way out.
      const error: AuthFieldError = looksLikeServerUnreachable(err)
        ? { field: null, message: `${SERVER_OFFLINE_MESSAGE} — you can still Skip to offline practice.` }
        : err instanceof ApiRequestError
          ? authFieldError(err.message)
          : err instanceof Error
            ? { field: null, message: err.message }
            : { field: null, message: "Something went wrong" };
      log.warn("auth action failed", err);
      this.showError(error, tab);
    } finally {
      this.setBusy(false);
    }
  }

  private setBusy(busy: boolean): void {
    for (const b of this.actionButtons) b.disabled = busy;
  }

  show(): void {
    this.root.style.display = "flex";
    this.clearErrors();
    if (this.expanded) this.revealSubmit();
    else this.syncScrollHint();
  }
  hide(): void {
    this.root.style.display = "none";
  }
  dispose(): void {
    window.removeEventListener("resize", this.onResize);
    this.root.remove();
  }
}

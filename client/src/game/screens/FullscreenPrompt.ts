import { fullscreenSupported, isFullscreen, onFullscreenChange, toggleFullscreen } from "../../core/fullscreen.js";
import { injectScreenStyle } from "./screenStyle.js";

const STYLE_ID = "sa-fullscreen-prompt-style";

const CSS = `
/* SELF-CONTAINED colours, no theme variables.
   This panel is now part of the LAUNCH sequence — it is offered over the
   publisher card, before the content pack (and therefore the theme) has loaded,
   so anything keyed on --sa-menu-* or the design tokens resolves to nothing and
   renders dark-on-dark. Same rule the boot markup in index.html follows, and
   the palette is matched to it so the two read as one screen.
   A theme CAN still tint it once one exists: every value below is a var() with
   a literal terminal fallback rather than a bare literal. */
.sa-fullscreen-prompt {
  position: fixed;
  inset: 0;
  /* Above the launch screen (#sa-boot is 90): the offer is made over the
     publisher card, so it sits on top of it rather than behind it. */
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: rgba(3, 6, 11, 0.72);
  backdrop-filter: blur(3px);
  -webkit-backdrop-filter: blur(3px);
  font-family: var(--sa-menu-font-body, system-ui, -apple-system, "Segoe UI", sans-serif);
}
.sa-fullscreen-prompt-panel {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 14px;
  width: min(360px, 100%);
  padding: 24px 22px 20px;
  box-sizing: border-box;
  background: var(--sa-menu-panel, #0b1522);
  border: 1px solid var(--sa-menu-primary, #3b82f6);
  clip-path: polygon(14px 0%, calc(100% - 14px) 0%, 100% 14px, 100% calc(100% - 14px),
    calc(100% - 14px) 100%, 14px 100%, 0% calc(100% - 14px), 0% 14px);
  color: var(--sa-menu-text, #dbe7f5);
  text-align: center;
}
.sa-fullscreen-prompt-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: .24em;
  text-transform: uppercase;
  color: var(--sa-menu-primary, #4fc3f7);
}
.sa-fullscreen-prompt-text {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--sa-menu-muted, #8ea3bd);
}
/* The two actions carry their own look for the same reason: .sa-screen-btn
   builds its plate from custom properties defined on .sa-screen, which this
   panel is not inside. */
.sa-fullscreen-prompt-go {
  padding: 12px 18px;
  min-height: 44px;
  font: inherit;
  font-size: 12.5px;
  font-weight: 700;
  letter-spacing: .16em;
  text-transform: uppercase;
  color: #061019;
  background: var(--sa-menu-primary, #4fc3f7);
  border: 0;
  cursor: pointer;
  clip-path: polygon(10px 0%, 100% 0%, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0% 100%, 0% 10px);
  transition: filter 140ms ease-out;
}
.sa-fullscreen-prompt-go:hover { filter: brightness(1.12); }
.sa-fullscreen-prompt-skip {
  padding: 4px;
  font: inherit;
  font-size: 12px;
  letter-spacing: .06em;
  color: var(--sa-menu-muted, #8ea3bd);
  background: none;
  border: 0;
  text-decoration: underline;
  text-underline-offset: 3px;
  cursor: pointer;
}
.sa-fullscreen-prompt-skip:hover { color: var(--sa-menu-text, #dbe7f5); }
.sa-fullscreen-prompt :focus-visible { outline: 2px solid var(--sa-menu-primary, #4fc3f7); outline-offset: 2px; }
/* The iOS share glyph, drawn inline so the instruction points at the exact
   button the player has to find in Safari's toolbar. */
.sa-fullscreen-prompt-share {
  display: inline-block;
  width: 14px;
  height: 14px;
  vertical-align: -2px;
  color: var(--sa-menu-primary, #4fc3f7);
}
`;

/**
 * How long "Not now" is honoured, in milliseconds.
 *
 * The offer used to be a boot ritual — asked on every single launch, 7+
 * relaunches deep (playtest finding 2) — because the answer only lived for the
 * page load. Remembering it FOREVER is the other failure: a player who declined
 * once on a laptop never gets offered fullscreen again on the phone where it
 * actually matters. A week makes the offer rare without making it extinct.
 */
export const DECLINE_REMEMBER_MS = 7 * 24 * 60 * 60 * 1000;

const DECLINE_STORAGE_KEY = "sa.fullscreenDeclinedAt";

/** Injected seams so the prompt is unit-testable without a real Fullscreen API. */
export interface FullscreenPromptDeps {
  supported(): boolean;
  active(): boolean;
  request(): Promise<unknown> | void;
  onChange(handler: () => void): () => void;
  /** Epoch ms of the last "Not now", or null if it was never declined. */
  declinedAt(): number | null;
  /** Remember a decline for {@link DECLINE_REMEMBER_MS}. */
  rememberDecline(): void;
}

const browserDeps: FullscreenPromptDeps = {
  supported: fullscreenSupported,
  active: isFullscreen,
  request: () => toggleFullscreen(),
  onChange: onFullscreenChange,
  declinedAt: () => {
    try {
      const raw = localStorage.getItem(DECLINE_STORAGE_KEY);
      if (raw === null) return null;
      const at = Number(raw);
      return Number.isFinite(at) ? at : null;
    } catch {
      // Storage blocked: forget the decline rather than suppress the offer —
      // an offer with an obvious "Not now" is the cheaper of the two mistakes.
      return null;
    }
  },
  rememberDecline: () => {
    try {
      localStorage.setItem(DECLINE_STORAGE_KEY, String(Date.now()));
    } catch {
      /* not remembering is survivable */
    }
  },
};

/**
 * The iPhone escape hatch (owner request 2026-08-23). iPhone Safari has no
 * element fullscreen at all, so where every other browser gets the offer, an
 * iPhone gets a one-time hint pointing at the platform's ONLY route to a
 * chrome-free game: install it (Share → Add to Home Screen; the PWA manifest
 * already launches standalone). Injected as its own seam because the four
 * answers come from four different browser surfaces.
 */
export interface IosHintDeps {
  /** iPhone/iPod specifically — iPad HAS the Fullscreen API and gets the offer. */
  isIphone(): boolean;
  /** Already launched from the Home Screen: the hint would be noise. */
  installed(): boolean;
  hintShown(): boolean;
  markHintShown(): void;
}

const HINT_STORAGE_KEY = "sa.iosFullscreenHint";

const browserIosDeps: IosHintDeps = {
  isIphone: () => /iPhone|iPod/.test(navigator.userAgent),
  installed: () =>
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true,
  hintShown: () => {
    try {
      return localStorage.getItem(HINT_STORAGE_KEY) === "1";
    } catch {
      return true; // storage blocked: err on silence rather than nag every load
    }
  },
  markHintShown: () => {
    try {
      localStorage.setItem(HINT_STORAGE_KEY, "1");
    } catch {
      /* not remembering is survivable */
    }
  },
};

/** Safari's share glyph (square, arrow up), the button the hint points at. */
const SHARE_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M8 8h-2a1 1 0 0 0 -1 1v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-11a1 1 0 0 0 -1-1h-2"/>' +
  '<path d="M12 14v-11m-4 4l4-4 4 4"/></svg>';

/**
 * One-shot launch dialog offering fullscreen (owner request 2026-07-31). The
 * Fullscreen API only works from a user gesture, so a page cannot simply go
 * fullscreen on load — this popup IS the gesture: its "go fullscreen" button
 * makes the request, "not now" dismisses for the rest of the page load.
 *
 * Skipped entirely when the API is unsupported (iPhone Safari) or the page is
 * somehow already fullscreen; auto-dismissed if fullscreen is entered by other
 * means (the Settings toggle, F11-driven `fullscreenchange`) while it shows.
 */
export class FullscreenPrompt {
  /**
   * Resolves once the player has answered — either way, and including the case
   * where they went fullscreen by some other route. The launch sequence waits
   * on this before handing over to the menu, so the game is never revealed
   * underneath an unanswered dialog.
   */
  readonly closed: Promise<void>;
  private resolveClosed!: () => void;
  private readonly root: HTMLDivElement;
  private readonly offChange: () => void;

  private constructor(parent: HTMLElement, deps: FullscreenPromptDeps, mode: "offer" | "ios-hint") {
    this.closed = new Promise<void>((resolve) => {
      this.resolveClosed = resolve;
    });
    injectScreenStyle();
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    this.root = document.createElement("div");
    this.root.className = "sa-fullscreen-prompt";
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-modal", "true");
    this.root.setAttribute("aria-label", "Fullscreen");

    const panel = document.createElement("div");
    panel.className = "sa-fullscreen-prompt-panel";

    const title = document.createElement("h2");
    title.className = "sa-fullscreen-prompt-title";

    const text = document.createElement("p");
    text.className = "sa-fullscreen-prompt-text";

    if (mode === "ios-hint") {
      // No action button CAN work here: a web page cannot open the share sheet,
      // so the honest shape is an instruction and one acknowledgement.
      title.textContent = "Play fullscreen";
      text.innerHTML =
        "iPhone Safari can't fullscreen a web game. Install it instead: tap " +
        `<span class="sa-fullscreen-prompt-share">${SHARE_SVG}</span> ` +
        "Share, then “Add to Home Screen” — launched from there, " +
        "Orion's Arm runs fullscreen.";

      const ok = document.createElement("button");
      ok.type = "button";
      ok.className = "sa-fullscreen-prompt-go";
      ok.textContent = "Got it";
      ok.addEventListener("click", () => this.dismiss());

      panel.append(title, text, ok);
      this.root.appendChild(panel);
      parent.appendChild(this.root);
      // Nothing external can answer this one — there is no fullscreen to enter.
      this.offChange = () => {};
      return;
    }

    title.textContent = "Go fullscreen?";
    text.textContent = "Orion's Arm plays best without the browser chrome.";

    const go = document.createElement("button");
    go.type = "button";
    go.className = "sa-fullscreen-prompt-go";
    go.textContent = "Go fullscreen";
    go.addEventListener("click", () => {
      void deps.request();
      this.dismiss();
    });

    const skip = document.createElement("button");
    skip.type = "button";
    skip.className = "sa-fullscreen-prompt-skip";
    skip.textContent = "Not now";
    skip.addEventListener("click", () => {
      // Only the explicit NO is remembered. Accepting settles nothing durable —
      // fullscreen is browser state that Esc drops, so the next launch is
      // entitled to ask again — and neither is a dismissal that came from the
      // player reaching fullscreen some other way.
      deps.rememberDecline();
      this.dismiss();
    });

    panel.append(title, text, go, skip);
    this.root.appendChild(panel);
    parent.appendChild(this.root);

    // Entering fullscreen any other way answers the question.
    this.offChange = deps.onChange(() => {
      if (deps.active()) this.dismiss();
    });
  }

  /**
   * Show the prompt if fullscreen is possible, not already engaged, and not
   * declined within the last {@link DECLINE_REMEMBER_MS} — or, on an iPhone
   * (where fullscreen never is possible), the one-time Add-to-Home-Screen hint
   * that stands in for it. The hint is marked shown at SHOW time, so a
   * mid-dialog reload does not turn "once" into "every launch".
   */
  static maybeShow(
    parent: HTMLElement = document.body,
    deps: FullscreenPromptDeps = browserDeps,
    ios: IosHintDeps = browserIosDeps,
  ): FullscreenPrompt | null {
    if (deps.active()) return null;
    if (deps.supported()) return declinedRecently(deps) ? null : new FullscreenPrompt(parent, deps, "offer");
    if (!ios.isIphone() || ios.installed() || ios.hintShown()) return null;
    ios.markHintShown();
    return new FullscreenPrompt(parent, deps, "ios-hint");
  }

  /** Whether the dialog is still in the DOM (tests / dev probe). */
  get visible(): boolean {
    return this.root.isConnected;
  }

  dismiss(): void {
    this.offChange();
    this.root.remove();
    this.resolveClosed();
  }
}

/**
 * Is a stored "Not now" still standing?
 *
 * A stamp from the FUTURE means the clock moved backwards since it was written
 * (a device that had the wrong date, a timezone-naive system clock), and a
 * decline we could not have recorded yet is not one to honour — asking again is
 * the recoverable direction.
 */
function declinedRecently(deps: FullscreenPromptDeps): boolean {
  const declinedAt = deps.declinedAt();
  if (declinedAt === null) return false;
  const age = Date.now() - declinedAt;
  return age >= 0 && age < DECLINE_REMEMBER_MS;
}

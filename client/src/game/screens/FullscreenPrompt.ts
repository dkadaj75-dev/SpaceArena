import { fullscreenSupported, isFullscreen, onFullscreenChange, toggleFullscreen } from "../../core/fullscreen.js";
import { injectScreenStyle } from "./screenStyle.js";

const STYLE_ID = "sa-fullscreen-prompt-style";

const CSS = `
.sa-fullscreen-prompt {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: rgba(3, 8, 18, 0.55);
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
}
.sa-fullscreen-prompt-panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  width: min(340px, 100%);
  padding: 22px 20px 18px;
  box-sizing: border-box;
  background: #0b1526ee;
  border: 1px solid color-mix(in srgb, var(--sa-menu-primary, #39bfff) 40%, transparent);
  clip-path: polygon(12px 0%, calc(100% - 12px) 0%, 100% 12px, 100% calc(100% - 12px),
    calc(100% - 12px) 100%, 12px 100%, 0% calc(100% - 12px), 0% 12px);
  color: var(--sa-menu-text, #dbe9ff);
  font-family: var(--sa-menu-font-body, system-ui, sans-serif);
  text-align: center;
}
.sa-fullscreen-prompt-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: .24em;
  text-transform: uppercase;
  color: var(--sa-menu-primary, #39bfff);
}
.sa-fullscreen-prompt-text {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--sa-menu-muted, #9fb4d0);
}
`;

/** Injected seams so the prompt is unit-testable without a real Fullscreen API. */
export interface FullscreenPromptDeps {
  supported(): boolean;
  active(): boolean;
  request(): Promise<unknown> | void;
  onChange(handler: () => void): () => void;
}

const browserDeps: FullscreenPromptDeps = {
  supported: fullscreenSupported,
  active: isFullscreen,
  request: () => toggleFullscreen(),
  onChange: onFullscreenChange,
};

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
  private readonly root: HTMLDivElement;
  private readonly offChange: () => void;

  private constructor(parent: HTMLElement, deps: FullscreenPromptDeps) {
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
    title.textContent = "Go fullscreen?";

    const text = document.createElement("p");
    text.className = "sa-fullscreen-prompt-text";
    text.textContent = "Space Arena plays best without the browser chrome.";

    const go = document.createElement("button");
    go.className = "sa-screen-btn sa-screen-btn--primary";
    go.textContent = "GO FULLSCREEN";
    go.addEventListener("click", () => {
      void deps.request();
      this.dismiss();
    });

    const skip = document.createElement("span");
    skip.className = "sa-screen-link muted";
    skip.textContent = "Not now";
    skip.addEventListener("click", () => this.dismiss());

    panel.append(title, text, go, skip);
    this.root.appendChild(panel);
    parent.appendChild(this.root);

    // Entering fullscreen any other way answers the question.
    this.offChange = deps.onChange(() => {
      if (deps.active()) this.dismiss();
    });
  }

  /** Show the prompt if fullscreen is possible and not already engaged. */
  static maybeShow(parent: HTMLElement = document.body, deps: FullscreenPromptDeps = browserDeps): FullscreenPrompt | null {
    if (!deps.supported() || deps.active()) return null;
    return new FullscreenPrompt(parent, deps);
  }

  /** Whether the dialog is still in the DOM (tests / dev probe). */
  get visible(): boolean {
    return this.root.isConnected;
  }

  dismiss(): void {
    this.offChange();
    this.root.remove();
  }
}

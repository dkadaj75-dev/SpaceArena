import type { TutorialHighlight } from "@space-arena/shared";
import type { TutorialStepView } from "./TutorialDirector.js";

const STYLE_ID = "sa-tutorial-style";

/**
 * How often the ring re-measures the control it is pointing at. The HUD moves
 * its widgets on rotation and on a mobile URL-bar collapse, and the hangar
 * re-renders its slot grid on every fit — polling one `getBoundingClientRect`
 * five times a second is cheaper than subscribing to all of that, and cannot go
 * stale in a way the player would notice.
 */
const SYNC_INTERVAL_MS = 200;

/**
 * A LOGICAL highlight target → the DOM it means today, most specific first.
 *
 * This map is the whole reason content names affordances instead of selectors
 * (see `tutorialHighlight` in the schema): when a widget's class changes, this
 * one table changes with it and every content pack keeps working. A target with
 * no visible match simply draws no ring — a missing coach mark must never stop
 * a step the player can still perform.
 */
const HIGHLIGHT_SELECTORS: Record<TutorialHighlight, readonly string[]> = {
  throttle: [".hud-throttle-track"],
  steer: [".hud-joystick-base"],
  // The FIRE button is gone (2026-08-21). "fire" now names the pilot's PRIMARY
  // weapon — the pedestal that inherited its footprint — falling back to any
  // weapon trigger on a fitting whose rail has not been laid out yet.
  // The weapon slots, right-hand cluster. The FIRE pedestal it used to prefer
  // is gone (2026-08-21): every weapon is one uniform slot, so slot 01 — the
  // first `.trigger` in the DOM — IS the primary gun.
  fire: [".hud-module-btn.trigger"],
  // The hexes themselves: `.hud-modules` is a zero-size anchor pivot.
  modules: [".hud-module-btn"],
  reticle: [".hud-reticle-zone", ".hud-reticle"],
  minimap: [".hud-minimap"],
  "lobby-hangar": ['[data-lobby-action="hangar"]'],
  "lobby-shop": ['[data-lobby-action="shop"]'],
  // The EMPTY socket is the one the lesson is about; a fully fitted hull falls
  // back to any slot, because the lesson then is "swap something".
  "hangar-slots": [".hangar-slot:not(.filled)", ".hangar-slot"],
  "hangar-modules": [".hangar-panel"],
  "shop-tabs": [".shop-tabs"],
  "shop-buy": [".shop-buy"],
};

export interface TutorialOverlayCallbacks {
  onSkip: () => void;
  onConfirm: () => void;
}

/**
 * The coach mark: one instructor card and one ring, over everything.
 *
 * Non-blocking by construction — the root is `pointer-events: none` and only
 * the two buttons opt back in — because every step but the last is completed by
 * touching the very controls this thing sits on top of.
 */
export class TutorialOverlay {
  private readonly root: HTMLDivElement;
  private readonly card: HTMLDivElement;
  private readonly badge: HTMLSpanElement;
  private readonly counter: HTMLSpanElement;
  private readonly titleEl: HTMLDivElement;
  private readonly textEl: HTMLDivElement;
  private readonly hintEl: HTMLDivElement;
  private readonly confirmBtn: HTMLButtonElement;
  private readonly skipBtn: HTMLButtonElement;
  private readonly ring: HTMLDivElement;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private highlight: TutorialHighlight | undefined;
  /** The current step's hint, held so the ring poll can decide whether to show it. */
  private hint = "";

  constructor(parent: HTMLElement, callbacks: TutorialOverlayCallbacks) {
    injectTutorialStyle();

    this.root = document.createElement("div");
    this.root.className = "sa-tutorial";
    this.root.dataset["tutorial"] = "";

    this.ring = document.createElement("div");
    this.ring.className = "sa-tutorial-ring";
    this.ring.setAttribute("aria-hidden", "true");

    this.card = document.createElement("div");
    this.card.className = "sa-tutorial-card";
    this.card.setAttribute("role", "status");
    this.card.setAttribute("aria-live", "polite");

    const head = document.createElement("div");
    head.className = "sa-tutorial-head";
    this.badge = document.createElement("span");
    this.badge.className = "sa-tutorial-badge";
    this.counter = document.createElement("span");
    this.counter.className = "sa-tutorial-counter";
    head.append(this.badge, this.counter);

    this.titleEl = document.createElement("div");
    this.titleEl.className = "sa-tutorial-title";
    this.textEl = document.createElement("div");
    this.textEl.className = "sa-tutorial-text";
    this.hintEl = document.createElement("div");
    this.hintEl.className = "sa-tutorial-hint";

    const actions = document.createElement("div");
    actions.className = "sa-tutorial-actions";
    this.confirmBtn = document.createElement("button");
    this.confirmBtn.type = "button";
    this.confirmBtn.className = "sa-button sa-button--primary sa-tutorial-confirm";
    this.confirmBtn.textContent = "Got it";
    this.confirmBtn.dataset["tutorialConfirm"] = "";
    this.confirmBtn.addEventListener("click", () => callbacks.onConfirm());
    this.skipBtn = document.createElement("button");
    this.skipBtn.type = "button";
    this.skipBtn.className = "sa-tutorial-skip";
    this.skipBtn.textContent = "Skip tutorial";
    this.skipBtn.dataset["tutorialSkip"] = "";
    this.skipBtn.addEventListener("click", () => callbacks.onSkip());
    actions.append(this.confirmBtn, this.skipBtn);

    this.card.append(head, this.titleEl, this.textEl, this.hintEl, actions);
    this.root.append(this.ring, this.card);
    parent.append(this.root);
    this.root.style.display = "none";
  }

  /** Draw `view`, or clear the overlay entirely when passed `null`. */
  present(view: TutorialStepView | null): void {
    if (!view) {
      this.root.style.display = "none";
      this.stopSync();
      return;
    }
    this.root.style.display = "";
    this.root.dataset["stage"] = view.stage;
    this.badge.textContent = view.instructor;
    this.counter.textContent = `Step ${view.index} / ${view.total}`;
    this.titleEl.textContent = view.title;
    this.textEl.textContent = view.text;
    this.hint = view.hint ?? "";
    this.hintEl.textContent = this.hint;
    this.confirmBtn.style.display = view.confirmable ? "" : "none";
    // Re-triggered per step so the card punches in again rather than silently
    // swapping its words: the instruction changing IS the event.
    this.card.classList.remove("enter");
    void this.card.offsetWidth;
    this.card.classList.add("enter");
    this.highlight = view.highlight;
    this.syncRing();
    this.startSync();
  }

  /**
   * Re-measure the highlighted control, move the ring onto it, and decide
   * whether the step's hint is currently TRUE. Public so a caller with a better
   * clock than the poll (a resize handler, a test) can force it.
   */
  syncRing(): void {
    const rect = this.highlight ? highlightRect(HIGHLIGHT_SELECTORS[this.highlight]) : null;
    // A hint that points ("Drag the throttle on the right") is a lie while the
    // thing it points at is not on screen — step 1 said exactly that during the
    // countdown, when the throttle strip is still a 0x0 box (finding 55). Held
    // back until the control exists; the poll raises it the moment it does. A
    // hint on a step that points at NOTHING is general advice, and always shows.
    const pointing = this.highlight !== undefined;
    const showHint = this.hint !== "" && (!pointing || rect !== null);
    this.hintEl.style.display = showHint ? "" : "none";
    if (!rect) {
      this.ring.style.display = "none";
      return;
    }
    // A ring that hugs the control reads as a border; one that stands off it
    // reads as a pointer. The pad is what makes it the second thing.
    const pad = 10;
    this.ring.style.display = "";
    this.ring.style.left = `${rect.left - pad}px`;
    this.ring.style.top = `${rect.top - pad}px`;
    this.ring.style.width = `${rect.width + pad * 2}px`;
    this.ring.style.height = `${rect.height + pad * 2}px`;
  }

  private startSync(): void {
    if (this.syncTimer !== null) return;
    this.syncTimer = setInterval(() => this.syncRing(), SYNC_INTERVAL_MS);
  }

  private stopSync(): void {
    if (this.syncTimer !== null) clearInterval(this.syncTimer);
    this.syncTimer = null;
  }

  dispose(): void {
    this.stopSync();
    this.root.remove();
  }
}

/**
 * The one-line sign-off, raised on the SHOP screen where the HUD's own toast
 * queue does not exist. Same card language as the coach mark, deliberately: the
 * instructor's last word should look like their first one.
 */
export function showTutorialToast(text: string, durationMs = 4200): HTMLDivElement {
  injectTutorialStyle();
  const el = document.createElement("div");
  el.className = "sa-tutorial-toast";
  el.dataset["tutorialToast"] = "";
  el.setAttribute("role", "status");
  el.textContent = text;
  document.body.append(el);
  setTimeout(() => el.remove(), durationMs);
  return el;
}

/**
 * The box to ring: the UNION of everything the first productive selector
 * matches, or null when nothing it names is on screen.
 *
 * A union rather than the first match because several logical targets are a
 * CLUSTER, not a control — the module hexes are individual buttons hung off a
 * zero-size pivot, and ringing only the first of them would point at the laser
 * while the instructor is talking about the shield.
 */
function highlightRect(selectors: readonly string[]): { left: number; top: number; width: number; height: number } | null {
  for (const selector of selectors) {
    let left = Number.POSITIVE_INFINITY;
    let top = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;
    for (const el of document.querySelectorAll<HTMLElement>(selector)) {
      const rect = el.getBoundingClientRect();
      // Zero-size matches are pivots and placeholders, never things to point at.
      if (rect.width <= 0 || rect.height <= 0) continue;
      left = Math.min(left, rect.left);
      top = Math.min(top, rect.top);
      right = Math.max(right, rect.left + rect.width);
      bottom = Math.max(bottom, rect.top + rect.height);
    }
    if (left < right && top < bottom) return { left, top, width: right - left, height: bottom - top };
  }
  return null;
}

export function injectTutorialStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

/**
 * Design-system only: every colour, face and radius below is a `--sa-*` token
 * published on `:root` by `main.ts`, so the coach mark re-themes with the rest
 * of the game and never carries a hex of its own.
 */
const CSS = `
/* Z-ORDER. The coach mark is the least important thing on screen: it is a
   caption over whatever the player is doing, and it sat at 45 — above the
   match-loading panel (26) and above the settings sheet (40), so "PREPARING
   ARENA" and "Resume match" were both read through it (findings 52, 53).
   25 puts it over the HUD (10) and the lobby (20) and under both of those.
   The SHOP is the one screen it must out-rank, because its steps point at that
   screen's own controls, and that screen is a full-page overlay at 30. */
.sa-tutorial {
  position: fixed;
  inset: 0;
  z-index: 25;
  /* The mark sits ON the controls it is teaching — it must never eat a tap. */
  pointer-events: none;
  font: var(--sa-type-body);
  color: var(--sa-white);
}
.sa-tutorial[data-stage="shop"] { z-index: 35; }
.sa-tutorial-ring {
  position: fixed;
  border: var(--sa-line-thin) solid var(--sa-blue-500);
  border-radius: var(--sa-radius-large);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--sa-n-900) 65%, transparent),
              0 0 18px color-mix(in srgb, var(--sa-blue-500) 70%, transparent);
  animation: sa-tutorial-pulse 1.4s ease-in-out infinite;
  transition: left 140ms ease, top 140ms ease, width 140ms ease, height 140ms ease;
}
@keyframes sa-tutorial-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
}
/* Anchored to the TOP-LEFT corner, not floated in the middle. Centred and
   lifted off the bottom edge, the card landed at 520x178 in the dead centre of
   a 915x412 viewport — directly over the player's own ship, so every
   instruction hid the thing it was instructing (finding 54). A corner is the
   one place a caption can live without covering the subject: narrower, out of
   the way of the stick (bottom-left) and the module hexes (right), and always
   in the same place from step to step. */
.sa-tutorial-card {
  position: absolute;
  left: max(env(safe-area-inset-left, 0px), 12px);
  top: calc(env(safe-area-inset-top, 0px) + 12px);
  width: min(340px, calc(100vw - 24px));
  box-sizing: border-box;
  padding: 12px 16px 14px;
  background: color-mix(in srgb, var(--sa-n-800) 92%, transparent);
  border: var(--sa-line-hairline) solid color-mix(in srgb, var(--sa-blue-500) 55%, transparent);
  border-left: var(--sa-line-strong) solid var(--sa-blue-500);
  border-radius: var(--sa-radius-medium);
  box-shadow: 0 10px 30px color-mix(in srgb, var(--sa-n-900) 80%, transparent);
}
/* In flight the top-left corner carries the HUD's own readouts: clear them. */
.sa-tutorial[data-stage="flight"] .sa-tutorial-card {
  top: calc(env(safe-area-inset-top, 0px) + 56px);
}
.sa-tutorial-card.enter { animation: sa-tutorial-in 220ms ease-out both; }
@keyframes sa-tutorial-in {
  from { opacity: 0; transform: translateX(-10px); }
  to { opacity: 1; transform: none; }
}
.sa-tutorial-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}
.sa-tutorial-badge {
  font: var(--sa-type-caption);
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--sa-blue-500);
}
.sa-tutorial-counter {
  font: var(--sa-type-caption);
  letter-spacing: 0.1em;
  color: var(--sa-n-400);
}
.sa-tutorial-title {
  font: var(--sa-type-h3);
  letter-spacing: 0.16em;
  text-transform: uppercase;
  margin-top: 6px;
}
.sa-tutorial-text {
  font: var(--sa-type-body);
  margin-top: 2px;
  line-height: 1.35;
}
.sa-tutorial-hint {
  font: var(--sa-type-caption);
  margin-top: 6px;
  color: var(--sa-n-400);
}
.sa-tutorial-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  margin-top: 10px;
}
.sa-tutorial-actions > * { pointer-events: auto; }
.sa-tutorial-confirm { min-height: 40px; padding: 0 20px; }
.sa-tutorial-skip {
  background: none;
  border: none;
  padding: 8px 4px;
  font: var(--sa-type-caption);
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--sa-n-400);
  cursor: pointer;
}
.sa-tutorial-skip:hover { color: var(--sa-white); }
.sa-tutorial-toast {
  position: fixed;
  left: 50%;
  transform: translateX(-50%);
  top: calc(env(safe-area-inset-top, 0px) + 18px);
  z-index: 60;
  max-width: min(520px, calc(100vw - 32px));
  padding: 10px 18px;
  font: var(--sa-type-body);
  color: var(--sa-white);
  background: color-mix(in srgb, var(--sa-n-800) 94%, transparent);
  border: var(--sa-line-hairline) solid var(--sa-blue-500);
  border-radius: var(--sa-radius-medium);
  box-shadow: 0 8px 24px color-mix(in srgb, var(--sa-n-900) 80%, transparent);
  animation: sa-tutorial-in 220ms ease-out both;
  pointer-events: none;
}
`;

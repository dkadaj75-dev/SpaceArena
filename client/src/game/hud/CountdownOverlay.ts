import type { Snapshot } from "@space-arena/shared";

/**
 * How long the "GO" flash stays up after the countdown reaches zero, in ms. Not
 * a theme knob: it is the tail of a one-shot animation whose duration is set in
 * `hudStyle.ts`, and the two have to agree.
 */
const GO_HOLD_MS = 700;

/** Text shown when the countdown hits zero. */
const GO_TEXT = "GO";

/**
 * Match-start countdown: big centre-screen numerals counting 3 → 2 → 1 → GO.
 *
 * Reads `snapshot.countdownRemaining` and NOTHING else — no local timer. That
 * matters more than it looks: online, the value is written by the server from the
 * authoritative sim (`ArenaState.countdownRemaining`), so both players see the
 * same numeral on the same beat and the match genuinely starts together. A
 * client-side timer started on "match found" would drift by exactly the two
 * players' latency difference, which is the bug this feature exists to prevent.
 *
 * Ceil, not round: `2.4 s` left is still "3" on screen, so each numeral is shown
 * for a full second and the "1" does not vanish early.
 *
 * DOM-frugal like the rest of the HUD: one element, and `textContent`/class are
 * written only when the displayed value actually changes, so the per-frame cost
 * during (and after) the countdown is two comparisons.
 */
export class CountdownOverlay {
  private readonly el: HTMLDivElement;
  /** Last value written to the DOM; `null` before anything has been shown. */
  private shown: string | null = null;
  /** Countdown seconds ceil'd, from the previous frame (-1 = not seen yet). */
  private lastCeil = -1;
  /** Remaining hold on the "GO" flash, ms; 0 when idle. */
  private goHoldMs = 0;

  constructor(root: HTMLElement) {
    this.el = document.createElement("div");
    this.el.className = "hud-countdown";
    // Announced politely rather than assertively: it is a rhythmic three-beat
    // cue, and an assertive live region would interrupt itself every second.
    this.el.setAttribute("aria-live", "polite");
    root.appendChild(this.el);
  }

  update(cur: Snapshot, dtMs: number): void {
    if (cur.phase === "countdown" && cur.countdownRemaining > 0) {
      // Whole seconds remaining. Re-arm the GO flash on every countdown frame so
      // a rematch (or a fresh room) plays it again without any explicit reset.
      this.goHoldMs = GO_HOLD_MS;
      const ceil = Math.ceil(cur.countdownRemaining);
      this.lastCeil = ceil;
      this.show(String(ceil));
      return;
    }

    // Zero reached. Flash GO for its hold, then get out of the player's way.
    // Gated on having actually SEEN a countdown, so a mode with
    // `matchCountdownSec: 0` (and a HUD mounted mid-match) never flashes.
    if (this.goHoldMs > 0 && this.lastCeil > 0) {
      this.goHoldMs = Math.max(0, this.goHoldMs - dtMs);
      this.show(GO_TEXT);
      if (this.goHoldMs > 0) return;
      this.lastCeil = -1;
    }
    this.show(null);
  }

  /**
   * Write the overlay's text, or hide it with `null`. The class flip drives the
   * per-value scale/fade animation in CSS: re-setting `textContent` alone would
   * not restart a running animation, so the element is toggled through the
   * hidden state's `display:none`, which does.
   */
  private show(text: string | null): void {
    if (text === this.shown) return;
    this.shown = text;
    if (text === null) {
      this.el.classList.remove("visible", "go");
      this.el.textContent = "";
      return;
    }
    this.el.textContent = text;
    this.el.classList.toggle("go", text === GO_TEXT);
    // Force a reflow between removing and adding the class so the keyframe
    // animation replays for each numeral instead of only for the first.
    this.el.classList.remove("visible");
    void this.el.offsetWidth;
    this.el.classList.add("visible");
  }

  /** Current on-screen text, or null when hidden (test hook). */
  get currentText(): string | null {
    return this.shown;
  }

  dispose(): void {
    this.el.remove();
  }
}

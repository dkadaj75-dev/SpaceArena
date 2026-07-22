import type { EntityId, SimEvent } from "@space-arena/shared";

const VIGNETTE_MS = 350;
const HITMARKER_MS = 250;

/**
 * Damage feedback (§6 1.8): a brief red vignette flash when the player takes
 * damage, and a small hit marker near screen-center when the player's own
 * shots land. Both are pure CSS animations restarted via reflow — no
 * per-frame work beyond a countdown.
 */
export class DamageFeedback {
  private readonly vignette: HTMLDivElement;
  private readonly hitmarker: HTMLDivElement;
  private vignetteMs = 0;
  private hitmarkerMs = 0;

  constructor(root: HTMLElement, private readonly playerId: EntityId) {
    this.vignette = document.createElement("div");
    this.vignette.className = "hud-vignette";
    root.appendChild(this.vignette);

    this.hitmarker = document.createElement("div");
    this.hitmarker.className = "hud-hitmarker";
    root.appendChild(this.hitmarker);
  }

  consumeEvents(events: readonly SimEvent[]): void {
    for (let i = 0; i < events.length; i++) {
      const ev = events[i]!;
      if (ev.type !== "damage") continue;
      if (ev.targetId === this.playerId) {
        this.flashVignette();
      } else if (ev.sourceId === this.playerId) {
        this.popHitmarker();
      }
    }
  }

  private flashVignette(): void {
    this.vignette.classList.remove("flash");
    // Force reflow so the animation restarts even if it's still playing.
    void this.vignette.offsetWidth;
    this.vignette.classList.add("flash");
    this.vignetteMs = VIGNETTE_MS;
  }

  private popHitmarker(): void {
    this.hitmarker.classList.remove("show");
    void this.hitmarker.offsetWidth;
    this.hitmarker.classList.add("show");
    this.hitmarkerMs = HITMARKER_MS;
  }

  update(dtMs: number): void {
    if (this.vignetteMs > 0) {
      this.vignetteMs -= dtMs;
      if (this.vignetteMs <= 0) this.vignette.classList.remove("flash");
    }
    if (this.hitmarkerMs > 0) {
      this.hitmarkerMs -= dtMs;
      if (this.hitmarkerMs <= 0) this.hitmarker.classList.remove("show");
    }
  }

  dispose(): void {
    this.vignette.remove();
    this.hitmarker.remove();
  }
}

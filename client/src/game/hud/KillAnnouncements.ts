import type { EntityId, SimEvent } from "@space-arena/shared";

/**
 * Transient centre-screen kill announcements (owner 2026-07-31), League style:
 * a plain frag flashes "DESTROYED!", the first kill of the whole match flashes
 * "FIRST BLOOD", and chained frags escalate DOUBLE KILL → TRIPLE KILL →
 * QUADRA KILL → PENTA KILL. Only the PLAYER's own frags announce; kills by
 * bots and allies advance nothing here except the match's first-blood flag
 * (first blood is a property of the match, not of the player).
 *
 * Pure parts (`advanceStreak`, `announcementFor`) are exported for unit tests;
 * the component itself only owns a DOM node whose CSS animation does the
 * pop-and-fade, restarted per announcement.
 */

/** Chained frags count as a streak while spaced at most this far apart. */
export const MULTI_KILL_WINDOW_MS = 10_000;

/** How long one announcement stays on screen (mirrored by the CSS animation). */
export const ANNOUNCE_MS = 1_800;

export interface KillStreakState {
  /** Frags in the current chain (0 = none yet). */
  count: number;
  /** Render-clock timestamp of the chain's last frag. */
  lastKillMs: number;
}

/**
 * Fold one player frag into the streak: within the window the chain grows,
 * otherwise it restarts at 1. Returns the chain length THIS frag reached.
 */
export function advanceStreak(state: KillStreakState, nowMs: number): number {
  state.count = state.count > 0 && nowMs - state.lastKillMs <= MULTI_KILL_WINDOW_MS ? state.count + 1 : 1;
  state.lastKillMs = nowMs;
  return state.count;
}

/**
 * The text for a player frag. First blood outranks everything — it can only
 * ever coincide with a chain of 1, since it is by definition the match's first
 * kill. Chains past five stay "PENTA KILL"; the game has eight pilots at most.
 */
export function announcementFor(streakCount: number, firstBloodOfMatch: boolean): string {
  if (firstBloodOfMatch) return "FIRST BLOOD";
  if (streakCount <= 1) return "DESTROYED!";
  if (streakCount === 2) return "DOUBLE KILL";
  if (streakCount === 3) return "TRIPLE KILL";
  if (streakCount === 4) return "QUADRA KILL";
  return "PENTA KILL";
}

/** CSS class per announcement flavour (colors live in the stylesheet). */
export function announcementClass(streakCount: number, firstBloodOfMatch: boolean): string {
  if (firstBloodOfMatch) return "first-blood";
  return streakCount > 1 ? "multi" : "plain";
}

export class KillAnnouncements {
  private readonly el: HTMLDivElement;
  private readonly streak: KillStreakState = { count: 0, lastKillMs: Number.NEGATIVE_INFINITY };
  /** True once ANY ship in the match has died — first blood is match-global. */
  private matchHasBlood = false;

  constructor(root: HTMLElement, private readonly playerId: EntityId) {
    this.el = document.createElement("div");
    this.el.className = "hud-kill-announce";
    this.el.setAttribute("aria-live", "polite");
    root.appendChild(this.el);
  }

  /** Feed the frame's drained sim events. `nowMs` is injectable for tests. */
  consumeEvents(events: readonly SimEvent[], nowMs: number = performance.now()): void {
    for (const ev of events) {
      if (ev.type !== "entityDestroyed" || ev.isAsteroid) continue;
      const firstBlood = !this.matchHasBlood;
      this.matchHasBlood = true;
      if (ev.killerId !== this.playerId || ev.entityId === this.playerId) continue;
      const count = advanceStreak(this.streak, nowMs);
      this.show(announcementFor(count, firstBlood), announcementClass(count, firstBlood));
    }
  }

  /** New match in the same HUD (respawn does NOT reset this — only a new match). */
  reset(): void {
    this.streak.count = 0;
    this.streak.lastKillMs = Number.NEGATIVE_INFINITY;
    this.matchHasBlood = false;
    this.el.classList.remove("visible", "plain", "multi", "first-blood");
  }

  /** Currently displayed announcement text (tests / dev probe). */
  get currentText(): string {
    return this.el.textContent ?? "";
  }

  private show(text: string, flavour: string): void {
    this.el.textContent = text;
    this.el.classList.remove("visible", "plain", "multi", "first-blood");
    // Force a style flush so re-adding the class restarts the CSS animation
    // even when two frags land on consecutive frames.
    void this.el.offsetWidth;
    this.el.classList.add("visible", flavour);
  }

  dispose(): void {
    this.el.remove();
  }
}

import type { EntityId, Snapshot } from "@space-arena/shared";
import type { GameSession } from "../GameSession.js";
import { COUNT_UP_DURATION_MS, countUpDone, countUpValue } from "./countUp.js";
import { selectMvp } from "./matchPresentation.js";

/** Per-player progression summary (matches the net `matchRewards` message). */
export interface MatchRewards {
  credits: number;
  xp: number;
  newLevel: number;
  leveledUp: boolean;
}

/** What the results screen can send the player to next. */
export interface ResultsCallbacks {
  /** Restart the same kind of match (rebuilds the runtime from scratch). */
  onPlayAgain: () => void;
  /** Legacy callback accepted for HUD test hosts; the new flow exits through menu. */
  onHangar?: () => void;
  onMenu: () => void;
  /** Stage the winning hull when the MVP presentation begins. */
  onMvp?: (entityId: EntityId) => void;
}

export interface ResultsOptions {
  /**
   * Offline practice: no `matchRewards` message will ever arrive, so the reward
   * block is replaced by a static line instead of waiting for an animation that
   * never starts.
   */
  offline?: boolean;
}

/** The banner shown for a finished match. */
export type MatchOutcome = "VICTORY" | "DEFEAT" | "DRAW" | "TARGETS CLEARED";

/**
 * Results screen (§6 1.9, restyled by §10 5.8): outcome banner, animated
 * reward count-up, and MVP-phase navigation.
 *
 * Lifecycle rules kept from the original: this component owns *display* state
 * only. Every button calls back into `main.ts`, which disposes the match
 * runtime and builds whatever comes next — there is no session lifecycle here.
 *
 * Offline vs online:
 *  - offline practice ends with `phase: "ended"` and never sends rewards, so
 *    the banner appears with a static "no rewards" line and no animation runs;
 *  - online matches additionally receive a `matchRewards` net message (§8 3.3)
 *    for authenticated participants only, which may land a frame or two after
 *    the phase flips (or never, for anonymous players) — {@link showRewards}
 *    starts the count-up whenever it arrives.
 */
export class ResultsOverlay {
  private readonly root: HTMLDivElement;
  private readonly bannerEl: HTMLDivElement;
  private readonly subEl: HTMLDivElement;
  private readonly participantsEl: HTMLDivElement;
  private readonly rewardsEl: HTMLDivElement;
  private readonly creditsEl: HTMLSpanElement;
  private readonly xpEl: HTMLSpanElement;
  private readonly rewardLine: HTMLDivElement;
  private shown = false;

  /** Count-up animation state; null until rewards arrive. */
  private rewards: MatchRewards | null = null;
  private rewardElapsedMs = 0;
  private rewardFinished = false;
  private lastCredits = -1;
  private lastXp = -1;

  constructor(
    parent: HTMLElement,
    private readonly session: GameSession,
    private readonly playerId: EntityId,
    private readonly callbacks: ResultsCallbacks,
    private readonly options: ResultsOptions = {},
  ) {
    this.root = document.createElement("div");
    this.root.className = "hud-results";

    const panel = document.createElement("div");
    panel.className = "hud-results-panel";

    this.bannerEl = document.createElement("div");
    this.bannerEl.className = "hud-results-title";

    // Cyan→amber rule under the banner: the same section mark the menu screens
    // use, so a match ending lands in the panel language the player left.
    const rule = document.createElement("div");
    rule.className = "hud-results-rule";
    rule.setAttribute("aria-hidden", "true");

    this.subEl = document.createElement("div");
    this.subEl.className = "hud-results-sub";
    this.participantsEl = document.createElement("div");
    this.participantsEl.className = "hud-results-participants";

    this.rewardsEl = document.createElement("div");
    this.rewardsEl.className = "hud-results-rewards";

    // The reward line is built once and only its numbers are written per frame —
    // no DOM churn during the count-up.
    this.rewardLine = document.createElement("div");
    this.rewardLine.className = "hud-results-rewards-line";
    this.creditsEl = document.createElement("span");
    this.creditsEl.className = "credits";
    this.xpEl = document.createElement("span");
    this.xpEl.className = "xp";
    const creditsLabel = document.createElement("span");
    creditsLabel.className = "unit";
    creditsLabel.textContent = " credits";
    const xpLabel = document.createElement("span");
    xpLabel.className = "unit";
    xpLabel.textContent = " xp";
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.textContent = " · ";
    this.rewardLine.append(this.creditsEl, creditsLabel, dot, this.xpEl, xpLabel);

    const actions = document.createElement("div");
    actions.className = "hud-results-actions";
    actions.append(
      button("Next", "primary", () => this.showScoreboard(), "next"),
      button("Play a New Game", "", callbacks.onPlayAgain, "playAgain"),
      button("Quit to Menu", "", callbacks.onMenu, "menu"),
    );

    panel.append(this.bannerEl, rule, this.participantsEl, this.subEl, this.rewardsEl, actions);
    this.root.appendChild(panel);
    parent.appendChild(this.root);
  }

  private onShowScoreboard: (() => void) | null = null;
  setScoreboardAction(action: () => void): void { this.onShowScoreboard = action; }
  private showScoreboard(): void {
    this.root.classList.remove("visible");
    this.onShowScoreboard?.();
  }

  /**
   * Call once per frame after events are drained. `dtMs` advances the reward
   * count-up; the overlay does nothing at all until the match ends.
   */
  update(cur: Snapshot, dtMs = 0): void {
    if (!this.shown) {
      if (cur.phase !== "ended") return;
      this.shown = true;
      const mvp = selectMvp(this.session.matchStats.all(), this.session.sim.world.gamemode.ctf !== undefined);
      const mvpName = mvp === null ? "MVP" : (this.session.displayNameFor(mvp) ?? (mvp === this.playerId ? "YOU" : `PILOT ${mvp}`));
      this.bannerEl.textContent = mvpName;
      this.bannerEl.dataset["outcome"] = "victory";
      this.participantsEl.textContent = "MOST VALUABLE PILOT";
      this.subEl.textContent = this.outcome(cur);
      if (this.options.offline) this.rewardsEl.textContent = "Practice — no rewards";
      if (mvp !== null) this.callbacks.onMvp?.(mvp);
      this.root.classList.add("visible");
      return;
    }
    this.advanceRewards(dtMs);
  }

  /**
   * The banner text. Practice runs against dummies read as an objective, not a
   * duel, so a won `destroyTargets` offline match says TARGETS CLEARED.
   */
  private outcome(cur: Snapshot): MatchOutcome {
    const playerTeam = this.session.teamOf(this.playerId);
    if (cur.winnerTeam === null) return "DRAW";
    if (cur.winnerTeam !== playerTeam) return "DEFEAT";
    const winCondition = this.session.sim.world.gamemode.winCondition;
    return this.options.offline && winCondition.type === "destroyTargets" ? "TARGETS CLEARED" : "VICTORY";
  }

  /** Renders the reward summary and starts the count-up; called from `main.ts`. */
  showRewards(rewards: MatchRewards): void {
    this.rewards = rewards;
    this.rewardElapsedMs = 0;
    this.rewardFinished = false;
    this.lastCredits = -1;
    this.lastXp = -1;
    this.subEl.textContent = "";

    this.rewardsEl.replaceChildren(this.rewardLine);
    this.paintRewards(0, 0);

    if (rewards.leveledUp) {
      const levelUp = document.createElement("div");
      levelUp.className = "hud-results-levelup";
      levelUp.textContent = `Level Up! → Level ${rewards.newLevel}`;
      this.rewardsEl.appendChild(levelUp);
    }
  }

  private advanceRewards(dtMs: number): void {
    if (!this.rewards || this.rewardFinished) return;
    this.rewardElapsedMs += Number.isFinite(dtMs) ? dtMs : 0;
    this.paintRewards(
      countUpValue(this.rewards.credits, this.rewardElapsedMs),
      countUpValue(this.rewards.xp, this.rewardElapsedMs),
    );
    if (countUpDone(this.rewardElapsedMs)) {
      this.rewardFinished = true;
      this.rewardLine.classList.add("done");
    }
  }

  /** DOM write only when a displayed number actually changed. */
  private paintRewards(credits: number, xp: number): void {
    if (credits !== this.lastCredits) {
      this.lastCredits = credits;
      this.creditsEl.textContent = `+${credits}`;
    }
    if (xp !== this.lastXp) {
      this.lastXp = xp;
      this.xpEl.textContent = `+${xp}`;
    }
  }

  /** Count-up progress 0..1 (dev probe / verification). */
  get rewardProgress(): number {
    if (!this.rewards) return 0;
    return Math.min(1, this.rewardElapsedMs / COUNT_UP_DURATION_MS);
  }

  dispose(): void {
    this.root.remove();
  }
}

function button(
  label: string,
  variant: string,
  onClick: () => void,
  key: string,
): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = `hud-results-btn${variant ? ` hud-results-btn--${variant}` : ""}`;
  b.textContent = label;
  b.dataset["resultsAction"] = key;
  b.addEventListener("click", onClick);
  return b;
}

import type { EntityId, Snapshot } from "@space-arena/shared";
import type { GameSession } from "../GameSession.js";
import { COUNT_UP_DURATION_MS, countUpDone, countUpValue } from "./countUp.js";
import {
  MVP_PRESENTATION_DEFAULTS,
  mvpCountUpValue,
  selectMvp,
  type MvpPresentationSettings,
} from "./matchPresentation.js";

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
  /** Resolved, backward-compatible match-end presentation theme. */
  mvp?: Readonly<MvpPresentationSettings>;
}

interface StatChip {
  readonly valueEl: HTMLSpanElement;
  target: number;
  shown: number;
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
  private readonly outcomeTagEl: HTMLDivElement;
  private readonly badgeEl: HTMLDivElement;
  private readonly accentEl: HTMLDivElement;
  private readonly statsEl: HTMLDivElement;
  private readonly statChips: readonly StatChip[];
  private readonly actionsEl: HTMLDivElement;
  private readonly subEl: HTMLDivElement;
  private readonly participantsEl: HTMLDivElement;
  private readonly rewardsEl: HTMLDivElement;
  private readonly creditsEl: HTMLSpanElement;
  private readonly xpEl: HTMLSpanElement;
  private readonly rewardLine: HTMLDivElement;
  private shown = false;
  private mvpShown = false;
  private mvpSkipped = false;
  private mvpElapsedMs = 0;
  private readonly mvpSettings: Readonly<MvpPresentationSettings>;
  private outcomeText: MatchOutcome = "DRAW";

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
    this.mvpSettings = options.mvp ?? MVP_PRESENTATION_DEFAULTS;
    this.root.addEventListener("pointerdown", () => this.skipMvpPresentation());

    const backdrop = document.createElement("div");
    backdrop.className = "hud-results-backdrop";
    backdrop.setAttribute("aria-hidden", "true");
    const motes = document.createElement("div");
    motes.className = "hud-results-motes";
    for (let i = 0; i < 10; i++) {
      const mote = document.createElement("i");
      mote.style.setProperty("--mote", String(i));
      mote.style.setProperty("--mote-x", `${(i * 37 + 11) % 100}%`);
      mote.style.setProperty("--mote-y", `${(i * 23 + 7) % 100}%`);
      motes.appendChild(mote);
    }
    backdrop.appendChild(motes);

    const panel = document.createElement("div");
    panel.className = "hud-results-panel";

    this.bannerEl = document.createElement("div");
    this.bannerEl.className = "hud-results-title";

    this.outcomeTagEl = document.createElement("div");
    this.outcomeTagEl.className = "hud-results-outcome-tag";

    this.badgeEl = document.createElement("div");
    this.badgeEl.className = "hud-results-mvp-badge";
    this.badgeEl.textContent = "MVP";

    this.accentEl = document.createElement("div");
    this.accentEl.className = "hud-results-team-accent";
    this.accentEl.setAttribute("aria-hidden", "true");

    // Cyan→amber rule under the banner: the same section mark the menu screens
    // use, so a match ending lands in the panel language the player left.
    const rule = document.createElement("div");
    rule.className = "hud-results-rule";
    rule.setAttribute("aria-hidden", "true");

    this.subEl = document.createElement("div");
    this.subEl.className = "hud-results-sub";
    this.participantsEl = document.createElement("div");
    this.participantsEl.className = "hud-results-participants";

    this.statsEl = document.createElement("div");
    this.statsEl.className = "hud-results-stats";
    this.statChips = [
      this.makeStatChip("KILLS"),
      this.makeStatChip("ASSISTS"),
      this.makeStatChip("CAPTURES"),
    ];

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

    this.actionsEl = document.createElement("div");
    this.actionsEl.className = "hud-results-actions";
    this.actionsEl.append(
      button("Next", "primary", () => this.showScoreboard(), "next"),
      button("Play a New Game", "", callbacks.onPlayAgain, "playAgain"),
      button("Quit to Menu", "", callbacks.onMenu, "menu"),
    );

    panel.append(
      this.outcomeTagEl,
      this.badgeEl,
      this.participantsEl,
      this.bannerEl,
      this.accentEl,
      rule,
      this.statsEl,
      this.subEl,
      this.rewardsEl,
      this.actionsEl,
    );
    this.root.append(backdrop, panel);
    parent.appendChild(this.root);
  }

  private makeStatChip(label: string): StatChip {
    const chip = document.createElement("div");
    chip.className = "hud-results-stat";
    const valueEl = document.createElement("span");
    valueEl.className = "hud-results-stat-value";
    valueEl.textContent = "0";
    const labelEl = document.createElement("span");
    labelEl.className = "hud-results-stat-label";
    labelEl.textContent = label;
    chip.append(valueEl, labelEl);
    this.statsEl.appendChild(chip);
    return { valueEl, target: 0, shown: 0 };
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
      const outcome = this.outcome(cur);
      this.outcomeText = outcome;
      this.bannerEl.textContent = outcome;
      this.bannerEl.dataset["outcome"] = outcome.toLowerCase().replaceAll(" ", "-");
      this.root.classList.add("hud-results--outcome");
      this.root.classList.add("visible");
      return;
    }
    this.advanceMvp(dtMs);
    this.advanceRewards(dtMs);
  }

  /** Replace the timed outcome banner with the interactive MVP hero card. */
  showMvp(): void {
    if (!this.shown || this.mvpShown) return;
    this.mvpShown = true;
    const mvp = selectMvp(this.session.matchStats.all(), this.session.sim.world.gamemode.ctf !== undefined);
    const mvpName = mvp === null ? "MVP" : (this.session.displayNameFor(mvp) ?? (mvp === this.playerId ? "YOU" : `PILOT ${mvp}`));
    const mvpLine = mvp === null ? undefined : this.session.matchStats.all().find((line) => line.entityId === mvp);
    this.root.classList.remove("hud-results--outcome");
    this.root.classList.add("hud-results--mvp");
    this.bannerEl.textContent = mvpName;
    this.bannerEl.removeAttribute("data-outcome");
    this.outcomeTagEl.textContent = this.outcomeText;
    this.outcomeTagEl.dataset["outcome"] = this.outcomeText.toLowerCase().replaceAll(" ", "-");
    this.participantsEl.textContent = "MOST VALUABLE PILOT";
    this.root.dataset["mvpTeam"] = String(mvp === null ? 0 : (this.session.teamOf(mvp) ?? 0));
    this.setStatTargets(mvpLine?.kills ?? 0, mvpLine?.assists ?? 0, mvpLine?.flagsCaptured ?? 0);
    this.mvpElapsedMs = 0;
    this.mvpSkipped = false;
    if (this.options.offline) this.rewardsEl.textContent = "Practice — no rewards";
    if (mvp !== null) this.callbacks.onMvp?.(mvp);
  }

  private setStatTargets(kills: number, assists: number, captures: number): void {
    const targets = [kills, assists, captures];
    for (let i = 0; i < this.statChips.length; i++) {
      const chip = this.statChips[i]!;
      chip.target = targets[i] ?? 0;
      chip.shown = 0;
      chip.valueEl.textContent = "0";
    }
  }

  private advanceMvp(dtMs: number): void {
    if (!this.mvpShown || this.mvpSkipped) return;
    this.mvpElapsedMs += Number.isFinite(dtMs) ? Math.max(0, dtMs) : 0;
    const countElapsed = this.mvpElapsedMs - this.mvpSettings.statsDelayMs;
    for (const chip of this.statChips) {
      const value = mvpCountUpValue(chip.target, countElapsed, this.mvpSettings.statsCountUpMs);
      if (value === chip.shown) continue;
      chip.shown = value;
      chip.valueEl.textContent = String(value);
    }
    if (this.mvpElapsedMs >= this.mvpSettings.sequenceMs) this.finishMvpPresentation(false);
  }

  /** Tap anywhere during the reveal to land every animation and stat immediately. */
  private skipMvpPresentation(): void {
    if (!this.mvpShown || this.mvpSkipped) return;
    this.finishMvpPresentation(true);
  }

  private finishMvpPresentation(skipped: boolean): void {
    this.mvpSkipped = true;
    this.mvpElapsedMs = this.mvpSettings.sequenceMs;
    for (const chip of this.statChips) {
      if (chip.shown === chip.target) continue;
      chip.shown = chip.target;
      chip.valueEl.textContent = String(chip.target);
    }
    this.root.classList.add("hud-results--mvp-complete");
    if (skipped) this.root.classList.add("hud-results--mvp-skipped");
  }

  /** The banner text for the completed match. */
  private outcome(cur: Snapshot): MatchOutcome {
    const playerTeam = this.session.teamOf(this.playerId);
    if (cur.winnerTeam === null) return "DRAW";
    if (cur.winnerTeam !== playerTeam) return "DEFEAT";
    return "VICTORY";
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

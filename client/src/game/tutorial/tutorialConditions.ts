import type { ModuleFamily, TutorialActorRole, TutorialCondition, TutorialStage } from "@space-arena/shared";

/**
 * Everything the tutorial has observed SINCE THE CURRENT STEP BEGAN.
 *
 * Per-step rather than per-run on purpose: "fire six shots" means six shots
 * during this lesson, not six shots at any point since the player pressed
 * TUTORIAL. {@link TutorialDirector} owns one of these and resets it on every
 * advance; this file only reads it.
 *
 * Keeping the accumulator and the test apart is what makes the conditions
 * testable without a sim, a DOM or a clock: every member below is a plain
 * number, flag or set.
 */
export interface StepSignals {
  /** Highest commanded throttle seen during the step, 0..1. */
  throttle: number;
  /** Attitude change accumulated during the step, in radians (yaw + pitch). */
  turned: number;
  /** Shots the player's weapons have got off. */
  shots: number;
  /** Module families the player has brought UP. */
  toggled: ReadonlySet<ModuleFamily>;
  /** The sim reported a completed lock for the player. */
  locked: boolean;
  /** Scripted actors that have died. */
  killed: ReadonlySet<TutorialActorRole>;
  /** Screens the player has opened. */
  visited: ReadonlySet<TutorialStage>;
  /** The hangar's working loadout changed. */
  loadoutChanged: boolean;
  /** The ownership ledger recorded a purchase. */
  purchased: boolean;
  /** The player pressed the coach mark's confirm button. */
  acknowledged: boolean;
  /** Seconds since the step began. */
  elapsedSec: number;
}

/**
 * The same record, WRITABLE. Only {@link TutorialDirector} holds one; every
 * reader below takes the readonly view, so a condition can never quietly
 * consume the signal it is testing.
 */
export interface MutableStepSignals extends Omit<StepSignals, "toggled" | "killed" | "visited"> {
  toggled: Set<ModuleFamily>;
  killed: Set<TutorialActorRole>;
  visited: Set<TutorialStage>;
}

/** A signals record with nothing observed yet — the state at every step boundary. */
export function emptySignals(): MutableStepSignals {
  return {
    throttle: 0,
    turned: 0,
    shots: 0,
    toggled: new Set(),
    locked: false,
    killed: new Set(),
    visited: new Set(),
    loadoutChanged: false,
    purchased: false,
    acknowledged: false,
    elapsedSec: 0,
  };
}

/**
 * Is this step's completion condition satisfied by what has been observed?
 *
 * Pure, exhaustive over the union, and total: an unknown condition kind cannot
 * exist (the schema is a discriminated union) but the `never` fallthrough keeps
 * that a COMPILE error rather than a step that can never complete.
 */
export function conditionMet(condition: TutorialCondition, s: StepSignals): boolean {
  switch (condition.kind) {
    case "throttle-above":
      return s.throttle >= condition.value;
    case "heading-changed":
      return s.turned >= condition.radians;
    case "fired":
      return s.shots >= condition.shots;
    case "module-toggled":
      return condition.family === undefined ? s.toggled.size > 0 : s.toggled.has(condition.family);
    case "lock-acquired":
      return s.locked;
    case "kill":
      return condition.target === "any" ? s.killed.size > 0 : s.killed.has(condition.target);
    case "screen-visited":
      return s.visited.has(condition.screen);
    case "loadout-changed":
      return s.loadoutChanged;
    case "purchase-made":
      return s.purchased;
    case "dwell":
      return s.elapsedSec >= condition.seconds;
    case "acknowledged":
      return s.acknowledged;
    default: {
      const exhaustive: never = condition;
      return Boolean(exhaustive);
    }
  }
}

/**
 * Whether a condition is one the player CONFIRMS rather than performs — the
 * coach mark grows a button for exactly these, and for nothing else. A step that
 * can be finished by flying must never offer a way to click past it.
 */
export function needsAcknowledgement(condition: TutorialCondition): boolean {
  return condition.kind === "acknowledged";
}

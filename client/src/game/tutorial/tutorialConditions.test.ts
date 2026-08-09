import { describe, expect, it } from "vitest";
import type { TutorialCondition } from "@space-arena/shared";
import {
  conditionMet,
  emptySignals,
  needsAcknowledgement,
  type MutableStepSignals,
} from "./tutorialConditions.js";

/** Signals with a few fields moved off their zero state. */
function signals(patch: Partial<MutableStepSignals> = {}): MutableStepSignals {
  return Object.assign(emptySignals(), patch);
}

/**
 * One test per condition KIND, both polarities. These are the entire contract
 * between the authored flow and the running game: a condition that reads a
 * signal it should not is a step that completes itself, and a condition that
 * misses one is a step the player cannot finish.
 */
describe("tutorial step conditions", () => {
  it("throttle-above passes on the highest throttle the step has seen", () => {
    const c: TutorialCondition = { kind: "throttle-above", value: 0.5 };
    expect(conditionMet(c, signals({ throttle: 0.49 }))).toBe(false);
    expect(conditionMet(c, signals({ throttle: 0.5 }))).toBe(true);
  });

  it("heading-changed accumulates rotation rather than reading an absolute heading", () => {
    const c: TutorialCondition = { kind: "heading-changed", radians: 2 };
    expect(conditionMet(c, signals({ turned: 1.9 }))).toBe(false);
    expect(conditionMet(c, signals({ turned: 2.1 }))).toBe(true);
  });

  it("fired counts shots", () => {
    const c: TutorialCondition = { kind: "fired", shots: 3 };
    expect(conditionMet(c, signals({ shots: 2 }))).toBe(false);
    expect(conditionMet(c, signals({ shots: 3 }))).toBe(true);
  });

  it("heat-above-then-cooled needs BOTH halves, in order", () => {
    const c: TutorialCondition = { kind: "heat-above-then-cooled", peak: 0.8, cooled: 0.35 };
    // Never fired: cold, but never hot.
    expect(conditionMet(c, signals({ peakHeat: 0, heat: 0 }))).toBe(false);
    // Hot right now — the lesson is the cooldown, so this is not done yet.
    expect(conditionMet(c, signals({ peakHeat: 0.9, heat: 0.9 }))).toBe(false);
    expect(conditionMet(c, signals({ peakHeat: 0.9, heat: 0.3 }))).toBe(true);
  });

  it("module-toggled matches a named family, or any module when unnamed", () => {
    const shield: TutorialCondition = { kind: "module-toggled", family: "shield" };
    expect(conditionMet(shield, signals({ toggled: new Set(["laser"]) }))).toBe(false);
    expect(conditionMet(shield, signals({ toggled: new Set(["shield"]) }))).toBe(true);
    const any: TutorialCondition = { kind: "module-toggled" };
    expect(conditionMet(any, signals())).toBe(false);
    expect(conditionMet(any, signals({ toggled: new Set(["laser"]) }))).toBe(true);
  });

  it("lock-acquired reads the sim's completed lock", () => {
    const c: TutorialCondition = { kind: "lock-acquired" };
    expect(conditionMet(c, signals())).toBe(false);
    expect(conditionMet(c, signals({ locked: true }))).toBe(true);
  });

  it("kill distinguishes the hulk from the drone, and 'any' accepts either", () => {
    const dummy: TutorialCondition = { kind: "kill", target: "dummy" };
    const bot: TutorialCondition = { kind: "kill", target: "bot" };
    const any: TutorialCondition = { kind: "kill", target: "any" };
    const killedDummy = signals({ killed: new Set(["dummy"]) });
    expect(conditionMet(dummy, killedDummy)).toBe(true);
    expect(conditionMet(bot, killedDummy)).toBe(false);
    expect(conditionMet(any, killedDummy)).toBe(true);
    expect(conditionMet(any, signals())).toBe(false);
  });

  it("screen-visited names the screen that was opened", () => {
    const c: TutorialCondition = { kind: "screen-visited", screen: "hangar" };
    expect(conditionMet(c, signals({ visited: new Set(["shop"]) }))).toBe(false);
    expect(conditionMet(c, signals({ visited: new Set(["hangar"]) }))).toBe(true);
  });

  it("loadout-changed waits for a fit", () => {
    const c: TutorialCondition = { kind: "loadout-changed" };
    expect(conditionMet(c, signals())).toBe(false);
    expect(conditionMet(c, signals({ loadoutChanged: true }))).toBe(true);
  });

  it("purchase-made waits for the ledger", () => {
    const c: TutorialCondition = { kind: "purchase-made" };
    expect(conditionMet(c, signals())).toBe(false);
    expect(conditionMet(c, signals({ purchased: true }))).toBe(true);
  });

  it("dwell is the only condition satisfied by time alone", () => {
    const c: TutorialCondition = { kind: "dwell", seconds: 3 };
    expect(conditionMet(c, signals({ elapsedSec: 2.9 }))).toBe(false);
    expect(conditionMet(c, signals({ elapsedSec: 3 }))).toBe(true);
  });

  it("acknowledged waits for the button", () => {
    const c: TutorialCondition = { kind: "acknowledged" };
    expect(conditionMet(c, signals())).toBe(false);
    expect(conditionMet(c, signals({ acknowledged: true }))).toBe(true);
  });

  it("a fresh step starts with nothing observed", () => {
    const fresh = emptySignals();
    const everything: TutorialCondition[] = [
      { kind: "throttle-above", value: 0.01 },
      { kind: "heading-changed", radians: 0.01 },
      { kind: "fired", shots: 1 },
      { kind: "heat-above-then-cooled", peak: 0.1, cooled: 1 },
      { kind: "module-toggled" },
      { kind: "lock-acquired" },
      { kind: "kill", target: "any" },
      { kind: "screen-visited", screen: "shop" },
      { kind: "loadout-changed" },
      { kind: "purchase-made" },
      { kind: "dwell", seconds: 0.01 },
      { kind: "acknowledged" },
    ];
    for (const condition of everything) {
      expect(conditionMet(condition, fresh), condition.kind).toBe(false);
    }
  });
});

describe("needsAcknowledgement", () => {
  it("is true for the confirm step and false for everything a player performs", () => {
    expect(needsAcknowledgement({ kind: "acknowledged" })).toBe(true);
    expect(needsAcknowledgement({ kind: "dwell", seconds: 1 })).toBe(false);
    expect(needsAcknowledgement({ kind: "throttle-above", value: 1 })).toBe(false);
  });
});

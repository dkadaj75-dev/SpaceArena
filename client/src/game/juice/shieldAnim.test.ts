import { describe, expect, it } from "vitest";
import { DEFAULT_JUICE_SETTINGS } from "./juiceSettings.js";
import {
  advanceShieldAnim,
  initialShieldAnim,
  panelBounceWeight,
  panelPose,
  panelProgress,
  phaseAlphaScale,
  shieldAnimMoving,
  shieldAnimVisible,
  shieldBounce,
  shieldBrokenBy,
  type PanelPose,
} from "./shieldAnim.js";
import { shieldPanelLayout } from "./shieldPanels.js";

/**
 * The shield shell's four beats (owner 2026-08-23): raise, lower, BREAK, and
 * ring from a hit. The pixels are untestable; the state machine underneath them
 * is not, and it is where every one of those beats is actually decided.
 */

const s = DEFAULT_JUICE_SETTINGS.shieldRipple;
const panels = shieldPanelLayout(32, 1.2);
const pose: PanelPose = { radial: 0, scale: 0, spinRad: 0 };

/** Run the machine forward `ms` in 16 ms frames, holding the inputs. */
function run(state = initialShieldAnim(), up = true, broken = false, ms = 0): ReturnType<typeof initialShieldAnim> {
  for (let t = 0; t < ms; t += 16) advanceShieldAnim(state, up, broken, 16, s);
  return state;
}

describe("shieldBrokenBy", () => {
  it("calls a shield that emptied under fire BROKEN — the module is still deployed", () => {
    expect(shieldBrokenBy([{ state: "active", shieldPool: 0 }])).toBe(true);
  });

  it("calls a retracted shield a stand-down, not a break", () => {
    expect(shieldBrokenBy([{ state: "retracting", shieldPool: 0 }])).toBe(false);
    expect(shieldBrokenBy([{ state: "stowed", shieldPool: 0 }])).toBe(false);
  });

  it("says nothing about a shield that still has charge", () => {
    expect(shieldBrokenBy([{ state: "active", shieldPool: 12 }])).toBe(false);
  });

  it("ignores unrelated modules on the same hull", () => {
    expect(
      shieldBrokenBy([
        { state: "active", shieldPool: 0 },
        { state: "active", shieldPool: 30 },
      ]),
    ).toBe(true);
    expect(shieldBrokenBy([])).toBe(false);
  });
});

describe("advanceShieldAnim", () => {
  it("starts down and draws nothing", () => {
    const state = initialShieldAnim();
    expect(state.phase).toBe("down");
    expect(shieldAnimVisible(state)).toBe(false);
  });

  it("assembles on the rise and settles into up", () => {
    const state = run(initialShieldAnim(), true, false, 32);
    expect(state.phase).toBe("assembling");
    run(state, true, false, s.assembleMs);
    expect(state.phase).toBe("up");
    expect(state.elapsedMs).toBe(0);
  });

  it("runs the same sweep backwards on a clean stand-down", () => {
    const state = run(initialShieldAnim(), true, false, s.assembleMs + 32);
    advanceShieldAnim(state, false, false, 16, s);
    expect(state.phase).toBe("standingDown");
    run(state, false, false, s.assembleMs);
    expect(state.phase).toBe("down");
  });

  it("SHATTERS instead when the shield went down broken", () => {
    const state = run(initialShieldAnim(), true, false, s.assembleMs + 32);
    advanceShieldAnim(state, false, true, 16, s);
    expect(state.phase).toBe("shattering");
    // The blast is longer than the stand-down and must not end early.
    run(state, false, true, s.assembleMs);
    expect(state.phase).toBe("shattering");
    run(state, false, true, s.shatterMs);
    expect(state.phase).toBe("down");
  });

  it("carries progress across a mid-sweep reversal instead of restarting", () => {
    // Dropped a third of the way up: the panels are a third of the way out, so
    // the stand-down must start two thirds of the way through ITS sweep.
    const state = run(initialShieldAnim(), true, false, s.assembleMs / 3);
    const raised = state.elapsedMs;
    advanceShieldAnim(state, false, false, 0, s);
    expect(state.phase).toBe("standingDown");
    expect(state.elapsedMs).toBeCloseTo(s.assembleMs - raised, 6);
  });

  it("carries it back the other way when the shield comes up again mid-drop", () => {
    const state = run(initialShieldAnim(), true, false, s.assembleMs + 32);
    run(state, false, false, s.assembleMs / 4);
    const lowered = state.elapsedMs;
    advanceShieldAnim(state, true, false, 0, s);
    expect(state.phase).toBe("assembling");
    expect(state.elapsedMs).toBeCloseTo(s.assembleMs - lowered, 6);
  });

  it("shatters a shell that broke while it was still coming up", () => {
    const state = run(initialShieldAnim(), true, false, 48);
    advanceShieldAnim(state, false, true, 16, s);
    expect(state.phase).toBe("shattering");
  });

  it("starts a FRESH assembly if the reservoir recharges mid-blast", () => {
    const state = run(initialShieldAnim(), true, false, s.assembleMs + 32);
    advanceShieldAnim(state, false, true, 16, s);
    run(state, false, true, s.shatterMs / 2);
    advanceShieldAnim(state, true, false, 16, s);
    expect(state.phase).toBe("assembling");
    // From zero: the panels that flew off are gone, and dragging them back
    // would read as the explosion running backwards.
    expect(state.elapsedMs).toBe(0);
  });

  it("ignores a non-finite or negative frame delta", () => {
    const state = run(initialShieldAnim(), true, false, 16);
    const at = state.elapsedMs;
    advanceShieldAnim(state, true, false, Number.NaN, s);
    advanceShieldAnim(state, true, false, -100, s);
    expect(state.elapsedMs).toBe(at);
  });
});

describe("shieldAnimMoving", () => {
  it("skips the buffer rewrite for a shell sitting at rest", () => {
    const state = run(initialShieldAnim(), true, false, s.assembleMs + 32);
    expect(state.phase).toBe("up");
    expect(shieldAnimMoving(state, 0)).toBe(false);
    expect(shieldAnimMoving(state, 0.02)).toBe(true);
  });

  it("always rewrites while a sweep or a blast is running", () => {
    expect(shieldAnimMoving(run(initialShieldAnim(), true, false, 32), 0)).toBe(true);
  });
});

describe("panelProgress", () => {
  it("staggers panel starts but lands every panel by the end of the sweep", () => {
    for (const panel of panels) {
      expect(panelProgress(panel, 0, s)).toBe(0);
      expect(panelProgress(panel, s.assembleMs, s)).toBe(1);
    }
  });

  it("starts the late panels after the early ones", () => {
    const early = panels.reduce((a, b) => (a.jitter < b.jitter ? a : b));
    const late = panels.reduce((a, b) => (a.jitter > b.jitter ? a : b));
    const mid = s.assembleMs * 0.3;
    expect(panelProgress(early, mid, s)).toBeGreaterThan(panelProgress(late, mid, s));
  });

  it("moves every panel together when the stagger is off", () => {
    const flat = { ...s, assembleStagger: 0 };
    const first = panelProgress(panels[0]!, 100, flat);
    for (const panel of panels) expect(panelProgress(panel, 100, flat)).toBeCloseTo(first, 12);
  });
});

describe("panelPose", () => {
  it("draws nothing at all while the shell is down", () => {
    panelPose(panels[0]!, initialShieldAnim(), s, 0, pose);
    expect(pose.scale).toBe(0);
  });

  it("seats every panel on the bubble once assembled", () => {
    const state = run(initialShieldAnim(), true, false, s.assembleMs + 32);
    for (const panel of panels) {
      panelPose(panel, state, s, 0, pose);
      expect(pose.radial).toBe(1);
      expect(pose.scale).toBe(1);
      expect(pose.spinRad).toBe(0);
    }
  });

  it("flies panels OUT OF THE HULL rather than fading them in on station", () => {
    const state = run(initialShieldAnim(), true, false, 16);
    panelPose(panels[0]!, state, s, 0, pose);
    // Near the hull, tiny, and spinning — the "printed out of the ship" read.
    expect(pose.radial).toBeLessThan(0.5);
    expect(pose.scale).toBeLessThan(0.5);
  });

  it("throws panels away from the hull, shrinking, while it shatters", () => {
    const state = run(initialShieldAnim(), true, false, s.assembleMs + 32);
    advanceShieldAnim(state, false, true, 16, s);
    const panel = panels[0]!;
    panelPose(panel, state, s, 0, pose);
    const early = { ...pose };
    run(state, false, true, s.shatterMs / 2);
    panelPose(panel, state, s, 0, pose);
    expect(pose.radial).toBeGreaterThan(early.radial);
    expect(pose.scale).toBeLessThan(early.scale);
    expect(Math.abs(pose.spinRad)).toBeGreaterThan(Math.abs(early.spinRad));
  });

  it("carries the bounce into the seated radius", () => {
    const state = run(initialShieldAnim(), true, false, s.assembleMs + 32);
    panelPose(panels[0]!, state, s, 0.1, pose);
    expect(pose.radial).toBeCloseTo(1.1, 6);
  });
});

describe("phaseAlphaScale", () => {
  it("leaves the theme's tuned alpha alone everywhere but the blast", () => {
    expect(phaseAlphaScale(initialShieldAnim(), s)).toBe(1);
    expect(phaseAlphaScale(run(initialShieldAnim(), true, false, 32), s)).toBe(1);
  });

  it("fades a shattering shell out over its blast", () => {
    const state = run(initialShieldAnim(), true, false, s.assembleMs + 32);
    advanceShieldAnim(state, false, true, 0, s);
    expect(phaseAlphaScale(state, s)).toBeCloseTo(1, 6);
    run(state, false, true, s.shatterMs / 2);
    expect(phaseAlphaScale(state, s)).toBeLessThan(0.6);
    expect(phaseAlphaScale(state, s)).toBeGreaterThan(0);
  });
});

describe("shieldBounce", () => {
  it("is silent with no hit on record", () => {
    expect(shieldBounce(Number.POSITIVE_INFINITY, s)).toBe(0);
    expect(shieldBounce(s.impactDecayMs, s)).toBe(0);
  });

  it("peaks outward on the frame of the hit", () => {
    expect(shieldBounce(0, s)).toBeCloseTo(s.hitBounce, 6);
  });

  it("actually WOBBLES — it crosses back through its rest radius", () => {
    let negatives = 0;
    for (let t = 0; t < s.impactDecayMs; t += 5) if (shieldBounce(t, s) < 0) negatives++;
    expect(negatives).toBeGreaterThan(0);
  });

  it("settles: later swings are smaller than earlier ones", () => {
    const first = Math.abs(shieldBounce(s.impactDecayMs * 0.1, s));
    const last = Math.abs(shieldBounce(s.impactDecayMs * 0.9, s));
    expect(last).toBeLessThan(first);
  });
});

describe("panelBounceWeight", () => {
  it("concentrates the wobble on the panels facing the shot", () => {
    expect(panelBounceWeight(1, s)).toBeCloseTo(1, 6);
    expect(panelBounceWeight(0.5, s)).toBeLessThan(1);
    expect(panelBounceWeight(0.5, s)).toBeGreaterThan(0);
  });

  it("leaves the far side of the shell alone", () => {
    expect(panelBounceWeight(-0.8, s)).toBe(0);
  });

  it("rings the whole shell when the hit had no known direction", () => {
    expect(panelBounceWeight(1, { ...s, hitFocus: 0 })).toBe(1);
    expect(panelBounceWeight(-1, { ...s, hitFocus: 0 })).toBe(1);
  });
});

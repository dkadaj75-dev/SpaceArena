import { describe, expect, it } from "vitest";
import { buildOverlayModel, HANGAR_GAUGE_REFERENCE, type HangarGaugeKey } from "./hangarOverlayModel.js";
import type { HangarStatPanel } from "./hangarStats.js";

/** A plain, comfortably-inside-limits fit to vary one number at a time from. */
function panel(over: Partial<HangarStatPanel> = {}): HangarStatPanel {
  return {
    hullMax: 100,
    nominalSpeed: 20,
    energyReserve: 120,
    rechargeMult: 1.25,
    coolingMult: 1.6,
    burnSec: 5,
    recoverSec: 2.5,
    dps: 20,
    sustainedDps: 14,
    ehpApprox: 110,
    powerCapacity: 10,
    powerDrawTotal: 6,
    powerDrawRetracted: 4,
    powerOverSubscribed: false,
    ...over,
  };
}

function gauge(model: ReturnType<typeof buildOverlayModel>, key: HangarGaugeKey) {
  const found = model.gauges.find((g) => g.key === key);
  if (!found) throw new Error(`no ${key} gauge`);
  return found;
}

describe("hangar stage overlay gauges", () => {
  it("shows every headline characteristic, power first", () => {
    const model = buildOverlayModel(panel(), null);
    expect(model.gauges.map((g) => g.key)).toEqual(["power", "hull", "speed", "tanks", "thermal", "dps"]);
    expect(model.previewing).toBe(false);
  });

  it("fills power against the rail CAPACITY, not against a nominal scale", () => {
    const g = gauge(buildOverlayModel(panel({ powerDrawTotal: 6, powerCapacity: 10 }), null), "power");
    expect(g.fraction).toBeCloseTo(0.6, 9);
    expect(g.limitFraction).toBeCloseTo(1, 9);
    expect(g.valueText).toBe("6 / 10");
    expect(g.warn).toBe(false);
  });

  it("fills the other gauges against a shared reference, so hulls compare", () => {
    const g = gauge(buildOverlayModel(panel({ hullMax: HANGAR_GAUGE_REFERENCE.hull / 2 }), null), "hull");
    expect(g.fraction).toBeCloseTo(0.5, 9);
    expect(g.limitFraction).toBeNull();
  });

  it("re-scales a gauge whose value runs past its reference instead of clipping it", () => {
    const beyond = HANGAR_GAUGE_REFERENCE.dps * 2;
    const g = gauge(buildOverlayModel(panel({ dps: beyond }), null), "dps");
    expect(g.fraction).toBeCloseTo(1, 9);
    // The ghost of a smaller value stays readable because it shares that scale.
    const ghosted = gauge(buildOverlayModel(panel({ dps: beyond }), panel({ dps: beyond / 2 })), "dps");
    expect(ghosted.fraction).toBeCloseTo(1, 9);
    expect(ghosted.ghostFraction).toBeCloseTo(0.5, 9);
  });

  it("has no ghosts at all without a candidate module", () => {
    const model = buildOverlayModel(panel(), null);
    for (const g of model.gauges) {
      expect(g.ghostFraction).toBeNull();
      expect(g.delta).toBeNull();
      expect(g.deltaText).toBeNull();
      expect(g.trend).toBe("none");
      expect(g.ghostWarn).toBe(false);
    }
  });

  it("ghosts an INCREASE above the current fill, with a signed delta", () => {
    const model = buildOverlayModel(panel({ dps: 20 }), panel({ dps: 26.5 }));
    const g = gauge(model, "dps");
    expect(model.previewing).toBe(true);
    expect(g.fraction).toBeCloseTo(20 / HANGAR_GAUGE_REFERENCE.dps, 9);
    expect(g.ghostFraction).toBeCloseTo(26.5 / HANGAR_GAUGE_REFERENCE.dps, 9);
    expect(g.delta).toBeCloseTo(6.5, 9);
    expect(g.deltaText).toBe("+6.5");
    expect(g.trend).toBe("better");
  });

  it("ghosts a DECREASE below the current fill and calls it a regression", () => {
    const g = gauge(buildOverlayModel(panel({ hullMax: 120 }), panel({ hullMax: 90 })), "hull");
    expect(g.ghostFraction!).toBeLessThan(g.fraction);
    expect(g.deltaText).toBe("-30");
    expect(g.trend).toBe("worse");
  });

  it("reads a RISE in power draw as the regression it is", () => {
    const g = gauge(buildOverlayModel(panel({ powerDrawTotal: 6 }), panel({ powerDrawTotal: 9 })), "power");
    expect(g.deltaText).toBe("+3");
    expect(g.trend).toBe("worse");
    // …and freeing the rail is the improvement.
    const freed = gauge(buildOverlayModel(panel({ powerDrawTotal: 6 }), panel({ powerDrawTotal: 4 })), "power");
    expect(freed.trend).toBe("better");
  });

  it("leaves untouched gauges ghost-free even while previewing", () => {
    const model = buildOverlayModel(panel(), panel({ dps: 30 }));
    expect(gauge(model, "dps").ghostFraction).not.toBeNull();
    expect(gauge(model, "hull").ghostFraction).toBeNull();
    expect(gauge(model, "hull").delta).toBeNull();
    expect(gauge(model, "hull").ghostValue).toBe(100); // still known, just unchanged
  });

  it("flags a fit that already over-subscribes the rail", () => {
    const model = buildOverlayModel(
      panel({ powerDrawTotal: 13, powerCapacity: 10, powerOverSubscribed: true }),
      null,
    );
    const g = gauge(model, "power");
    expect(g.warn).toBe(true);
    expect(g.fraction).toBeCloseTo(1, 9); // the draw sets the scale…
    expect(g.limitFraction).toBeCloseTo(10 / 13, 9); // …and capacity marks where it broke
    expect(model.powerOverBy).toBeCloseTo(3, 9);
    expect(model.powerWarn).toBe(true);
  });

  it("flags a candidate that would PUSH the rail over, before it is equipped", () => {
    const model = buildOverlayModel(
      panel({ powerDrawTotal: 8, powerCapacity: 10 }),
      panel({ powerDrawTotal: 12, powerCapacity: 10, powerOverSubscribed: true }),
    );
    const g = gauge(model, "power");
    expect(g.warn).toBe(false); // the fit as it stands is fine…
    expect(g.ghostWarn).toBe(true); // …the one being considered is not
    expect(model.powerOverBy).toBe(0);
    expect(model.projectedPowerOverBy).toBeCloseTo(2, 9);
    expect(model.powerWarn).toBe(true);
  });

  it("clears the warning when the candidate brings the fit back under the rail", () => {
    const model = buildOverlayModel(
      panel({ powerDrawTotal: 13, powerCapacity: 10, powerOverSubscribed: true }),
      panel({ powerDrawTotal: 7, powerCapacity: 10 }),
    );
    expect(gauge(model, "power").warn).toBe(true);
    expect(gauge(model, "power").ghostWarn).toBe(false);
    expect(model.projectedPowerOverBy).toBe(0);
  });

  it("warns on a fit whose tanks refill slowly or whose racks lock out fast", () => {
    const model = buildOverlayModel(panel({ rechargeMult: 0.9, burnSec: 2.2, recoverSec: 3 }), null);
    expect(gauge(model, "tanks").warn).toBe(true);
    expect(gauge(model, "tanks").valueText).toBe("120 · ×0.90");
    expect(gauge(model, "thermal").warn).toBe(true);
    expect(gauge(model, "thermal").valueText).toBe("2.2s · 3.0s cool");
  });

  it("treats float noise as no change at all", () => {
    const g = gauge(buildOverlayModel(panel({ dps: 20 }), panel({ dps: 20 + 1e-12 })), "dps");
    expect(g.delta).toBeNull();
    expect(g.ghostFraction).toBeNull();
    expect(g.trend).toBe("none");
  });
});

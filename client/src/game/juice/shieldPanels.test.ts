import { describe, expect, it } from "vitest";
import { DEFAULT_JUICE_SETTINGS } from "./juiceSettings.js";
import { hash01, layoutFor, panelBasis, shieldPanelCount, shieldPanelLayout } from "./shieldPanels.js";

/**
 * The shield shell's panel LAYOUT (owner 2026-08-23). The bubble itself cannot
 * be unit-tested — it is pixels — but everything that decides where its
 * hexagons sit is arithmetic, and a shell that tiles badly (panels bunched at a
 * pole, a basis that flips, a count a low tier cannot afford) is a bug with a
 * number behind it.
 */

const ripple = DEFAULT_JUICE_SETTINGS.shieldRipple;

describe("shieldPanelLayout", () => {
  it("puts every panel on the unit sphere", () => {
    for (const panel of shieldPanelLayout(120, 1.2)) {
      expect(Math.hypot(panel.nx, panel.ny, panel.nz)).toBeCloseTo(1, 6);
    }
  });

  it("spreads panels evenly rather than bunching at the poles", () => {
    // A spiral's defining property: consecutive panels step through latitude in
    // equal slices, so no band of the sphere is denser than another. Measured
    // as the y-span of each third of the list, which must be near-equal.
    const panels = shieldPanelLayout(120, 1.2);
    const third = Math.floor(panels.length / 3);
    const span = (from: number, to: number): number => {
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = from; i < to; i++) {
        lo = Math.min(lo, panels[i]!.ny);
        hi = Math.max(hi, panels[i]!.ny);
      }
      return hi - lo;
    };
    const top = span(0, third);
    const middle = span(third, third * 2);
    const bottom = span(third * 2, panels.length);
    expect(middle).toBeCloseTo(top, 1);
    expect(bottom).toBeCloseTo(top, 1);
  });

  it("never seats a panel exactly on a pole", () => {
    // A pole panel has no well-defined tangent basis and would visibly spin.
    for (const panel of shieldPanelLayout(64, 1)) expect(Math.abs(panel.ny)).toBeLessThan(1);
  });

  it("shrinks each hexagon as the count rises, so the shell stays closed but not stacked", () => {
    const sparse = shieldPanelLayout(60, 1)[0]!.radius;
    const dense = shieldPanelLayout(240, 1)[0]!.radius;
    expect(dense).toBeLessThan(sparse);
    // Four times the panels is half the radius: area per panel scales as 1/n.
    expect(dense).toBeCloseTo(sparse / 2, 6);
  });

  it("scales the hexagon by the overlap knob and nothing else", () => {
    const plain = shieldPanelLayout(100, 1)[0]!;
    const overlapped = shieldPanelLayout(100, 1.5)[0]!;
    expect(overlapped.radius).toBeCloseTo(plain.radius * 1.5, 6);
    expect(overlapped.nx).toBeCloseTo(plain.nx, 12);
  });

  it("is deterministic — the same shell every time it goes up", () => {
    expect(shieldPanelLayout(48, 1.1)).toEqual(shieldPanelLayout(48, 1.1));
  });

  it("gives every panel a unit tumble axis and a bounded speed", () => {
    for (const panel of shieldPanelLayout(96, 1)) {
      expect(Math.hypot(panel.spinX, panel.spinY, panel.spinZ)).toBeCloseTo(1, 6);
      expect(panel.speed).toBeGreaterThanOrEqual(0.6);
      expect(panel.speed).toBeLessThanOrEqual(1.4);
      expect(panel.jitter).toBeGreaterThanOrEqual(0);
      expect(panel.jitter).toBeLessThan(1);
    }
  });

  it("survives a degenerate count instead of returning an empty shell", () => {
    expect(shieldPanelLayout(0, 1)).toHaveLength(1);
    expect(shieldPanelLayout(-5, 1)).toHaveLength(1);
  });
});

describe("shieldPanelCount", () => {
  it("scales the authored count by the tier's budget", () => {
    expect(shieldPanelCount(120, 1)).toBe(120);
    expect(shieldPanelCount(120, 0.75)).toBe(90);
  });

  it("floors at a count that still reads as hexagons", () => {
    // A tier with particles switched off entirely still gets a legible shell:
    // the shield is combat information, not decoration.
    expect(shieldPanelCount(120, 0)).toBe(40);
    expect(shieldPanelCount(120, 0.1)).toBe(40);
  });

  it("caps what a content pack can ask ten ships to draw at once", () => {
    expect(shieldPanelCount(320, 4)).toBe(200);
  });

  it("keeps the shipped theme inside the readable band at every shipped tier", () => {
    for (const budget of [0.4, 0.7, 1, 1.25]) {
      const count = shieldPanelCount(ripple.panelCount, budget);
      expect(count).toBeGreaterThanOrEqual(40);
      expect(count).toBeLessThanOrEqual(200);
    }
  });
});

describe("panelBasis", () => {
  const out = { tx: 0, ty: 0, tz: 0, bx: 0, by: 0, bz: 0 };

  it("returns an orthonormal frame around every panel's normal", () => {
    for (const panel of layoutFor(ripple, 1)) {
      panelBasis(panel, out);
      const t = [out.tx, out.ty, out.tz];
      const b = [out.bx, out.by, out.bz];
      const n = [panel.nx, panel.ny, panel.nz];
      expect(Math.hypot(...t)).toBeCloseTo(1, 6);
      expect(Math.hypot(...b)).toBeCloseTo(1, 6);
      expect(dot(t, b)).toBeCloseTo(0, 6);
      expect(dot(t, n)).toBeCloseTo(0, 6);
      expect(dot(b, n)).toBeCloseTo(0, 6);
    }
  });

  it("does not degenerate for a normal aligned with a world axis", () => {
    // The naive "cross with up" basis blows up exactly here.
    for (const n of [
      { nx: 1, ny: 0, nz: 0 },
      { nx: 0, ny: 1, nz: 0 },
      { nx: 0, ny: 0, nz: 1 },
      { nx: 0, ny: -1, nz: 0 },
    ]) {
      panelBasis(n, out);
      expect(Math.hypot(out.tx, out.ty, out.tz)).toBeCloseTo(1, 6);
      expect(Math.hypot(out.bx, out.by, out.bz)).toBeCloseTo(1, 6);
    }
  });
});

describe("hash01", () => {
  it("stays inside 0..1 and spreads across it", () => {
    let low = 0;
    let high = 0;
    for (let i = 0; i < 500; i++) {
      const v = hash01(i);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      if (v < 0.5) low++;
      else high++;
    }
    // Not a statistics test — just proof it is not a constant or a ramp.
    expect(low).toBeGreaterThan(150);
    expect(high).toBeGreaterThan(150);
  });
});

function dot(a: number[], b: number[]): number {
  return a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
}

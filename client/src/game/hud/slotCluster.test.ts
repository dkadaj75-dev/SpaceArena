import { describe, expect, it } from "vitest";
import { anchoredOffset } from "./flightHudLayout.js";
import {
  SLOT_MIN_SIZE_PX,
  SLOT_PITCH_RATIO,
  SLOT_SIDE_ANCHORS,
  SLOT_STAGGER_RATIO,
  resolveSlotCluster,
  slotClusterRows,
  slotNumberLabel,
  slotSizePx,
  slotsPerRow,
} from "./slotCluster.js";

describe("slot diameter ramp", () => {
  it("hits the owner's three authored sizes exactly", () => {
    expect(slotSizePx(2)).toBe(82);
    expect(slotSizePx(4)).toBe(70);
    expect(slotSizePx(6)).toBe(58);
  });

  it("interpolates the counts between them instead of stepping", () => {
    expect(slotSizePx(3)).toBe(76);
    expect(slotSizePx(5)).toBe(64);
    // Strictly decreasing across the whole practical range.
    for (let n = 2; n < 8; n++) expect(slotSizePx(n + 1)).toBeLessThan(slotSizePx(n));
  });

  it("never goes below the 44 px touch target, however dense the fitting", () => {
    expect(slotSizePx(9)).toBe(SLOT_MIN_SIZE_PX);
    expect(slotSizePx(24)).toBe(SLOT_MIN_SIZE_PX);
    // …and the floor survives the viewport clamp, which is the case that would
    // otherwise produce an unhittable button on a narrow phone.
    expect(slotSizePx(6, { viewport: { width: 300, height: 640 } })).toBe(SLOT_MIN_SIZE_PX);
  });

  it("caps a one-mount hull rather than extrapolating the ramp", () => {
    expect(slotSizePx(1)).toBe(88);
    expect(slotSizePx(0)).toBe(0);
  });

  it("shrinks so one cluster keeps under half the viewport width", () => {
    const narrow = slotSizePx(4, { viewport: { width: 360, height: 780 } });
    expect(narrow).toBeLessThan(70);
    const cluster = resolveSlotCluster(4, "weapons", { viewport: { width: 360, height: 780 } });
    const widest = Math.max(...cluster.slots.map((s) => s.offsetXPx + s.sizePx));
    expect(widest).toBeLessThanOrEqual(360 * 0.44);
  });

  it("scales with theme.hud.scale like every other HUD dimension", () => {
    expect(slotSizePx(4, { scale: 0.5 })).toBe(35);
  });
});

describe("slot cluster shape", () => {
  it("reproduces the drawn shapes: 2 stacked, 4 as 2x2, 6 as two rows of three", () => {
    expect(slotsPerRow(2)).toBe(1);
    expect(slotClusterRows(2)).toEqual([1, 1]);
    expect(slotClusterRows(4)).toEqual([2, 2]);
    expect(slotClusterRows(6)).toEqual([3, 3]);
  });

  it("balances an odd fitting instead of leaving a straggler row", () => {
    expect(slotClusterRows(3)).toEqual([2, 1]);
    expect(slotClusterRows(5)).toEqual([3, 2]);
    expect(slotClusterRows(7)).toEqual([3, 2, 2]);
    expect(slotClusterRows(8)).toEqual([3, 3, 2]);
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      expect(slotClusterRows(n).reduce((a, b) => a + b, 0)).toBe(n);
    }
  });

  it("puts slot 01 nearest the corner and staggers the rows behind it", () => {
    const cluster = resolveSlotCluster(6, "weapons");
    const [first] = cluster.slots;
    expect(first!.index).toBe(0);
    expect(first!.row).toBe(0);
    expect(first!.column).toBe(0);
    // Nothing is closer to the corner on either axis.
    for (const slot of cluster.slots) {
      expect(slot.offsetXPx).toBeGreaterThanOrEqual(first!.offsetXPx);
      expect(slot.offsetYPx).toBeGreaterThanOrEqual(first!.offsetYPx);
    }
    // Row 1 is inset along its row axis — the stagger that makes it a cluster
    // rather than a grid.
    const rowOne = cluster.slots.filter((s) => s.row === 1);
    const rowZero = cluster.slots.filter((s) => s.row === 0);
    expect(rowOne[0]!.offsetXPx - rowZero[0]!.offsetXPx).toBeCloseTo(
      cluster.sizePx * SLOT_STAGGER_RATIO,
      6,
    );
  });

  it("spaces a row so its buttons cannot touch", () => {
    const cluster = resolveSlotCluster(6, "weapons");
    const rowZero = cluster.slots.filter((s) => s.row === 0);
    const gap = rowZero[1]!.offsetXPx - rowZero[0]!.offsetXPx;
    expect(gap).toBeCloseTo(cluster.sizePx * SLOT_PITCH_RATIO, 6);
    expect(gap).toBeGreaterThan(cluster.sizePx);
  });

  it("gives every slot in a cluster the SAME diameter — no pedestal", () => {
    for (const n of [1, 2, 3, 4, 5, 6, 7]) {
      const sizes = new Set(resolveSlotCluster(n, "utilities").slots.map((s) => s.sizePx));
      expect(sizes.size).toBe(1);
    }
  });

  it("anchors weapons bottom-right and utilities bottom-left", () => {
    expect(SLOT_SIDE_ANCHORS.weapons).toBe("bottom-right");
    expect(SLOT_SIDE_ANCHORS.utilities).toBe("bottom-left");
    expect(resolveSlotCluster(2, "weapons").anchor).toBe("bottom-right");
    expect(resolveSlotCluster(2, "utilities").anchor).toBe("bottom-left");
  });

  it("mirrors into the corner it is anchored to", () => {
    const right = resolveSlotCluster(4, "weapons").slots[1]!;
    const left = resolveSlotCluster(4, "utilities").slots[1]!;
    const r = anchoredOffset(right.anchor, right.offsetXPx, right.offsetYPx, right.sizePx / 2);
    const l = anchoredOffset(left.anchor, left.offsetXPx, left.offsetYPx, left.sizePx / 2);
    // Same distance from its own corner, opposite direction; both sit ABOVE it.
    expect(r.dx).toBeCloseTo(-l.dx, 6);
    expect(r.dy).toBeCloseTo(l.dy, 6);
    expect(r.dy).toBeLessThan(0);
  });

  it("is empty for an empty side", () => {
    expect(resolveSlotCluster(0, "weapons").slots).toEqual([]);
  });
});

describe("slot numbering", () => {
  it("pads to two digits the way the buttons print it", () => {
    expect(slotNumberLabel(1)).toBe("01");
    expect(slotNumberLabel(9)).toBe("09");
    expect(slotNumberLabel(10)).toBe("10");
    expect(slotNumberLabel(12)).toBe("12");
  });
});

import { describe, expect, it } from "vitest";
import { swapFrame, SWAP_DURATION_SEC } from "./shipSwap.js";

const D = 10;

describe("swapFrame (owner 2026-08-01)", () => {
  it("starts and ends centred — the hull is only off-centre mid-transition", () => {
    expect(swapFrame(0, 1, D).offset).toBeCloseTo(0, 6);
    expect(swapFrame(SWAP_DURATION_SEC, 1, D).offset).toBeCloseTo(0, 6);
  });

  it("sends the hull the OPPOSITE way to the arrow", () => {
    // Right arrow (next): the ship on screen leaves to the left.
    expect(swapFrame(SWAP_DURATION_SEC * 0.35, 1, D).offset).toBeLessThan(0);
    // Left arrow (previous): it leaves to the right.
    expect(swapFrame(SWAP_DURATION_SEC * 0.35, -1, D).offset).toBeGreaterThan(0);
  });

  it("brings the new hull in from the far side, the way it is being asked to come", () => {
    // Right arrow: the incoming ship enters from the right and settles at 0.
    const entering = swapFrame(SWAP_DURATION_SEC * 0.6, 1, D);
    expect(entering.swapped).toBe(true);
    expect(entering.offset).toBeGreaterThan(0);
    expect(swapFrame(SWAP_DURATION_SEC * 0.95, 1, D).offset).toBeLessThan(entering.offset);
  });

  it("swaps the model exactly at the midpoint, and only once", () => {
    expect(swapFrame(SWAP_DURATION_SEC * 0.49, 1, D).swapped).toBe(false);
    expect(swapFrame(SWAP_DURATION_SEC * 0.5, 1, D).swapped).toBe(true);
    expect(swapFrame(SWAP_DURATION_SEC * 0.99, 1, D).swapped).toBe(true);
  });

  it("never travels further than the distance it was given", () => {
    for (let i = 0; i <= 40; i++) {
      const f = swapFrame((SWAP_DURATION_SEC * i) / 40, 1, D);
      expect(Math.abs(f.offset)).toBeLessThanOrEqual(D + 1e-9);
    }
  });

  it("fades on the way out and back in, and is solid at both ends", () => {
    expect(swapFrame(0, 1, D).visibility).toBeCloseTo(1, 6);
    expect(swapFrame(SWAP_DURATION_SEC, 1, D).visibility).toBeCloseTo(1, 6);
    expect(swapFrame(SWAP_DURATION_SEC * 0.5, 1, D).visibility).toBeLessThan(0.3);
  });

  it("reports done only at the end, and clamps past it", () => {
    expect(swapFrame(SWAP_DURATION_SEC * 0.9, 1, D).done).toBe(false);
    expect(swapFrame(SWAP_DURATION_SEC, 1, D).done).toBe(true);
    const past = swapFrame(SWAP_DURATION_SEC * 5, 1, D);
    expect(past.done).toBe(true);
    expect(past.offset).toBeCloseTo(0, 6);
  });

  it("degenerates safely when handed a zero duration", () => {
    const f = swapFrame(0, 1, D, 0);
    expect(f).toEqual({ offset: 0, visibility: 1, swapped: true, done: true });
  });
});

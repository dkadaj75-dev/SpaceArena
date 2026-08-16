import { describe, expect, it } from "vitest";
import { adaptiveRenderDelay, bracket, decayCorrection, lerpHeading, RENDER_DELAY_CEIL_MS, timeBasedPull, WIDEN_MS_PER_SECOND } from "./interpolation.js";
import { decodeCenti, decodeHeading, encodeCenti, encodeHeading } from "@space-arena/shared";

describe("net interpolation", () => {
  it("brackets snapshots and caps extrapolation to one interval", () => { const r = bracket([{ time: 0 }, { time: 50 }], 200)!; expect(r[2]).toBe(1); expect(bracket([{ time: 0 }, { time: 50 }], 25)![2]).toBe(.5); });
  it("takes the short heading arc", () => expect(Math.abs(lerpHeading(6.2, .1, .5) - Math.PI * 2)).toBeLessThan(.2));
  it("decays small corrections and snaps large ones", () => { expect(decayCorrection(1, 1, 10)).toBeLessThan(.001); expect(decayCorrection(4, .1, 10)).toBe(0); });
  // Position rides a deci-unit wire since the CTF arena doubled (2026-08-05).
  it("round trips wire quantization", () => { expect(decodeCenti(encodeCenti(12.345))).toBeCloseTo(12.3, 1); expect(decodeHeading(encodeHeading(-.4))).toBeCloseTo(Math.PI * 2 - .4, 3); });
  it("pulls authoritative attitude equally over time at 30 and 144 FPS", () => {
    const residualAfterOneSecond = (fps: number): number => {
      let error = 1;
      for (let frame = 0; frame < fps; frame++) error *= 1 - timeBasedPull(0.15, 1 / fps);
      return error;
    };
    expect(residualAfterOneSecond(30)).toBeCloseTo(residualAfterOneSecond(144), 12);
    expect(timeBasedPull(0.15, 1 / 60)).toBeCloseTo(0.15, 12);
  });
});

describe("adaptiveRenderDelay", () => {
  const dt = 1 / 60;

  it("stays at the authored floor on a calm network", () => {
    // Steady 50 ms patches want 2×p90 = 100 = the floor: behaviour unchanged.
    const gaps = Array.from({ length: 20 }, () => 50);
    expect(adaptiveRenderDelay(100, gaps, 100, dt)).toBe(100);
  });

  it("holds the floor until enough gaps exist to say anything", () => {
    // The first patches of a match must not swing the delay on noise.
    expect(adaptiveRenderDelay(100, [], 100, dt)).toBe(100);
    expect(adaptiveRenderDelay(100, [200, 210, 190], 100, dt)).toBe(100);
  });

  it("widens FAST but never steps — a delay step is a backward step in render time", () => {
    // The measured localhost profile: ~62 ms median with bursts. 2×p90 keeps a
    // full burst of headroom between the render point and the newest snapshot.
    const gaps = [60, 62, 61, 95, 63, 62, 90, 61, 64, 62];
    // One frame moves at most one frame's worth of widening. The first cut
    // jumped the full width here, and every up-jump rewound `now - delay` —
    // the owner saw remote ships hitch backwards once per burst sample.
    const oneFrame = adaptiveRenderDelay(100, gaps, 100, dt);
    expect(oneFrame).toBeCloseTo(100 + WIDEN_MS_PER_SECOND * dt, 6);
    // A zero-dt frame moves nothing at all.
    expect(adaptiveRenderDelay(100, gaps, 100, 0)).toBe(100);
    // But it converges onto the burst target inside a second of frames.
    let delay = 100;
    for (let i = 0; i < 60; i++) delay = adaptiveRenderDelay(delay, gaps, 100, dt);
    expect(delay).toBeGreaterThan(150);
  });

  it("narrows SLOWLY once the network calms down", () => {
    const calm = Array.from({ length: 20 }, () => 50);
    // Recovering from a 250 ms burst delay: one frame moves a fraction of a
    // millisecond — the timeline replays faster than real time, and doing this
    // abruptly is itself a visible speed-up.
    const oneFrame = adaptiveRenderDelay(250, calm, 100, dt);
    expect(oneFrame).toBeLessThan(250);
    expect(oneFrame).toBeGreaterThan(249);
    // A second of calm frames recovers ~15 ms; ten seconds recovers the burst.
    let delay = 250;
    for (let i = 0; i < 600; i++) delay = adaptiveRenderDelay(delay, calm, 100, dt);
    expect(delay).toBeLessThan(250 - 140);
    expect(delay).toBeGreaterThanOrEqual(100);
  });

  it("never exceeds the ceiling however bad the jitter gets", () => {
    const awful = Array.from({ length: 20 }, () => 400);
    let delay = 100;
    for (let i = 0; i < 300; i++) delay = adaptiveRenderDelay(delay, awful, 100, dt);
    expect(delay).toBe(RENDER_DELAY_CEIL_MS);
  });

  it("never drops below the authored floor", () => {
    // A network faster than the floor asks for less; the floor wins.
    const fast = Array.from({ length: 20 }, () => 20);
    expect(adaptiveRenderDelay(100, fast, 100, dt)).toBe(100);
  });
});

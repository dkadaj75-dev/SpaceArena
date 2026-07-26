import { describe, it, expect, vi } from "vitest";
import { GameLoop } from "./GameLoop.js";
import { SIM_TICK_RATE } from "../constants.js";

describe("GameLoop", () => {
  it("defaults to SIM_TICK_RATE and derives fixed dt", () => {
    const loop = new GameLoop(() => {});
    expect(loop.tickRate).toBe(SIM_TICK_RATE);
    expect(loop.fixedDtMs).toBeCloseTo(1000 / SIM_TICK_RATE);
    expect(loop.fixedDtSeconds).toBeCloseTo(1 / SIM_TICK_RATE);
  });

  it("accumulates and runs the correct number of ticks", () => {
    const tick = vi.fn();
    const loop = new GameLoop(tick, { tickRate: 30 }); // 33.333 ms/tick

    expect(loop.step(16)).toBe(0); // not enough yet
    expect(loop.step(16)).toBe(0); // 32 ms accumulated
    expect(loop.step(16)).toBe(1); // 48 ms -> one tick, 14.67 remainder
    expect(loop.totalTicks).toBe(1);

    expect(loop.step(100)).toBe(3); // 114.67 -> 3 ticks
    expect(loop.totalTicks).toBe(4);
    expect(tick).toHaveBeenCalledTimes(4);
    // tick numbers are sequential from 0
    expect(tick.mock.calls.map((c) => c[1])).toEqual([0, 1, 2, 3]);
  });

  it("passes fixed dt seconds to the tick fn", () => {
    const tick = vi.fn();
    const loop = new GameLoop(tick, { tickRate: 50 });
    loop.step(100);
    expect(tick.mock.calls[0]?.[0]).toBeCloseTo(0.02);
  });

  it("exposes alpha as the interpolation fraction", () => {
    const loop = new GameLoop(() => {}, { tickRate: 100 }); // 10 ms/tick
    loop.step(15); // one tick, 5 ms remainder -> alpha 0.5
    expect(loop.alpha).toBeCloseTo(0.5);
  });

  it("clamps the spiral of death", () => {
    const tick = vi.fn();
    const loop = new GameLoop(tick, { tickRate: 30, maxTicksPerStep: 5 });
    const ran = loop.step(100000); // huge stall
    expect(ran).toBe(5);
    // backlog dropped: accumulator reduced to sub-tick remainder
    expect(loop.alpha).toBeLessThan(1);
  });

  it("applies a hot-reloaded max-tick clamp without rebuilding the loop", () => {
    const loop = new GameLoop(() => {}, { tickRate: 30, maxTicksPerStep: 5 });
    loop.setMaxTicksPerStep(2);

    expect(loop.step(100000)).toBe(2);
    expect(() => loop.setMaxTicksPerStep(0)).toThrow(/positive integer/);
  });

  it("ignores non-positive / non-finite dt", () => {
    const tick = vi.fn();
    const loop = new GameLoop(tick);
    expect(loop.step(0)).toBe(0);
    expect(loop.step(-5)).toBe(0);
    expect(loop.step(NaN)).toBe(0);
    expect(tick).not.toHaveBeenCalled();
  });

  it("is deterministic: same dt sequence => same tick count", () => {
    const seq = [16, 16, 16, 33, 8, 50, 12, 40];
    const run = () => {
      let count = 0;
      const loop = new GameLoop(() => count++, { tickRate: 30 });
      for (const dt of seq) loop.step(dt);
      return { count, ticks: loop.totalTicks, alpha: loop.alpha };
    };
    expect(run()).toEqual(run());
  });

  it("reset clears accumulator and tick count", () => {
    const loop = new GameLoop(() => {}, { tickRate: 30 });
    loop.step(100);
    loop.reset();
    expect(loop.totalTicks).toBe(0);
    expect(loop.alpha).toBe(0);
  });

  it("rejects a non-positive tick rate", () => {
    expect(() => new GameLoop(() => {}, { tickRate: 0 })).toThrow();
  });
});

import { describe, expect, it } from "vitest";
import {
  analyzeMemoryTrend,
  analyzeTickTrend,
  auditTeardown,
  linearRegression,
  type MemorySample,
  type TickWindow,
} from "./soak.js";

const MB = 1024 * 1024;
const MINUTE = 60_000;

interface SeriesSpec {
  minutes: number;
  rssStartMb: number;
  rssGrowthMbPerHour: number;
  heapStartMb?: number;
  heapGrowthMbPerHour?: number;
  /** Deterministic sawtooth amplitude applied to heapUsed (a stand-in for GC). */
  heapNoiseMb?: number;
  rssNoiseMb?: number;
}

/** A memory series, one sample a minute. Deterministic — these tests never flake. */
function series(spec: SeriesSpec): MemorySample[] {
  const {
    minutes,
    rssStartMb,
    rssGrowthMbPerHour,
    heapStartMb = 60,
    heapGrowthMbPerHour = 0,
    heapNoiseMb = 0,
    rssNoiseMb = 0,
  } = spec;
  const out: MemorySample[] = [];
  for (let i = 0; i <= minutes; i++) {
    const rssNoise = rssNoiseMb === 0 ? 0 : Math.sin(i * 2.399) * rssNoiseMb;
    const heapNoise = heapNoiseMb === 0 ? 0 : Math.sin(i * 1.777) * heapNoiseMb;
    out.push({
      atMs: i * MINUTE,
      rss: (rssStartMb + (rssGrowthMbPerHour * i) / 60 + rssNoise) * MB,
      heapUsed: (heapStartMb + (heapGrowthMbPerHour * i) / 60 + heapNoise) * MB,
    });
  }
  return out;
}

/** A flat, healthy hour: no growth in either series, heap sawtoothing on GC. */
const healthyHour = (): MemorySample[] =>
  series({ minutes: 60, rssStartMb: 200, rssGrowthMbPerHour: 0, heapNoiseMb: 25 });

describe("linearRegression", () => {
  it("recovers the slope and intercept of a clean line", () => {
    const fit = linearRegression([
      { x: 0, y: 10 },
      { x: 1, y: 12 },
      { x: 2, y: 14 },
      { x: 3, y: 16 },
    ]);
    expect(fit.slope).toBeCloseTo(2, 10);
    expect(fit.intercept).toBeCloseTo(10, 10);
    expect(fit.r2).toBeCloseTo(1, 10);
  });

  it("reports a flat line as zero slope with a perfect fit", () => {
    const fit = linearRegression([
      { x: 0, y: 5 },
      { x: 1, y: 5 },
      { x: 2, y: 5 },
    ]);
    expect(fit.slope).toBeCloseTo(0, 10);
    expect(fit.r2).toBe(1);
  });

  it("gives a near-zero r² for pure scatter", () => {
    const fit = linearRegression([
      { x: 0, y: 0 },
      { x: 1, y: 10 },
      { x: 2, y: 10 },
      { x: 3, y: 0 },
    ]);
    expect(fit.r2).toBeLessThan(0.05);
  });

  it("degrades safely on 0 and 1 points, and on zero x-spread", () => {
    expect(linearRegression([])).toEqual({ slope: 0, intercept: 0, r2: 0 });
    expect(linearRegression([{ x: 3, y: 7 }])).toEqual({ slope: 0, intercept: 7, r2: 0 });
    expect(
      linearRegression([
        { x: 1, y: 2 },
        { x: 1, y: 8 },
      ]).slope,
    ).toBe(0);
  });
});

describe("analyzeMemoryTrend", () => {
  it("passes a flat one-hour curve whose heap only sawtooths", () => {
    const result = analyzeMemoryTrend(healthyHour());
    expect(result.verdict).toBe("pass");
    expect(result.heap.r2).toBeLessThan(0.5);
    expect(result.rss.slopeBytesPerHour).toBeCloseTo(0, 0);
  });

  it("fails a monotonic heap climb past the budget", () => {
    const result = analyzeMemoryTrend(
      series({ minutes: 60, rssStartMb: 200, rssGrowthMbPerHour: 60, heapGrowthMbPerHour: 48 }),
    );
    expect(result.verdict).toBe("fail");
    expect(result.heap.slopeBytesPerHour / MB).toBeCloseTo(48, 0);
    expect(result.reason).toMatch(/heapUsed grew/);
  });

  it("passes heap growth that is inside the budget", () => {
    const result = analyzeMemoryTrend(series({ minutes: 60, rssStartMb: 200, rssGrowthMbPerHour: 20, heapGrowthMbPerHour: 12 }));
    expect(result.verdict).toBe("pass");
  });

  it("passes RSS creep while the heap stays flat — the real-world allocator case", () => {
    // Measured shape: a leak-free churning server creeps ~40 MB/h of RSS at a
    // high r² while heapUsed sawtooths around a flat mean. This must not fail.
    const result = analyzeMemoryTrend(
      series({ minutes: 60, rssStartMb: 120, rssGrowthMbPerHour: 40, heapNoiseMb: 25 }),
    );
    expect(result.rss.r2).toBeGreaterThan(0.9);
    expect(result.rss.slopeBytesPerHour / MB).toBeCloseTo(40, 0);
    expect(result.verdict).toBe("pass");
  });

  it("still fails RSS growth that is extreme even with a flat heap", () => {
    const result = analyzeMemoryTrend(
      series({ minutes: 60, rssStartMb: 200, rssGrowthMbPerHour: 400, heapNoiseMb: 25 }),
    );
    expect(result.verdict).toBe("fail");
    expect(result.reason).toMatch(/native\/allocator/);
  });

  it("does not cry leak on a steep but uncorrelated heap sawtooth", () => {
    // Big swings, no real trend: a garbage collector, not a leak.
    const result = analyzeMemoryTrend(
      series({ minutes: 60, rssStartMb: 200, rssGrowthMbPerHour: 0, heapGrowthMbPerHour: 40, heapNoiseMb: 200 }),
    );
    expect(result.heap.r2).toBeLessThan(0.5);
    expect(result.verdict).toBe("pass");
  });

  it("refuses a verdict on a run that is too short or too sparse", () => {
    expect(analyzeMemoryTrend(series({ minutes: 3, rssStartMb: 200, rssGrowthMbPerHour: 500 })).verdict).toBe("insufficient-data");
    expect(analyzeMemoryTrend([]).verdict).toBe("insufficient-data");
    // Ten minutes of dense sampling leaves under seven minutes after warm-up.
    const dense: MemorySample[] = Array.from({ length: 61 }, (_, i) => ({
      atMs: i * 10_000,
      rss: (200 + i) * MB,
      heapUsed: 80 * MB,
    }));
    const result = analyzeMemoryTrend(dense);
    expect(result.verdict).toBe("insufficient-data");
    expect(result.reason).toMatch(/run for at least/);
  });

  it("drops a warm-up ramp that would otherwise tilt the whole line", () => {
    // Flat hour with a steep ramp over the first fifteen minutes — the measured
    // failure mode: a whole-run fit reads that ramp as a leak.
    const samples = healthyHour();
    for (let i = 0; i <= 15; i++) samples[i]!.rss = (120 + i * 5) * MB;
    expect(analyzeMemoryTrend(samples).verdict).toBe("pass");
    // Fitting the ramp in (no warm-up prefix) would have reported real growth.
    const naive = analyzeMemoryTrend(samples, { warmupFraction: 0, warmupMs: 0 });
    expect(naive.rss.slopeBytesPerHour).toBeGreaterThan(analyzeMemoryTrend(samples).rss.slopeBytesPerHour);
  });

  it("fits only the post-warm-up window and says how long that was", () => {
    const result = analyzeMemoryTrend(healthyHour());
    // One third of a 60-minute run dropped ⇒ a 40-minute fitted window.
    expect(result.durationMs / MINUTE).toBeCloseTo(40, 0);
    expect(result.samples).toBe(41);
  });

  it("honours explicit budget overrides", () => {
    const samples = series({ minutes: 60, rssStartMb: 200, rssGrowthMbPerHour: 20, heapGrowthMbPerHour: 12 });
    expect(analyzeMemoryTrend(samples, { maxHeapSlopeBytesPerHour: 4 * MB }).verdict).toBe("fail");
    expect(analyzeMemoryTrend(samples, { maxRssSlopeBytesPerHour: 8 * MB }).verdict).toBe("fail");
  });
});

describe("analyzeTickTrend", () => {
  const flat = (count: number, p95: number): TickWindow[] =>
    Array.from({ length: count }, (_, i) => ({ atMs: i * 10_000, avgMs: p95 / 2, p95Ms: p95, count: 300 }));

  it("passes a stable tick", () => {
    expect(analyzeTickTrend(flat(20, 0.3)).verdict).toBe("pass");
  });

  it("fails a late degradation", () => {
    const windows = flat(20, 0.3);
    for (let i = 15; i < 20; i++) windows[i]!.p95Ms = 12;
    const result = analyzeTickTrend(windows);
    expect(result.verdict).toBe("fail");
    expect(result.lateP95Ms).toBeGreaterThan(result.earlyP95Ms);
  });

  it("tolerates sub-millisecond wobble that is technically a big ratio", () => {
    // 0.10 → 0.16 ms is +60 %, but is 0.06 ms of noise against a 33 ms budget.
    const windows = flat(20, 0.1);
    for (let i = 15; i < 20; i++) windows[i]!.p95Ms = 0.16;
    expect(analyzeTickTrend(windows).verdict).toBe("pass");
  });

  it("compares quarters, so a mid-run spike alone does not fail it", () => {
    const windows = flat(20, 0.3);
    for (let i = 8; i < 12; i++) windows[i]!.p95Ms = 20;
    expect(analyzeTickTrend(windows).verdict).toBe("pass");
  });

  it("refuses a verdict with too few populated windows", () => {
    expect(analyzeTickTrend(flat(3, 0.3)).verdict).toBe("insufficient-data");
    // Windows with no ticks do not count towards the minimum.
    const empty = flat(20, 0.3).map((w) => ({ ...w, count: 0 }));
    expect(analyzeTickTrend(empty).verdict).toBe("insufficient-data");
  });
});

describe("auditTeardown", () => {
  const baseline = { roomCount: 0, rss: 120 * MB, heapUsed: 28 * MB };

  it("passes when rooms drain and memory returns near baseline", () => {
    const audit = auditTeardown(baseline, { roomCount: 0, rss: 150 * MB, heapUsed: 30 * MB });
    expect(audit.verdict).toBe("pass");
    expect(audit.findings.every((f) => f.startsWith("PASS"))).toBe(true);
  });

  it("fails when a room survives teardown", () => {
    const audit = auditTeardown(baseline, { roomCount: 3, rss: 130 * MB, heapUsed: 29 * MB });
    expect(audit.verdict).toBe("fail");
    expect(audit.roomsRemaining).toBe(3);
    expect(audit.findings[0]).toMatch(/^FAIL rooms after teardown: 3/);
  });

  it("fails on retained heap even when the room count is clean", () => {
    const audit = auditTeardown(baseline, { roomCount: 0, rss: 130 * MB, heapUsed: 300 * MB });
    expect(audit.verdict).toBe("fail");
    expect(audit.heapGrowthBytes).toBe(272 * MB);
  });

  it("tolerates RSS the allocator never handed back, since heapUsed is the evidence", () => {
    const audit = auditTeardown(baseline, { roomCount: 0, rss: 300 * MB, heapUsed: 29 * MB });
    expect(audit.verdict).toBe("pass");
    expect(audit.rssGrowthBytes).toBe(180 * MB);
  });

  it("fails RSS growth beyond even that loose budget", () => {
    expect(auditTeardown(baseline, { roomCount: 0, rss: 900 * MB, heapUsed: 29 * MB }).verdict).toBe("fail");
  });
});

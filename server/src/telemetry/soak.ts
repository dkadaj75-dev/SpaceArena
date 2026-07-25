/**
 * Soak-run analysis (ROADMAP §11 6.6) — pure functions, no I/O.
 *
 * The load-test harness collects a time series of server samples and hands it
 * here; everything that decides "is this a leak?" or "did the tick degrade?"
 * lives in this file so it can be unit-tested against synthetic curves instead
 * of a one-hour run.
 *
 * All three analyses answer with an explicit verdict rather than a boolean, so
 * the report can distinguish "passed" from "could not tell" — a 60-second smoke
 * run genuinely cannot detect a slow leak, and pretending otherwise would make
 * the gate worthless.
 */

// ---------------------------------------------------------------------------
// Least squares
// ---------------------------------------------------------------------------

export interface Point {
  x: number;
  y: number;
}

export interface Regression {
  /** Change in y per unit of x. */
  slope: number;
  /** y at x = 0. */
  intercept: number;
  /**
   * Coefficient of determination (0..1): how much of the variance the line
   * explains. A large slope with a low r² is drift/noise, not a trend, which is
   * exactly the difference between "GC hasn't run yet" and "we are leaking".
   */
  r2: number;
}

/**
 * Ordinary least-squares fit. Returns an all-zero regression for fewer than two
 * points or for a series with no spread in x (every sample at the same instant),
 * because a line through one point has no meaningful slope.
 */
export function linearRegression(points: readonly Point[]): Regression {
  const n = points.length;
  if (n < 2) return { slope: 0, intercept: n === 1 ? points[0]!.y : 0, r2: 0 };

  let sumX = 0;
  let sumY = 0;
  for (const p of points) {
    sumX += p.x;
    sumY += p.y;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;

  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of points) {
    const dx = p.x - meanX;
    const dy = p.y - meanY;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  if (sxx === 0) return { slope: 0, intercept: meanY, r2: 0 };

  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;
  const r2 = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy);
  return { slope, intercept, r2 };
}

// ---------------------------------------------------------------------------
// Memory trend
// ---------------------------------------------------------------------------

/** One periodic memory reading from the server process. */
export interface MemorySample {
  /** Milliseconds since the run started. */
  atMs: number;
  rss: number;
  heapUsed: number;
}

export type Verdict = "pass" | "fail" | "insufficient-data";

/** One fitted series. */
export interface SeriesTrend {
  /** Fitted growth in bytes per hour (negative = shrinking). */
  slopeBytesPerHour: number;
  r2: number;
  first: number;
  last: number;
  peak: number;
}

export interface MemoryTrend {
  verdict: Verdict;
  /**
   * The leak assertion. A retained room, an uncleared timer or a held-open bot
   * driver all keep JavaScript objects reachable, which is precisely what
   * `heapUsed` measures.
   */
  heap: SeriesTrend;
  /** Reported and loosely bounded — see {@link MemoryTrendOptions.maxRssSlopeBytesPerHour}. */
  rss: SeriesTrend;
  samples: number;
  /** Length of the *fitted* window, after the warm-up prefix was dropped. */
  durationMs: number;
  /** Human-readable justification, always populated. */
  reason: string;
}

export interface MemoryTrendOptions {
  /**
   * Heap growth above this is a leak. 24 MB/h: measured on a churning 8-room
   * run, a healthy `heapUsed` series has **no trend at all** (r² ≈ 0.01 — a pure
   * GC sawtooth around a flat mean), so anything with both a real slope and a
   * real correlation is a genuine retention.
   */
  maxHeapSlopeBytesPerHour?: number;
  /**
   * RSS growth above this fails too, but the bar is far higher and it is not the
   * primary signal.
   *
   * Measured: a leak-free server churning 262 room create/dispose cycles over
   * twelve minutes still creeps 30-60 MB/h of RSS in steady state at r² ≈ 0.8,
   * while its `heapUsed` stays flat and returns to within 1 MB of baseline once
   * the rooms are gone. That creep is allocator and page-retention behaviour,
   * not retained objects — V8 and the system allocator hold freed pages rather
   * than returning them. Asserting on RSS at a tight threshold therefore fails
   * healthy runs, which is why it sits at 128 MB/h and why `heapUsed` carries
   * the verdict.
   */
  maxRssSlopeBytesPerHour?: number;
  /**
   * A slope this weakly correlated is drift, not a trend. Below it the verdict
   * passes regardless of magnitude (and says so).
   */
  minR2?: number;
  /** Minimum samples in the fitted window before a verdict is possible. */
  minSamples?: number;
  /**
   * Minimum length of the **fitted** window. Seven minutes is ~42 samples at the
   * harness's 10 s cadence, spanning several full GC cycles — enough for the
   * sawtooth to average out.
   */
  minDurationMs?: number;
  /**
   * Drop this fraction of the run before fitting. The working set takes minutes
   * to settle (lazy module init, the SQLite page cache, V8 growing old space in
   * steps), and that ramp is one-off growth that would otherwise tilt the line:
   * on the measured 12-minute run the whole-run RSS fit reads 417 MB/h, the
   * post-ramp fit 38 MB/h. Dropping a prefix costs nothing for detection — a
   * leak is linear, so its slope is the same on any subinterval.
   */
  warmupFraction?: number;
  /** Floor on the warm-up prefix, for runs short enough that the fraction is tiny. */
  warmupMs?: number;
}

export const DEFAULT_MEMORY_TREND_OPTIONS: Required<MemoryTrendOptions> = {
  maxHeapSlopeBytesPerHour: 24 * 1024 * 1024,
  maxRssSlopeBytesPerHour: 128 * 1024 * 1024,
  minR2: 0.5,
  minSamples: 6,
  minDurationMs: 7 * 60 * 1000,
  warmupFraction: 1 / 3,
  warmupMs: 60 * 1000,
};

function seriesTrend(samples: readonly MemorySample[], pick: (s: MemorySample) => number): SeriesTrend {
  const values = samples.map(pick);
  const fit = linearRegression(samples.map((s) => ({ x: s.atMs, y: pick(s) })));
  return {
    slopeBytesPerHour: fit.slope * 3600_000,
    r2: fit.r2,
    first: values[0] ?? 0,
    last: values[values.length - 1] ?? 0,
    peak: values.length === 0 ? 0 : Math.max(...values),
  };
}

/**
 * Fit memory against time and decide whether the process is leaking.
 *
 * Two conditions must both hold for a series to fail: its slope exceeds the
 * budget **and** the fit explains at least `minR2` of the variance. A steep line
 * through scattered points is a garbage collector that has not run yet; a
 * correlated climb is retention. Requiring both is what keeps this from crying
 * wolf on every healthy run.
 */
export function analyzeMemoryTrend(samples: readonly MemorySample[], options: MemoryTrendOptions = {}): MemoryTrend {
  const opts = { ...DEFAULT_MEMORY_TREND_OPTIONS, ...options };
  const runMs = samples.length === 0 ? 0 : samples[samples.length - 1]!.atMs - samples[0]!.atMs;
  const warmupMs = Math.max(opts.warmupMs, runMs * opts.warmupFraction);
  const considered = samples.filter((s) => s.atMs >= warmupMs);
  const used = considered.length >= opts.minSamples ? considered : samples;

  const durationMs = used.length === 0 ? 0 : used[used.length - 1]!.atMs - used[0]!.atMs;
  const heap = seriesTrend(used, (s) => s.heapUsed);
  const rss = seriesTrend(used, (s) => s.rss);
  const base = { heap, rss, samples: used.length, durationMs };

  if (used.length < opts.minSamples) {
    return { ...base, verdict: "insufficient-data", reason: `only ${used.length} sample(s) after warm-up; need ${opts.minSamples}` };
  }
  if (durationMs < opts.minDurationMs) {
    return {
      ...base,
      verdict: "insufficient-data",
      reason:
        `fitted window is ${(durationMs / 60000).toFixed(1)} min after dropping warm-up; ` +
        `a leak verdict needs ${(opts.minDurationMs / 60000).toFixed(0)} min ` +
        `(run for at least ${((opts.minDurationMs / (1 - opts.warmupFraction)) / 60000).toFixed(0)} min)`,
    };
  }

  const heapLeaking = heap.slopeBytesPerHour > opts.maxHeapSlopeBytesPerHour && heap.r2 >= opts.minR2;
  const rssLeaking = rss.slopeBytesPerHour > opts.maxRssSlopeBytesPerHour && rss.r2 >= opts.minR2;

  if (heapLeaking) {
    return {
      ...base,
      verdict: "fail",
      reason: `heapUsed grew ${mb(heap.slopeBytesPerHour)}/h (r²=${heap.r2.toFixed(2)}), over the ${mb(opts.maxHeapSlopeBytesPerHour)}/h budget`,
    };
  }
  if (rssLeaking) {
    return {
      ...base,
      verdict: "fail",
      reason: `rss grew ${mb(rss.slopeBytesPerHour)}/h (r²=${rss.r2.toFixed(2)}), over the ${mb(opts.maxRssSlopeBytesPerHour)}/h budget, while heapUsed stayed flat — suspect a native/allocator leak`,
    };
  }
  return {
    ...base,
    verdict: "pass",
    reason:
      `heapUsed ${mb(heap.slopeBytesPerHour)}/h (r²=${heap.r2.toFixed(2)}) within ${mb(opts.maxHeapSlopeBytesPerHour)}/h, ` +
      `rss ${mb(rss.slopeBytesPerHour)}/h (r²=${rss.r2.toFixed(2)}) within ${mb(opts.maxRssSlopeBytesPerHour)}/h`,
  };
}

// ---------------------------------------------------------------------------
// Tick degradation
// ---------------------------------------------------------------------------

/** One window of tick statistics, in run order. */
export interface TickWindow {
  atMs: number;
  avgMs: number;
  p95Ms: number;
  count: number;
}

export interface TickTrend {
  verdict: Verdict;
  /** Mean p95 across the first quarter of the run. */
  earlyP95Ms: number;
  /** Mean p95 across the last quarter of the run. */
  lateP95Ms: number;
  ratio: number;
  reason: string;
}

export interface TickTrendOptions {
  /** Late p95 may be at most this multiple of the early p95. */
  maxRatio?: number;
  /**
   * Absolute slack (ms) added to the allowance. Without it a healthy
   * 0.10 ms → 0.16 ms wobble reads as "60 % degradation"; with it, only a
   * degradation that actually eats into the 33 ms step budget can fail.
   */
  slackMs?: number;
  /** Minimum windows (total, across the run) before a verdict is possible. */
  minWindows?: number;
}

export const DEFAULT_TICK_TREND_OPTIONS: Required<TickTrendOptions> = {
  maxRatio: 1.5,
  slackMs: 0.5,
  minWindows: 8,
};

/**
 * Compare the first quarter of the run against the last. Quarters rather than
 * halves because degradation is usually late and gradual — averaging it over
 * half the run dilutes exactly the signal we are looking for.
 */
export function analyzeTickTrend(windows: readonly TickWindow[], options: TickTrendOptions = {}): TickTrend {
  const opts = { ...DEFAULT_TICK_TREND_OPTIONS, ...options };
  const populated = windows.filter((w) => w.count > 0);
  if (populated.length < opts.minWindows) {
    return {
      verdict: "insufficient-data",
      earlyP95Ms: 0,
      lateP95Ms: 0,
      ratio: 1,
      reason: `only ${populated.length} populated window(s); need ${opts.minWindows}`,
    };
  }

  const quarter = Math.max(1, Math.floor(populated.length / 4));
  const early = mean(populated.slice(0, quarter).map((w) => w.p95Ms));
  const late = mean(populated.slice(-quarter).map((w) => w.p95Ms));
  const allowance = early * opts.maxRatio + opts.slackMs;
  const ratio = early === 0 ? 1 : late / early;

  if (late <= allowance) {
    return {
      verdict: "pass",
      earlyP95Ms: early,
      lateP95Ms: late,
      ratio,
      reason: `p95 ${early.toFixed(3)} ms → ${late.toFixed(3)} ms, within ${allowance.toFixed(3)} ms`,
    };
  }
  return {
    verdict: "fail",
    earlyP95Ms: early,
    lateP95Ms: late,
    ratio,
    reason: `p95 degraded ${early.toFixed(3)} ms → ${late.toFixed(3)} ms (×${ratio.toFixed(2)}), past the ${allowance.toFixed(3)} ms allowance`,
  };
}

// ---------------------------------------------------------------------------
// Teardown audit
// ---------------------------------------------------------------------------

export interface TeardownSample {
  roomCount: number;
  rss: number;
  heapUsed: number;
}

export interface TeardownAudit {
  verdict: Verdict;
  roomsRemaining: number;
  heapGrowthBytes: number;
  rssGrowthBytes: number;
  /** One line per check, prefixed with its own pass/fail marker. */
  findings: string[];
}

export interface TeardownOptions {
  /**
   * Heap growth allowed over the pre-run baseline once every room has disposed.
   * `heapUsed` is the real leak signal: retained rooms, uncleared timers and
   * held-open bot drivers all show up here. 24 MB covers the content pack, the
   * prepared-statement cache and V8's own steady-state growth.
   */
  maxHeapGrowthBytes?: number;
  /**
   * RSS growth allowed. Far looser than the heap tolerance **on purpose**: V8
   * and glibc's allocator return freed pages to the OS lazily or never, so a
   * process that has peaked at 400 MB legitimately reports a high RSS long after
   * the heap has drained. RSS is a smoke alarm here; `heapUsed` is the evidence.
   */
  maxRssGrowthBytes?: number;
}

export const DEFAULT_TEARDOWN_OPTIONS: Required<TeardownOptions> = {
  maxHeapGrowthBytes: 24 * 1024 * 1024,
  maxRssGrowthBytes: 192 * 1024 * 1024,
};

/**
 * Assert the process came back to rest: no rooms left, and memory near the
 * pre-run baseline. Run it *after* forcing a GC (`--expose-gc`) and giving
 * Colyseus a moment to finish disposing, or the heap check reports garbage that
 * simply has not been collected yet.
 */
export function auditTeardown(
  baseline: TeardownSample,
  final: TeardownSample,
  options: TeardownOptions = {},
): TeardownAudit {
  const opts = { ...DEFAULT_TEARDOWN_OPTIONS, ...options };
  const heapGrowthBytes = final.heapUsed - baseline.heapUsed;
  const rssGrowthBytes = final.rss - baseline.rss;
  const findings: string[] = [];

  const roomsOk = final.roomCount === 0;
  findings.push(`${mark(roomsOk)} rooms after teardown: ${final.roomCount} (want 0)`);

  const heapOk = heapGrowthBytes <= opts.maxHeapGrowthBytes;
  findings.push(`${mark(heapOk)} heapUsed ${mb(baseline.heapUsed)} → ${mb(final.heapUsed)} (${signed(heapGrowthBytes)}, budget ${mb(opts.maxHeapGrowthBytes)})`);

  const rssOk = rssGrowthBytes <= opts.maxRssGrowthBytes;
  findings.push(`${mark(rssOk)} rss ${mb(baseline.rss)} → ${mb(final.rss)} (${signed(rssGrowthBytes)}, budget ${mb(opts.maxRssGrowthBytes)})`);

  return {
    verdict: roomsOk && heapOk && rssOk ? "pass" : "fail",
    roomsRemaining: final.roomCount,
    heapGrowthBytes,
    rssGrowthBytes,
    findings,
  };
}

// ---------------------------------------------------------------------------
// Formatting helpers (shared by the analyses and the report)
// ---------------------------------------------------------------------------

/** Bytes as a signed MB string, e.g. `12.4 MB` / `-3.1 MB`. */
export function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function signed(bytes: number): string {
  return `${bytes >= 0 ? "+" : ""}${mb(bytes)}`;
}

function mark(ok: boolean): string {
  return ok ? "PASS" : "FAIL";
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

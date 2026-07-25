/**
 * Periodic `server_metrics` rollup (ROADMAP §11 6.8).
 *
 * Every {@link DEFAULT_SAMPLE_INTERVAL_MS} the sampler diffs the metrics
 * registry against its previous reading and writes one row describing that
 * window: how many rooms and clients were live, how the simulation step behaved
 * (avg / p95 / max over just those ten seconds), and the process's memory. The
 * diff is what makes the row a *window* rather than a lifetime average — a
 * cumulative avg would flatten out within minutes and stop reporting anything.
 *
 * An idle server writes nothing. The roadmap asks for samples "during matches",
 * and a row per ten seconds of an empty lobby would bury the interesting ones.
 */
import { randomUUID } from "node:crypto";
import { createLogger } from "@space-arena/shared";
import { serverMetricsRepo } from "../db/repos.js";
import {
  diffHistogram,
  emptyHistogram,
  getMetrics,
  histogramAvg,
  histogramQuantile,
  type HistogramSnapshot,
  type MetricsRegistry,
} from "./metrics.js";

const log = createLogger("Telemetry");

/** Rollup cadence. Matches the load test's own 10 s memory sampling (6.6). */
export const DEFAULT_SAMPLE_INTERVAL_MS = 10_000;

/** The row this sampler produces, before it is given an id and a timestamp. */
export interface ServerMetricSample {
  room_count: number;
  client_count: number;
  tick_avg_ms: number;
  tick_p95_ms: number;
  tick_max_ms: number;
  tick_samples: number;
  rss_bytes: number;
  heap_used_bytes: number;
}

export interface TelemetrySamplerOptions {
  intervalMs?: number;
  metrics?: MetricsRegistry;
  /** Row sink. Defaults to the SQLite repo; tests pass a collector. */
  write?: (sample: ServerMetricSample) => void;
}

export class TelemetrySampler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private previousTick: HistogramSnapshot = emptyHistogram();
  private readonly intervalMs: number;
  private readonly metrics: MetricsRegistry;
  private readonly write: (sample: ServerMetricSample) => void;

  constructor(options: TelemetrySamplerOptions = {}) {
    this.intervalMs = options.intervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;
    this.metrics = options.metrics ?? getMetrics();
    this.write = options.write ?? defaultWrite;
  }

  /**
   * Arm the interval. `unref()` so a sampler can never be the reason the process
   * refuses to exit — the same reasoning that makes this safe to leave running
   * for a one-hour soak.
   */
  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.sampleOnce(), this.intervalMs);
    this.timer.unref?.();
    log.info("server metrics sampler started", { intervalMs: this.intervalMs });
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Take one sample. Returns the row written, or `null` when the window was
   * idle (no rooms and no ticks since the last sample).
   *
   * Never throws: telemetry is the least important thing this process does, and
   * a failed insert must not take a live match with it.
   */
  sampleOnce(): ServerMetricSample | null {
    try {
      const snapshot = this.metrics.snapshot();
      const window = diffHistogram(snapshot.tick, this.previousTick);
      this.previousTick = snapshot.tick;

      if (snapshot.roomCount === 0 && window.count === 0) return null;

      const sample: ServerMetricSample = {
        room_count: snapshot.roomCount,
        client_count: snapshot.clientCount,
        tick_avg_ms: round3(histogramAvg(window)),
        tick_p95_ms: round3(histogramQuantile(window, 0.95)),
        // Window maximum: the top occupied bucket's upper edge, since a maximum
        // cannot be subtracted out of a cumulative histogram.
        tick_max_ms: round3(histogramQuantile(window, 1)),
        tick_samples: window.count,
        rss_bytes: snapshot.memory.rss,
        heap_used_bytes: snapshot.memory.heapUsed,
      };
      this.write(sample);
      return sample;
    } catch (err) {
      log.error("server metrics sample failed", err);
      return null;
    }
  }
}

function defaultWrite(sample: ServerMetricSample): void {
  serverMetricsRepo.create({ id: randomUUID(), ...sample });
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

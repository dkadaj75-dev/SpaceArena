import { describe, expect, it, vi } from "vitest";
import { setGlobalLogLevel } from "@space-arena/shared";
import { MetricsRegistry } from "./metrics.js";
import { TelemetrySampler, type ServerMetricSample } from "./sampler.js";

setGlobalLogLevel("error");

function harness(): { registry: MetricsRegistry; rows: ServerMetricSample[]; sampler: TelemetrySampler } {
  const registry = new MetricsRegistry();
  const rows: ServerMetricSample[] = [];
  const sampler = new TelemetrySampler({ metrics: registry, write: (row) => void rows.push(row) });
  return { registry, rows, sampler };
}

describe("TelemetrySampler", () => {
  it("writes nothing while the server is idle", () => {
    const { rows, sampler } = harness();
    expect(sampler.sampleOnce()).toBeNull();
    expect(rows).toHaveLength(0);
  });

  it("writes a row once a room exists, even before it ticks", () => {
    const { registry, rows, sampler } = harness();
    registry.registerRoom("r1", "gamemode.duel-1v1");
    const row = sampler.sampleOnce();
    expect(row).not.toBeNull();
    expect(rows).toHaveLength(1);
    expect(row!.room_count).toBe(1);
    expect(row!.tick_samples).toBe(0);
  });

  it("each row covers only the window since the previous sample", () => {
    const { registry, sampler } = harness();
    registry.registerRoom("r1", "m");
    for (let i = 0; i < 30; i++) registry.recordTick("r1", 0.2);
    const first = sampler.sampleOnce()!;
    expect(first.tick_samples).toBe(30);
    expect(first.tick_avg_ms).toBeCloseTo(0.2, 2);

    for (let i = 0; i < 10; i++) registry.recordTick("r1", 2);
    const second = sampler.sampleOnce()!;
    // A cumulative average would report ~0.65 here; a window reports 2.
    expect(second.tick_samples).toBe(10);
    expect(second.tick_avg_ms).toBeGreaterThan(1.5);
  });

  it("keeps reporting after the ticking room disposes", () => {
    const { registry, sampler } = harness();
    registry.registerRoom("r1", "m");
    for (let i = 0; i < 20; i++) registry.recordTick("r1", 0.3);
    registry.unregisterRoom("r1");
    const row = sampler.sampleOnce()!;
    expect(row.room_count).toBe(0);
    expect(row.tick_samples).toBe(20);
  });

  it("reports memory on every row", () => {
    const { registry, sampler } = harness();
    registry.registerRoom("r1", "m");
    const row = sampler.sampleOnce()!;
    expect(row.rss_bytes).toBeGreaterThan(0);
    expect(row.heap_used_bytes).toBeGreaterThan(0);
  });

  it("never throws out of sampleOnce when the sink fails", () => {
    const registry = new MetricsRegistry();
    registry.registerRoom("r1", "m");
    const sampler = new TelemetrySampler({
      metrics: registry,
      write: () => {
        throw new Error("disk on fire");
      },
    });
    expect(() => sampler.sampleOnce()).not.toThrow();
    expect(sampler.sampleOnce()).toBeNull();
  });

  it("start() arms an unref'd interval and stop() is idempotent", () => {
    vi.useFakeTimers();
    try {
      const { registry, rows, sampler } = harness();
      registry.registerRoom("r1", "m");
      sampler.start();
      sampler.start(); // second call must not double-arm
      vi.advanceTimersByTime(30_000);
      expect(rows).toHaveLength(3);
      sampler.stop();
      sampler.stop();
      vi.advanceTimersByTime(30_000);
      expect(rows).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

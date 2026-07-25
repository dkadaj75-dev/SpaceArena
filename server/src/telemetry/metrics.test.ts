import { describe, expect, it } from "vitest";
import type { Client } from "@colyseus/core";
import {
  diffHistogram,
  DurationHistogram,
  emptyHistogram,
  histogramAvg,
  histogramQuantile,
  instrumentClientEgress,
  mergeHistograms,
  MetricsRegistry,
  TICK_BUCKET_EDGES_MS,
} from "./metrics.js";

describe("DurationHistogram", () => {
  it("counts, sums and tracks the maximum", () => {
    const h = new DurationHistogram();
    for (const ms of [0.1, 0.2, 0.3, 5]) h.observe(ms);
    const snap = h.snapshot();
    expect(snap.count).toBe(4);
    expect(snap.sumMs).toBeCloseTo(5.6, 10);
    expect(snap.maxMs).toBe(5);
    expect(histogramAvg(snap)).toBeCloseTo(1.4, 10);
  });

  it("ignores non-finite and negative observations", () => {
    const h = new DurationHistogram();
    h.observe(Number.NaN);
    h.observe(Number.POSITIVE_INFINITY);
    h.observe(-1);
    expect(h.snapshot().count).toBe(0);
  });

  it("puts anything past the last edge in the overflow bucket", () => {
    const h = new DurationHistogram();
    h.observe(5000);
    const snap = h.snapshot();
    expect(snap.buckets[TICK_BUCKET_EDGES_MS.length]).toBe(1);
    expect(snap.maxMs).toBe(5000);
  });

  it("snapshots are copies, not live views", () => {
    const h = new DurationHistogram();
    h.observe(1);
    const first = h.snapshot();
    h.observe(1);
    expect(first.count).toBe(1);
    expect(h.snapshot().count).toBe(2);
  });
});

describe("histogramQuantile", () => {
  it("returns 0 for an empty histogram", () => {
    expect(histogramQuantile(emptyHistogram(), 0.95)).toBe(0);
  });

  it("brackets the true quantile of a uniform spread", () => {
    const h = new DurationHistogram();
    // 100 samples evenly spread across 0.01..1.00 ms.
    for (let i = 1; i <= 100; i++) h.observe(i / 100);
    const snap = h.snapshot();
    const p95 = histogramQuantile(snap, 0.95);
    // Bucket resolution near 1 ms is 0.75..1.0, so allow that much slack.
    expect(p95).toBeGreaterThanOrEqual(0.75);
    expect(p95).toBeLessThanOrEqual(1.0);
    expect(histogramQuantile(snap, 0.5)).toBeGreaterThan(0.3);
    expect(histogramQuantile(snap, 0.5)).toBeLessThan(0.75);
  });

  it("finds an outlier at q=1 without letting it move p50", () => {
    const h = new DurationHistogram();
    for (let i = 0; i < 999; i++) h.observe(0.1);
    h.observe(40);
    const snap = h.snapshot();
    expect(histogramQuantile(snap, 0.5)).toBeLessThanOrEqual(0.1);
    expect(histogramQuantile(snap, 1)).toBeGreaterThanOrEqual(33);
    expect(snap.maxMs).toBe(40);
  });
});

describe("mergeHistograms / diffHistogram", () => {
  it("merge adds counts and takes the larger maximum", () => {
    const a = new DurationHistogram();
    a.observe(0.1);
    const b = new DurationHistogram();
    b.observe(2);
    const merged = mergeHistograms(a.snapshot(), b.snapshot());
    expect(merged.count).toBe(2);
    expect(merged.maxMs).toBe(2);
    expect(merged.sumMs).toBeCloseTo(2.1, 10);
  });

  it("diff recovers exactly the observations made between two snapshots", () => {
    const h = new DurationHistogram();
    for (let i = 0; i < 10; i++) h.observe(0.1);
    const before = h.snapshot();
    for (let i = 0; i < 4; i++) h.observe(0.5);
    const window = diffHistogram(h.snapshot(), before);
    expect(window.count).toBe(4);
    expect(window.sumMs).toBeCloseTo(2, 10);
    expect(histogramAvg(window)).toBeCloseTo(0.5, 10);
  });

  it("clamps a diff that would go negative (a counter that reset)", () => {
    const later = new DurationHistogram();
    later.observe(0.1);
    const earlier = new DurationHistogram();
    for (let i = 0; i < 5; i++) earlier.observe(0.1);
    const window = diffHistogram(later.snapshot(), earlier.snapshot());
    expect(window.count).toBe(0);
    expect(window.buckets.every((b) => b >= 0)).toBe(true);
  });
});

describe("MetricsRegistry", () => {
  it("tracks rooms, clients and lifecycle counters", () => {
    const registry = new MetricsRegistry();
    registry.registerRoom("r1", "gamemode.duel-1v1");
    registry.registerRoom("r2", "gamemode.duel-1v1");
    registry.setClientCount("r1", 2);
    registry.setClientCount("r2", 1);

    let snap = registry.snapshot();
    expect(snap.roomCount).toBe(2);
    expect(snap.clientCount).toBe(3);
    expect(snap.lifetime).toEqual({ roomsCreated: 2, roomsDisposed: 0 });

    registry.unregisterRoom("r1");
    snap = registry.snapshot();
    expect(snap.roomCount).toBe(1);
    expect(snap.lifetime).toEqual({ roomsCreated: 2, roomsDisposed: 1 });
  });

  it("registering the same room twice does not double-count it", () => {
    const registry = new MetricsRegistry();
    registry.registerRoom("r1", "m");
    registry.registerRoom("r1", "m");
    expect(registry.snapshot().lifetime.roomsCreated).toBe(1);
    registry.unregisterRoom("r1");
    registry.unregisterRoom("r1");
    expect(registry.snapshot().lifetime.roomsDisposed).toBe(1);
  });

  it("keeps process totals after a room disposes — the whole point of the lifetime counters", () => {
    const registry = new MetricsRegistry();
    registry.registerRoom("r1", "m");
    registry.recordTick("r1", 0.5);
    registry.recordPatch("r1", 100);
    registry.recordBytesOut("r1", 100);
    const before = registry.snapshot();
    expect(before.tick.count).toBe(1);

    registry.unregisterRoom("r1");
    const after = registry.snapshot();
    expect(after.roomCount).toBe(0);
    expect(after.rooms).toHaveLength(0);
    // Without this, a window diff across a room's death reads as "no ticks".
    expect(after.tick.count).toBe(1);
    expect(after.patchBytes).toBe(100);
    expect(diffHistogram(after.tick, before.tick).count).toBe(0);
  });

  it("ignores records for rooms it does not know, without losing the lifetime total", () => {
    const registry = new MetricsRegistry();
    registry.recordTick("ghost", 1);
    registry.recordPatch("ghost", 50);
    const snap = registry.snapshot();
    expect(snap.roomCount).toBe(0);
    expect(snap.tick.count).toBe(1);
    expect(snap.patchBytes).toBe(50);
  });

  it("reports per-room counters separately", () => {
    const registry = new MetricsRegistry();
    registry.registerRoom("r1", "m");
    registry.registerRoom("r2", "m");
    registry.recordTick("r1", 1);
    registry.recordTick("r1", 1);
    registry.recordTick("r2", 3);
    const snap = registry.snapshot();
    const r1 = snap.rooms.find((r) => r.roomId === "r1")!;
    const r2 = snap.rooms.find((r) => r.roomId === "r2")!;
    expect(r1.tick.count).toBe(2);
    expect(r2.tick.count).toBe(1);
    expect(snap.tick.count).toBe(3);
    expect(snap.tick.maxMs).toBe(3);
  });
});

describe("instrumentClientEgress", () => {
  /** Minimal stand-in for a Colyseus client: just the `raw` funnel. */
  function fakeClient(): { client: Client; sent: number[] } {
    const sent: number[] = [];
    const client = { raw: (data: Uint8Array) => void sent.push(data.length) } as unknown as Client;
    return { client, sent };
  }

  it("counts patch writes separately from message writes and still forwards them", () => {
    const registry = new MetricsRegistry();
    registry.registerRoom("r1", "m");
    const owner = { inPatchPhase: false };
    const { client, sent } = fakeClient();
    instrumentClientEgress(client, "r1", owner as { readonly inPatchPhase: boolean }, registry);

    client.raw(new Uint8Array(10)); // a message
    owner.inPatchPhase = true;
    client.raw(new Uint8Array(30)); // a patch
    client.raw(new Uint8Array(20)); // a patch to a second client
    owner.inPatchPhase = false;
    client.raw(new Uint8Array(5)); // another message

    const snap = registry.snapshot();
    expect(snap.patchBytes).toBe(50);
    expect(snap.patches).toBe(2);
    expect(snap.bytesOut).toBe(65);
    // The original transport still received every byte, in order.
    expect(sent).toEqual([10, 30, 20, 5]);
  });

  it("survives a zero-length or absent payload", () => {
    const registry = new MetricsRegistry();
    registry.registerRoom("r1", "m");
    const { client } = fakeClient();
    instrumentClientEgress(client, "r1", { inPatchPhase: false }, registry);
    client.raw(new Uint8Array(0));
    expect(registry.snapshot().bytesOut).toBe(0);
  });
});

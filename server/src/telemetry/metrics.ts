/**
 * Process-wide server metrics registry (ROADMAP §11 6.6 + 6.8).
 *
 * Two consumers, one source of truth:
 *   - the **telemetry sampler** (6.8) rolls it up into `server_metrics` rows,
 *   - the **load-test harness** (6.6) polls it over `GET /metrics`.
 *
 * ## Why the counters are cumulative
 *
 * Both consumers want *windows* ("p95 over the last 10 s"), but a registry that
 * resets on read can only ever serve one of them — whoever polls first steals
 * the other's window. So nothing here resets: every counter is monotonic for the
 * lifetime of the process and callers derive windows by diffing two snapshots
 * ({@link diffHistogram}). Histograms diff exactly, because bucket counts are
 * additive.
 *
 * ## Why this is always on rather than DEV-gated
 *
 * The roadmap's 6.8 telemetry explicitly wants "avg tick time" from production,
 * so a DEV-only counter would have to be built twice. The cost is two
 * `performance.now()` calls per simulation step (30 Hz per room — well under a
 * microsecond of the 33 ms budget) plus one forwarding closure per outbound
 * frame. The byte counter wraps `Client.raw`, which is the only place Colyseus
 * exposes an encoded payload; the wrapper is typed as
 * `Parameters<Client["raw"]>` so a library signature change fails `typecheck`
 * instead of silently mis-measuring in production.
 */
import type { Client } from "@colyseus/core";

// ---------------------------------------------------------------------------
// Duration histogram
// ---------------------------------------------------------------------------

/**
 * Upper edges (ms) of the tick-duration buckets, ascending. Dense below 4 ms
 * because that is where a healthy 30 Hz step lives (measured: ~0.1-0.5 ms for a
 * 2-ship duel), and coarse above 33 ms because anything past one full frame is
 * already a failure — the exact value matters less than the fact it happened.
 */
export const TICK_BUCKET_EDGES_MS: readonly number[] = [
  0.05, 0.1, 0.2, 0.3, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 33, 50, 100, 250, 1000,
];

/** Plain-data view of a histogram: JSON-safe, diffable, mergeable. */
export interface HistogramSnapshot {
  /** Total observations. */
  count: number;
  /** Sum of all observed values (ms). */
  sumMs: number;
  /** Largest single observation (ms). Exact, but *not* diffable — see {@link diffHistogram}. */
  maxMs: number;
  /** Per-bucket counts; length is `TICK_BUCKET_EDGES_MS.length + 1` (last = overflow). */
  buckets: number[];
}

/** Fixed-bucket duration histogram: O(1) memory per room, O(1) `observe`. */
export class DurationHistogram {
  private readonly bucketCounts: number[];
  private total = 0;
  private sum = 0;
  private peak = 0;

  constructor(private readonly edges: readonly number[] = TICK_BUCKET_EDGES_MS) {
    this.bucketCounts = new Array<number>(edges.length + 1).fill(0);
  }

  observe(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.total++;
    this.sum += ms;
    if (ms > this.peak) this.peak = ms;
    // Linear scan: 22 buckets, and the healthy case exits within the first few.
    for (let i = 0; i < this.edges.length; i++) {
      if (ms <= this.edges[i]!) {
        this.bucketCounts[i]!++;
        return;
      }
    }
    this.bucketCounts[this.edges.length]!++;
  }

  snapshot(): HistogramSnapshot {
    return { count: this.total, sumMs: this.sum, maxMs: this.peak, buckets: [...this.bucketCounts] };
  }
}

/** An all-zero snapshot, for merge/diff identities and for rooms that never ticked. */
export function emptyHistogram(edges: readonly number[] = TICK_BUCKET_EDGES_MS): HistogramSnapshot {
  return { count: 0, sumMs: 0, maxMs: 0, buckets: new Array<number>(edges.length + 1).fill(0) };
}

/** Sum two snapshots (used to roll every room up into a process-wide view). */
export function mergeHistograms(a: HistogramSnapshot, b: HistogramSnapshot): HistogramSnapshot {
  const buckets = a.buckets.map((v, i) => v + (b.buckets[i] ?? 0));
  return { count: a.count + b.count, sumMs: a.sumMs + b.sumMs, maxMs: Math.max(a.maxMs, b.maxMs), buckets };
}

/**
 * `now - prev`, giving the histogram of everything observed between the two
 * snapshots.
 *
 * `maxMs` is the one field that cannot be subtracted (a maximum is not
 * additive), so the diff reports the *later* snapshot's lifetime max. Use
 * {@link histogramQuantile}`(diff, 1)` when you need a window maximum — it
 * returns the upper edge of the highest occupied bucket, an honest upper bound.
 */
export function diffHistogram(now: HistogramSnapshot, prev: HistogramSnapshot): HistogramSnapshot {
  return {
    count: Math.max(0, now.count - prev.count),
    sumMs: Math.max(0, now.sumMs - prev.sumMs),
    maxMs: now.maxMs,
    buckets: now.buckets.map((v, i) => Math.max(0, v - (prev.buckets[i] ?? 0))),
  };
}

/** Mean observation (ms), or 0 for an empty histogram. */
export function histogramAvg(h: HistogramSnapshot): number {
  return h.count === 0 ? 0 : h.sumMs / h.count;
}

/**
 * Quantile (0..1) estimated from the bucket counts, linearly interpolated inside
 * the bucket that contains the target rank. Accuracy is bounded by the bucket
 * width there — sub-0.05 ms near the floor, which is far finer than the decision
 * this feeds ("is p95 approaching the 33 ms step budget?").
 *
 * Returns the bucket's upper edge for the overflow bucket (open-ended above the
 * last edge, so `maxMs` is the only exact answer up there).
 */
export function histogramQuantile(h: HistogramSnapshot, q: number, edges: readonly number[] = TICK_BUCKET_EDGES_MS): number {
  if (h.count === 0) return 0;
  const target = Math.min(h.count, Math.max(1, Math.ceil(q * h.count)));
  let cumulative = 0;
  for (let i = 0; i < h.buckets.length; i++) {
    const inBucket = h.buckets[i] ?? 0;
    if (inBucket === 0) continue;
    if (cumulative + inBucket >= target) {
      const lower = i === 0 ? 0 : edges[i - 1]!;
      const upper = edges[i] ?? (h.maxMs || lower);
      // Position of the target observation within this bucket, in (0, 1].
      const within = (target - cumulative) / inBucket;
      return lower + (upper - lower) * within;
    }
    cumulative += inBucket;
  }
  return h.maxMs;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** Per-room counters as exposed by {@link MetricsRegistry.snapshot}. */
export interface RoomMetrics {
  roomId: string;
  gamemode: string;
  /** Wall-clock ms since the room registered. */
  ageMs: number;
  clients: number;
  /** Cumulative simulation-step durations. */
  tick: HistogramSnapshot;
  /** Cumulative bytes written to clients inside `broadcastPatch()`. */
  patchBytes: number;
  /** Cumulative `broadcastPatch()` calls that actually encoded changes. */
  patches: number;
  /** Cumulative bytes written to clients by any path (patches + messages + full state). */
  bytesOut: number;
}

export interface MemorySnapshot {
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
}

export interface MetricsSnapshot {
  /** `Date.now()` when the snapshot was taken. */
  now: number;
  uptimeMs: number;
  roomCount: number;
  clientCount: number;
  rooms: RoomMetrics[];
  /**
   * Process-**lifetime** tick histogram: every observation since boot, including
   * rooms that have since disposed.
   *
   * This deliberately is not the merge of `rooms[].tick`. Rooms churn — a match
   * ends every half-minute under load — and a total that only covers *live*
   * rooms shrinks whenever one disposes, so consecutive snapshots would diff to
   * zero and a window would report "no ticks happened" during the busiest part
   * of a run. Only a lifetime accumulator is diffable.
   */
  tick: HistogramSnapshot;
  /** Process-lifetime patch bytes. Lifetime for the same reason as {@link tick}. */
  patchBytes: number;
  /** Process-lifetime patch writes. */
  patches: number;
  /** Process-lifetime bytes written to clients by any path. */
  bytesOut: number;
  memory: MemorySnapshot;
  /** Room lifecycle counters — the teardown audit's primary signal. */
  lifetime: { roomsCreated: number; roomsDisposed: number };
}

interface RoomEntry {
  gamemode: string;
  createdAt: number;
  clients: number;
  tick: DurationHistogram;
  patchBytes: number;
  patches: number;
  bytesOut: number;
}

/**
 * The registry. One instance per process (see {@link getMetrics}); rooms add and
 * remove themselves, so its memory is bounded by the number of *live* rooms plus
 * two lifetime counters.
 */
export class MetricsRegistry {
  private readonly rooms = new Map<string, RoomEntry>();
  private roomsCreated = 0;
  private roomsDisposed = 0;
  private readonly startedAt = Date.now();

  // Process-lifetime accumulators. Written alongside the per-room ones so a
  // disposed room's contribution survives it — see MetricsSnapshot.tick.
  private readonly lifetimeTick = new DurationHistogram();
  private lifetimePatchBytes = 0;
  private lifetimePatches = 0;
  private lifetimeBytesOut = 0;

  registerRoom(roomId: string, gamemode: string): void {
    if (this.rooms.has(roomId)) return;
    this.rooms.set(roomId, {
      gamemode,
      createdAt: Date.now(),
      clients: 0,
      tick: new DurationHistogram(),
      patchBytes: 0,
      patches: 0,
      bytesOut: 0,
    });
    this.roomsCreated++;
  }

  /**
   * Drop a room's counters. Called from `ArenaRoom.onDispose`, which Colyseus
   * guarantees for every room it created — that guarantee is what keeps this map
   * from being a leak of its own.
   */
  unregisterRoom(roomId: string): void {
    if (!this.rooms.delete(roomId)) return;
    this.roomsDisposed++;
  }

  recordTick(roomId: string, ms: number): void {
    this.lifetimeTick.observe(ms);
    this.rooms.get(roomId)?.tick.observe(ms);
  }

  /** Bytes written while `broadcastPatch()` was on the stack. */
  recordPatch(roomId: string, bytes: number): void {
    this.lifetimePatchBytes += bytes;
    this.lifetimePatches++;
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.patchBytes += bytes;
    room.patches++;
  }

  /** Bytes written to a client by any path. Superset of {@link recordPatch}. */
  recordBytesOut(roomId: string, bytes: number): void {
    this.lifetimeBytesOut += bytes;
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.bytesOut += bytes;
  }

  setClientCount(roomId: string, clients: number): void {
    const room = this.rooms.get(roomId);
    if (room) room.clients = clients;
  }

  get roomCount(): number {
    return this.rooms.size;
  }

  snapshot(): MetricsSnapshot {
    const now = Date.now();
    const rooms: RoomMetrics[] = [];
    let clientCount = 0;

    for (const [roomId, entry] of this.rooms) {
      rooms.push({
        roomId,
        gamemode: entry.gamemode,
        ageMs: now - entry.createdAt,
        clients: entry.clients,
        tick: entry.tick.snapshot(),
        patchBytes: entry.patchBytes,
        patches: entry.patches,
        bytesOut: entry.bytesOut,
      });
      clientCount += entry.clients;
    }

    const mem = process.memoryUsage();
    return {
      now,
      uptimeMs: now - this.startedAt,
      roomCount: this.rooms.size,
      clientCount,
      rooms,
      tick: this.lifetimeTick.snapshot(),
      patchBytes: this.lifetimePatchBytes,
      patches: this.lifetimePatches,
      bytesOut: this.lifetimeBytesOut,
      memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal, external: mem.external },
      lifetime: { roomsCreated: this.roomsCreated, roomsDisposed: this.roomsDisposed },
    };
  }
}

let registry: MetricsRegistry | null = null;

/** The process-wide registry, created on first use. */
export function getMetrics(): MetricsRegistry {
  registry ??= new MetricsRegistry();
  return registry;
}

/** Drop the registry. Tests only — production creates exactly one. */
export function resetMetrics(): void {
  registry = null;
}

// ---------------------------------------------------------------------------
// Client egress instrumentation
// ---------------------------------------------------------------------------

/**
 * A room that can tell the byte counter whether the current `raw()` write is
 * part of a state patch or an ordinary message.
 */
export interface PatchPhaseOwner {
  /** True only while `broadcastPatch()` is on the stack. */
  readonly inPatchPhase: boolean;
}

/**
 * Wrap one client's `raw()` so every outbound frame is counted against `roomId`.
 *
 * `raw()` is the single funnel Colyseus pushes encoded bytes through — the state
 * patch (from `SchemaSerializer.applyPatches`), the initial full state, and every
 * `send`/`broadcast` all end up here — which makes it the only place a *byte*
 * count is available at all. Colyseus 0.16 has no public patch-size hook:
 * `Room.broadcastPatch()` returns a bare `hasChanges` boolean, and the encoded
 * length is visible only to the `colyseus:patch` debug logger.
 *
 * The `inPatchPhase` flag on the owning room separates patch bytes from message
 * bytes without a second wrapper: `applyPatches` is fully synchronous, so every
 * `raw()` observed while the flag is set belongs to that patch.
 */
export function instrumentClientEgress(client: Client, roomId: string, owner: PatchPhaseOwner, metrics = getMetrics()): void {
  const original = client.raw.bind(client) as (...args: Parameters<Client["raw"]>) => void;
  client.raw = (...args: Parameters<Client["raw"]>): void => {
    const bytes = args[0]?.length ?? 0;
    metrics.recordBytesOut(roomId, bytes);
    if (owner.inPatchPhase) metrics.recordPatch(roomId, bytes);
    original(...args);
  };
}

/** Pure snapshot timing/correction helpers (kept socket-free for tests). */
export function lerpHeading(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

/**
 * Phase of `renderTime` inside the segment `[a, b]`, clamped to 0..1.
 *
 * A ZERO-LENGTH segment answers 1 (the newer sample) rather than dividing. The
 * playback timeline is no longer the strictly-increasing local receive clock
 * (see {@link stampSnapshot}), so two samples CAN share an instant — a server
 * that missed a sim tick republishes the same `matchTimer` — and a naive divide
 * there produces NaN, which propagates straight into every mesh position.
 */
function phase(aTime: number, bTime: number, renderTime: number): number {
  const span = bTime - aTime;
  if (!(span > 0)) return 1;
  return Math.max(0, Math.min(1, (renderTime - aTime) / span));
}

export function bracket<T extends { time: number }>(items: readonly T[], renderTime: number): [T, T, number] | null {
  if (!items.length) return null;
  if (items.length === 1 || renderTime <= items[0]!.time) return [items[0]!, items[0]!, 0];
  for (let i = 1; i < items.length; i++) {
    const b = items[i]!;
    const a = items[i - 1]!;
    if (renderTime <= b.time) return [a, b, phase(a.time, b.time, renderTime)];
  }
  // DRY BRACKET: the render point has overrun the newest sample. Hold on that
  // sample (t = 1) — never extrapolate, and above all never REWIND.
  //
  // This branch used to answer `(renderTime − last.time) / interval` clamped to
  // 0..1, which is the phase measured from the WRONG end of the pair it returns.
  // One frame before the overrun the loop above answers ≈1 and the ship is drawn
  // at `last`; one frame after, this line answers ≈0 and the ship is drawn at
  // `prev` — a teleport BACKWARD by a whole segment (33–67 ms of travel, ~4 units
  // at cruise), followed by a real-time replay of the segment it had already
  // flown. Every momentary starve therefore cost a visible rewind-and-repeat
  // rather than the freeze the buffer is supposed to degrade to. Clamping is the
  // honest failure: the newest thing we know is where the ship was, so draw it
  // there until something newer lands.
  const last = items[items.length - 1]!;
  const prev = items[items.length - 2]!;
  return [prev, last, 1];
}

export function decayCorrection(offset: number, dtSeconds: number, rate: number, snapDistance = 3): number {
  return Math.abs(offset) > snapDistance ? 0 : offset * Math.exp(-rate * dtSeconds);
}

/** Mutable 3-vector, shape-compatible with snapshot `pos` objects. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** One position sample on the snapshot timeline (`time` in ms, `bracket`'s clock). */
export interface TimedPos {
  readonly time: number;
  readonly pos: { readonly x: number; readonly y: number; readonly z: number };
}

/**
 * C1 position interpolation across a snapshot segment — cubic Hermite with
 * finite-difference (Catmull-Rom style) tangents from the neighbouring samples.
 *
 * Plain lerp between ~20 Hz snapshots is C0: position is continuous but
 * VELOCITY steps at every sample boundary, and at 60 fps that reads as a faint
 * 20 Hz shudder on remote hulls — worst in turns, where the velocity direction
 * changes at every knot, and still there under a perfect playback timeline.
 * A cubic through the same samples whose end tangents are shared with the
 * neighbouring segments removes exactly that: both segments meeting at a knot
 * evaluate the SAME finite-difference tangent there, so the interpolated
 * velocity is continuous through it (C1), not just the position.
 *
 * Tangent choice: `m_k = (p_{k+1} − p_{k−1}) / (t_{k+1} − t_{k−1})` — the
 * non-uniform Catmull-Rom finite difference. It is the gap-weighted average of
 * the two adjacent chord velocities, so its magnitude can never exceed the
 * faster neighbouring chord: a well-behaved bound to build the overshoot
 * guards on. A missing neighbour (fewer than 3 samples around the segment, or
 * a ship that only just spawned) falls back to the segment's own chord slope,
 * which degrades that end to the old lerp exactly — never worse than before.
 *
 * Overshoot guards, because Catmull-Rom is not shape-preserving and a ship
 * that BOUNCES off a rock between two samples must not be drawn inside it:
 *  - a tangent pointing AGAINST the segment's chord (`m · d < 0`) means the
 *    neighbourhood reverses direction here — the cubic would loop outside the
 *    travelled span, so the segment degrades to plain lerp. This deliberately
 *    spends C1 at the knot: around a physical impact the velocity really is
 *    discontinuous, and smoothing through it would be lying about the bounce.
 *  - a tangent LONGER than the chord (a respawn teleport in the neighbour
 *    sample, or a hard brake) is clamped to the chord length, which caps the
 *    curve's deviation from the chord at (4/27)·(|M1|+|M2|) ≤ ~0.3·|chord|.
 *
 * Pure and allocation-free (writes into `out`): the render loop calls this per
 * remote ship per tick, and pure is what keeps the C1/overshoot claims provable
 * in unit tests rather than asserted in a comment.
 */
export function hermitePosition(
  prev: TimedPos | null,
  from: TimedPos,
  to: TimedPos,
  next: TimedPos | null,
  t: number,
  out: Vec3,
): Vec3 {
  const h = to.time - from.time;
  if (!(h > 0)) {
    // Coincident samples (single-snapshot bracket): nothing to interpolate.
    out.x = to.pos.x;
    out.y = to.pos.y;
    out.z = to.pos.z;
    return out;
  }
  const dx = to.pos.x - from.pos.x;
  const dy = to.pos.y - from.pos.y;
  const dz = to.pos.z - from.pos.z;
  // Tangents scaled onto the segment (M = m·h), defaulting to the chord itself,
  // which makes a neighbourless end EXACTLY linear rather than approximately so.
  let m1x = dx, m1y = dy, m1z = dz;
  let m2x = dx, m2y = dy, m2z = dz;
  if (prev && from.time - prev.time > 0) {
    const k = h / (to.time - prev.time);
    m1x = (to.pos.x - prev.pos.x) * k;
    m1y = (to.pos.y - prev.pos.y) * k;
    m1z = (to.pos.z - prev.pos.z) * k;
  }
  if (next && next.time - to.time > 0) {
    const k = h / (next.time - from.time);
    m2x = (next.pos.x - from.pos.x) * k;
    m2y = (next.pos.y - from.pos.y) * k;
    m2z = (next.pos.z - from.pos.z) * k;
  }
  if (m1x * dx + m1y * dy + m1z * dz < 0 || m2x * dx + m2y * dy + m2z * dz < 0) {
    // Direction reversal at a knot (bounce): see the doc comment.
    out.x = from.pos.x + dx * t;
    out.y = from.pos.y + dy * t;
    out.z = from.pos.z + dz * t;
    return out;
  }
  const chord = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const l1 = Math.sqrt(m1x * m1x + m1y * m1y + m1z * m1z);
  if (l1 > chord) {
    const k = chord / l1;
    m1x *= k;
    m1y *= k;
    m1z *= k;
  }
  const l2 = Math.sqrt(m2x * m2x + m2y * m2y + m2z * m2z);
  if (l2 > chord) {
    const k = chord / l2;
    m2x *= k;
    m2y *= k;
    m2z *= k;
  }
  const s2 = t * t;
  const s3 = s2 * t;
  const h00 = 2 * s3 - 3 * s2 + 1;
  const h10 = s3 - 2 * s2 + t;
  const h01 = 3 * s2 - 2 * s3;
  const h11 = s3 - s2;
  out.x = h00 * from.pos.x + h10 * m1x + h01 * to.pos.x + h11 * m2x;
  out.y = h00 * from.pos.y + h10 * m1y + h01 * to.pos.y + h11 * m2y;
  out.z = h00 * from.pos.z + h10 * m1z + h01 * to.pos.z + h11 * m2z;
  return out;
}

/**
 * Convert a legacy per-frame pull authored at `referenceHz` into a dt-stable
 * exponential fraction. At 60 Hz, 0.15 remains exactly 0.15.
 */
export function timeBasedPull(referencePull: number, dtSeconds: number, referenceHz = 60): number {
  return 1 - Math.pow(1 - referencePull, dtSeconds * referenceHz);
}

/**
 * How far behind `now` remote entities are rendered, adapted to the patch
 * cadence the network is actually delivering.
 *
 * A FIXED delay is only correct on the network it was tuned for. Measured on
 * localhost — the best case there is — patches nominally 50 ms apart arrive at
 * a median of ~62 ms with bursts past 95 ms, so a fixed 100 ms delay left the
 * render time ahead of the newest snapshot on ~16% of frames. A dry bracket
 * clamps to the newest snapshot, so the remote ship FREEZES there and then
 * lurches when the next patch lands — precisely the "ships jump between server
 * updates" the interpolation buffer exists to hide. On phone Wi-Fi, whose
 * power-save batches receives into 100-300 ms bursts, it is the normal state.
 *
 * The target keeps `headroomPatches` of the p90 arrival gap between the render
 * point and the newest snapshot. BOTH directions are rate-limited, because the
 * delay is not a free variable: `renderTime = now - delay`, so any step in the
 * delay is a step in the playback clock the remote ships live on.
 *
 *  - WIDENING at `WIDEN_MS_PER_SECOND` (fast). The first cut of this widened
 *    INSTANTLY, reasoning that a too-tight delay meant the bracket was already
 *    starving — and the owner immediately reported the ride SLIGHTLY WORSE.
 *    The reasoning missed the common case: the p90 of a live gap ring drifts up
 *    a few ms whenever a fresh burst sample lands, long before any bracket runs
 *    dry, and every instant up-step yanked `renderTime` BACKWARD by that many
 *    milliseconds — remote ships visibly rewound, once per burst sample, a
 *    rhythmic hitch in place of the old freeze-and-lurch. Rate-limited at
 *    120 ms/s, a widening plays the timeline at ~0.88x for a few hundred
 *    milliseconds instead — a sub-perceptual slow-motion, never a step back.
 *  - NARROWING at `NARROW_MS_PER_SECOND` (slow): playback at ~1.015x until the
 *    burst's slack is repaid. Recovery is deliberately much slower than onset —
 *    over-delay merely adds latency, under-delay stutters.
 *
 * `floorMs` is the authored `netRenderDelayMs`, kept as the minimum so a calm
 * network behaves exactly as it always has; `ceilMs` caps what jitter can buy
 * because past ~350 ms of display latency a stale-but-smooth enemy is lying
 * about where it is.
 */
export const RENDER_DELAY_CEIL_MS = 350;
export const WIDEN_MS_PER_SECOND = 120;
const NARROW_MS_PER_SECOND = 15;
const HEADROOM_PATCHES = 2;

/**
 * `shortfallMs` closes the loop. The p90 target above is OPEN loop: it predicts
 * the delay the arrival cadence should need. `shortfallMs` is the delay the last
 * frame actually MISSED BY — how far `now − delay` overran the newest playback
 * timestamp — measured on the very quantity the buffer exists to protect. Any
 * frame that starved raises the target by exactly its own shortfall, so a
 * cadence the p90 estimate does not describe (a duplicated `matchTimer`, a
 * server tick lost to GC, a burst the ring has already forgotten) still widens
 * the delay instead of waiting for the estimator to notice. Zero on a healthy
 * frame, which leaves the tuned open-loop behaviour untouched.
 */
export function adaptiveRenderDelay(
  currentMs: number,
  arrivalGapsMs: readonly number[],
  floorMs: number,
  dtSeconds: number,
  ceilMs = RENDER_DELAY_CEIL_MS,
  shortfallMs = 0,
): number {
  let target = floorMs;
  if (arrivalGapsMs.length >= 4) {
    const sorted = [...arrivalGapsMs].sort((a, b) => a - b);
    const p90 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))]!;
    target = Math.max(floorMs, p90 * HEADROOM_PATCHES);
  }
  if (shortfallMs > 0) target = Math.max(target, currentMs + shortfallMs);
  target = Math.min(ceilMs, Math.max(floorMs, target));
  const dt = Math.max(0, dtSeconds);
  if (target > currentMs) return Math.min(target, currentMs + WIDEN_MS_PER_SECOND * dt);
  return Math.max(target, currentMs - NARROW_MS_PER_SECOND * dt);
}

/* ------------------------------------------------------------------------- *
 * Snapshot playback clock
 * ------------------------------------------------------------------------- */

/**
 * State of the map from SERVER time to the local playback timeline. Plain data
 * and mutated in place: it is touched once per patch (20 Hz), and keeping it
 * inspectable is what lets the drift control be tested rather than described.
 */
export interface SnapshotClockState {
  /** `playback = serverMs + offsetMs`. Slewed, never stepped. */
  offsetMs: number;
  /** Recent `arrival − serverMs` observations; the MINIMUM is the honest offset. */
  readonly instants: number[];
  lastServerMs: number;
  lastPlaybackMs: number;
  seeded: boolean;
}

export interface SnapshotStamp {
  /** Timestamp to file this snapshot under on the interpolation timeline. */
  timeMs: number;
  /** True when the mapping was (re)seeded — buffered samples are now stale. */
  reset: boolean;
}

/** How many `arrival − server` observations the offset estimate looks back over. */
const CLOCK_WINDOW = 32;
/**
 * Offset error that stops being drift and starts being a different clock: a
 * match going live (`matchTimer` leaves 0 after a lobby of any length), a
 * reconnect, a server restart. Chosen just above {@link RENDER_DELAY_CEIL_MS} —
 * an error the render delay could still absorb is one worth slewing out rather
 * than resetting for, and anything larger cannot be absorbed at all.
 */
export const SNAPSHOT_CLOCK_RESET_MS = 400;
/**
 * Ceiling on how much of a segment the drift correction may eat, as a fraction
 * of that segment. The correction is applied by moving one sample's timestamp,
 * which stretches or squeezes the segment ending there — i.e. it IS a playback
 * speed error, the exact artefact this clock exists to remove. At 3% of a 50 ms
 * segment that is 1.5 ms per patch, ~30 ms/s of authority: comfortably more than
 * the ~1-2% by which a fixed-`dt` server sim clock drifts against wall time, and
 * far below the ~10% speed error an eye starts to resolve on a moving hull.
 */
const CLOCK_SLEW_FRACTION = 0.03;
/** Minimum spacing forced between two playback timestamps (see {@link phase}). */
const MIN_SEGMENT_MS = 1;

export function createSnapshotClock(): SnapshotClockState {
  return { offsetMs: 0, instants: [], lastServerMs: 0, lastPlaybackMs: 0, seeded: false };
}

/**
 * Place one snapshot on the interpolation timeline, using the SERVER's own clock
 * for its spacing and the local clock only for its alignment.
 *
 * ## Why arrival time is the wrong timeline
 *
 * `ArenaRoom` steps the sim at 30 Hz (`SIM_TICK_RATE`) and broadcasts patches at
 * 20 Hz (`PATCH_RATE_MS = 50`). Those are two independent timers, so a patch
 * carries whichever sim tick was the most recent when it fired: consecutive
 * patches are ONE tick apart (33.3 ms of simulated travel) and then TWO
 * (66.7 ms), alternating, forever, on a perfect network.
 *
 * Stamping those samples with their local ARRIVAL time — uniform 50 ms — plays
 * 66.7 ms of travel back over 50 ms and then 33.3 ms of travel over 50 ms. Every
 * remote hull therefore renders at 1.33x its true speed, then 0.67x, ten times a
 * second, on LAN, on localhost, at any frame rate, with a perfectly full buffer.
 * A 2:1 sawtooth in velocity is exactly what "janky" describes, and no amount of
 * buffer depth, C1 curve fitting or render-delay adaptation can remove it,
 * because all three faithfully interpolate a timeline that is itself wrong.
 * (`renderPacing.test.ts` could not see it either: it modelled the server as
 * sampling the world every 50 ms, which is the assumption at fault.)
 *
 * `snapshot.elapsed` is `matchTimer`, already on the wire, already frozen into
 * the field contract — the sim's own accumulated time, advancing by exactly one
 * `FIXED_DT` per tick. Spacing samples by THAT restores true playback speed.
 *
 * ## Why the offset has to be controlled rather than measured once
 *
 * `offsetMs` aligns the two clocks; it cannot simply be latched at join. The
 * server advances `elapsed` by a fixed `1/30` per tick while its timer fires on
 * a real, slightly-off interval, so the sim clock runs 1-2% away from wall time
 * in whichever direction the host's timers land. Left alone, that ratio walks
 * the whole buffer out of the render window inside a minute — dry every frame if
 * the server clock runs slow, seconds of added latency if it runs fast.
 *
 * The estimate is the MINIMUM of `arrival − serverMs` over the recent window:
 * the least-delayed patch is the one that saw the least queueing, so it is the
 * closest thing to the true offset the client can observe, and a min over a
 * moving window follows drift for free while ignoring every late arrival (which
 * is the render delay's job, not this one's). Convergence onto that estimate is
 * rate-limited to {@link CLOCK_SLEW_FRACTION} of a segment, because a STEP in
 * the offset is a step in the playback clock — the same mistake the first cut of
 * {@link adaptiveRenderDelay} made, and one the owner could see.
 */
export function stampSnapshot(clock: SnapshotClockState, serverMs: number, arrivalMs: number): SnapshotStamp {
  const instant = arrivalMs - serverMs;
  if (!clock.seeded) return seedSnapshotClock(clock, serverMs, arrivalMs);
  if (!Number.isFinite(instant)) {
    // No usable server clock on this patch (a peer whose `matchTimer` decoded to
    // nothing). Fall back to arrival stamping for this one sample rather than
    // resetting: a reset would discard the buffer, and one unusable timestamp is
    // not evidence that the mapping is wrong.
    const fallback = Math.max(arrivalMs, clock.lastPlaybackMs + MIN_SEGMENT_MS);
    clock.lastPlaybackMs = fallback;
    return { timeMs: fallback, reset: false };
  }

  const serverStep = serverMs - clock.lastServerMs;
  // The server clock RAN BACKWARD. Within one match that cannot happen — a
  // room's `matchTimer` only ever accumulates — so this is a different match on
  // the same socket (a restart replaying from 0). Reset at once rather than wait
  // for the observation window to notice: until the mapping is repaired, every
  // buffered timestamp is a minute in the past and the bracket is dry on every
  // single frame.
  if (serverStep < 0) return seedSnapshotClock(clock, serverMs, arrivalMs);
  if (serverStep === 0) {
    // The server clock is FROZEN: a lobby or the start countdown, where the sim
    // is not stepped at all (`ArenaSimulation.tick` returns before `elapsed +=`),
    // or a single sim tick starved on the host. Nothing in the world moved, so
    // there is nothing to time — hold the mapping and only stay monotonic.
    //
    // The observation window is DROPPED because these arrivals measure how long
    // the clock has been frozen, not how long the network took: keeping them
    // would drag the offset estimate up by the whole lobby, and clearing them is
    // also what lets the very first moving patch be recognised as the clock jump
    // it is (GO, after a lobby of arbitrary length).
    clock.instants.length = 0;
    const held = clock.lastPlaybackMs + MIN_SEGMENT_MS;
    clock.lastPlaybackMs = held;
    return { timeMs: held, reset: false };
  }

  clock.instants.push(instant);
  if (clock.instants.length > CLOCK_WINDOW) clock.instants.shift();
  let target = Infinity;
  for (const v of clock.instants) if (v < target) target = v;
  // Even the BEST patch in the whole window is far off the current mapping, so
  // the server clock moved rather than drifted (a match going live after a
  // lobby; a route change that added a fixed leg of latency). Slewing across
  // that at 30 ms/s would leave the buffer unusable for the whole crossing.
  if (Math.abs(target - clock.offsetMs) > SNAPSHOT_CLOCK_RESET_MS) {
    return seedSnapshotClock(clock, serverMs, arrivalMs);
  }

  const budget = serverStep * CLOCK_SLEW_FRACTION;
  clock.offsetMs += Math.max(-budget, Math.min(budget, target - clock.offsetMs));
  clock.lastServerMs = serverMs;
  // The `max` is the monotonicity backstop for a server clock that stalled: a
  // room whose sim tick was starved republishes the same `matchTimer`, and a
  // buffer whose timestamps do not increase is a divide by zero in `bracket`.
  const timeMs = Math.max(serverMs + clock.offsetMs, clock.lastPlaybackMs + MIN_SEGMENT_MS);
  clock.lastPlaybackMs = timeMs;
  return { timeMs, reset: false };
}

function seedSnapshotClock(clock: SnapshotClockState, serverMs: number, arrivalMs: number): SnapshotStamp {
  const offset = Number.isFinite(arrivalMs - serverMs) ? arrivalMs - serverMs : 0;
  clock.seeded = true;
  clock.offsetMs = offset;
  clock.instants.length = 0;
  clock.instants.push(offset);
  clock.lastServerMs = serverMs;
  // Seeding lands the sample on its own arrival instant, which is where the old
  // arrival-time stamping would have put it — so the first frame after a reset
  // is never worse than the behaviour this replaced.
  clock.lastPlaybackMs = arrivalMs;
  return { timeMs: arrivalMs, reset: true };
}

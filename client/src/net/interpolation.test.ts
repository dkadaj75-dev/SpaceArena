import { describe, expect, it } from "vitest";
import { adaptiveRenderDelay, bracket, createSnapshotClock, decayCorrection, hermitePosition, lerpHeading, RENDER_DELAY_CEIL_MS, stampSnapshot, timeBasedPull, WIDEN_MS_PER_SECOND, type TimedPos, type Vec3 } from "./interpolation.js";
import { decodeCenti, decodeHeading, encodeCenti, encodeHeading } from "@space-arena/shared";

describe("net interpolation", () => {
  it("brackets snapshots and caps extrapolation to one interval", () => { const r = bracket([{ time: 0 }, { time: 50 }], 200)!; expect(r[2]).toBe(1); expect(bracket([{ time: 0 }, { time: 50 }], 25)![2]).toBe(.5); });
  it("HOLDS the newest sample when the render point overruns it, never rewinds", () => {
    // Regression: the dry branch used to answer the phase measured from the wrong
    // end of the pair it returns. One frame before the overrun the ship is drawn
    // at the newest sample; one frame after, it was drawn at the one BEFORE it —
    // a teleport backward by a whole segment, then a real-time replay of travel
    // it had already flown. Every momentary starve cost a visible rewind.
    const buf = [{ time: 0 }, { time: 50 }, { time: 100 }];
    expect(bracket(buf, 100)![2]).toBe(1); // last in-range frame: at the newest
    expect(bracket(buf, 101)![2]).toBe(1); // first dry frame: still at the newest
    expect(bracket(buf, 400)![2]).toBe(1); // and it stays there, never extrapolates
    expect(bracket(buf, 101)![1]).toBe(buf[2]);
  });
  it("never divides by a zero-length segment", () => {
    expect(bracket([{ time: 10 }, { time: 10 }, { time: 20 }], 10)![2]).not.toBeNaN();
  });
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

describe("hermitePosition", () => {
  const P = (time: number, x: number, y = 0, z = 0): TimedPos => ({ time, pos: { x, y, z } });
  const at = (prev: TimedPos | null, from: TimedPos, to: TimedPos, next: TimedPos | null, t: number): Vec3 =>
    hermitePosition(prev, from, to, next, t, { x: 0, y: 0, z: 0 });

  it("passes exactly through the bracketing samples", () => {
    const [s0, s1, s2, s3] = [P(0, 1, 2, 3), P(50, 4, 5, 6), P(100, 8, 7, 6), P(150, 10, 9, 8)];
    expect(at(s0, s1, s2, s3, 0)).toEqual({ x: 4, y: 5, z: 6 });
    expect(at(s0, s1, s2, s3, 1)).toEqual({ x: 8, y: 7, z: 6 });
  });

  it("degrades to exact lerp when no neighbours bracket the segment", () => {
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const p = at(null, P(0, 1, -2, 4), P(50, 5, 2, 4), null, t);
      expect(p.x).toBeCloseTo(1 + 4 * t, 12);
      expect(p.y).toBeCloseTo(-2 + 4 * t, 12);
      expect(p.z).toBeCloseTo(4, 12);
    }
  });

  it("is C1 across a knot where lerp steps — the 20 Hz turn shudder", () => {
    // A constant-speed circle sampled at 20 Hz: the velocity DIRECTION changes
    // at every knot, which is exactly where C0 interpolation kicks.
    const R = 10;
    const w = 1.2e-3; // rad per ms
    const s = Array.from({ length: 5 }, (_, i) => P(i * 50, R * Math.cos(w * i * 50), 2, R * Math.sin(w * i * 50)));
    const knot = 100; // shared by segments [s1,s2] and [s2,s3]
    const left = (tau: number): Vec3 => at(s[0]!, s[1]!, s[2]!, s[3]!, (tau - 50) / 50);
    const right = (tau: number): Vec3 => at(s[1]!, s[2]!, s[3]!, s[4]!, (tau - 100) / 50);
    // Value continuity: both segments land on the sample itself.
    const pl = left(knot);
    const pr = right(knot);
    expect(pl.x).toBeCloseTo(pr.x, 12);
    expect(pl.y).toBeCloseTo(pr.y, 12);
    expect(pl.z).toBeCloseTo(pr.z, 12);
    // Velocity continuity, proven by finite differences straddling the knot.
    const eps = 1e-3; // ms
    const a = left(knot - eps);
    const b = right(knot + eps);
    const vL = { x: (pl.x - a.x) / eps, y: (pl.y - a.y) / eps, z: (pl.z - a.z) / eps };
    const vR = { x: (b.x - pr.x) / eps, y: (b.y - pr.y) / eps, z: (b.z - pr.z) / eps };
    const hermiteJump = Math.hypot(vR.x - vL.x, vR.y - vL.y, vR.z - vL.z);
    // Lerp's velocity step at the same knot is the difference of chord slopes.
    const chord = (u: TimedPos, v: TimedPos): Vec3 => ({
      x: (v.pos.x - u.pos.x) / (v.time - u.time),
      y: (v.pos.y - u.pos.y) / (v.time - u.time),
      z: (v.pos.z - u.pos.z) / (v.time - u.time),
    });
    const cl = chord(s[1]!, s[2]!);
    const cr = chord(s[2]!, s[3]!);
    const lerpJump = Math.hypot(cr.x - cl.x, cr.y - cl.y, cr.z - cl.z);
    // Hermite's residual is pure finite-difference truncation (~accel·eps);
    // lerp's is a real velocity step two-plus orders of magnitude larger.
    expect(hermiteJump).toBeLessThan(1e-6);
    expect(lerpJump).toBeGreaterThan(5e-4);
    expect(hermiteJump).toBeLessThan(lerpJump / 100);
  });

  /** Sweep every segment of a sampled path, asserting the curve stays inside the
   * AABB of the samples that shaped it, per axis, within `eps(chordLength)`. */
  const assertInsideAabb = (s: readonly TimedPos[], eps: (chord: number) => number): void => {
    for (let seg = 0; seg + 1 < s.length; seg++) {
      const from = s[seg]!;
      const to = s[seg + 1]!;
      const prev = s[seg - 1] ?? null;
      const next = s[seg + 2] ?? null;
      const involved = [prev, from, to, next].filter((q): q is TimedPos => q !== null);
      const chord = Math.hypot(to.pos.x - from.pos.x, to.pos.y - from.pos.y, to.pos.z - from.pos.z);
      const slack = eps(chord);
      for (const axis of ["x", "y", "z"] as const) {
        const lo = Math.min(...involved.map((q) => q.pos[axis]));
        const hi = Math.max(...involved.map((q) => q.pos[axis]));
        for (let i = 0; i <= 64; i++) {
          const p = at(prev, from, to, next, i / 64);
          expect(p[axis]).toBeGreaterThanOrEqual(lo - slack);
          expect(p[axis]).toBeLessThanOrEqual(hi + slack);
        }
      }
    }
  };

  it("stays exactly inside the sample AABB through a head-on bounce", () => {
    // A ship flying straight into a rock and reflecting. The apex-approach
    // segment sees its outgoing tangent reversed against the chord, degrades to
    // lerp, and the whole path never pokes past the apex — into the rock.
    assertInsideAabb([P(0, 0), P(50, 6), P(100, 9), P(150, 5), P(200, -1)], () => 1e-9);
  });

  it("overshoots a glancing bounce by at most a whisker of the chord", () => {
    // Same reflection with cross-track cruise: the z-motion keeps tangent·chord
    // positive, so the apex segment stays a curve, and the clamped tangents cap
    // the excursion past the apex plane at a sub-visible sliver (measured
    // ~0.2% of the chord here; 2% asserted as the hard ceiling).
    assertInsideAabb(
      [P(0, 0, 0, 0), P(50, 6, 0, 5), P(100, 9, 0, 10), P(150, 5, 0, 15), P(200, -1, 0, 20)],
      (chord) => Math.max(1e-9, 0.02 * chord),
    );
  });

  it("degrades the reversal segment to exact lerp", () => {
    // Approaching the apex, the outgoing neighbour has already turned back:
    // the `to` tangent points against the chord, so this segment must be lerp.
    const [s0, s1, s2, s3] = [P(0, 0), P(50, 6), P(100, 9), P(150, 4)];
    for (const t of [0.2, 0.5, 0.8]) {
      expect(at(s0, s1, s2, s3, t).x).toBeCloseTo(6 + 3 * t, 12);
    }
  });

  it("clamps a runaway tangent from a teleported neighbour", () => {
    // The previous sample is a respawn on the far side of the map. Unclamped,
    // the tangent it implies (~500 units over this segment) would fling the
    // curve tens of units off the chord; clamped to the chord length the
    // deviation is bounded by (4/27)·(|M1|+|M2|) ≈ 0.3 · chord.
    const prev = P(0, -1000, 500, 0);
    const from = P(50, 0, 0, 0);
    const to = P(100, 1, 0, 0);
    const next = P(150, 2, 0, 0);
    for (let i = 0; i <= 64; i++) {
      const t = i / 64;
      const p = at(prev, from, to, next, t);
      const offChord = Math.hypot(p.x - t, p.y, p.z); // chord runs (0,0,0)→(1,0,0)
      expect(offChord).toBeLessThanOrEqual(0.3 + 1e-9);
    }
  });

  it("holds position on coincident or zero-length segments", () => {
    // Single-snapshot bracket (from === to) and a stationary ship must both
    // stay put — the tangent clamp scales any neighbour pull down to zero.
    const still = P(50, 3, 4, 5);
    expect(at(null, still, still, null, 0.5)).toEqual({ x: 3, y: 4, z: 5 });
    const moved = at(P(0, -8, 0, 0), P(50, 3, 4, 5), P(100, 3, 4, 5), P(150, 9, 4, 5), 0.5);
    expect(moved).toEqual({ x: 3, y: 4, z: 5 });
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

  it("widens on a MEASURED shortfall even when the gap estimate is happy", () => {
    // Closed loop: the arrival cadence says 50 ms patches (target = the floor),
    // but the render point actually overran the newest sample by 40 ms. The
    // open-loop estimator cannot see that — a duplicated `matchTimer`, a sim tick
    // lost to a server GC — so the shortfall has to be able to raise the target
    // on its own. Still rate-limited: no step, same as any other widening.
    const calm = Array.from({ length: 20 }, () => 50);
    expect(adaptiveRenderDelay(100, calm, 100, dt, RENDER_DELAY_CEIL_MS, 40)).toBeCloseTo(100 + WIDEN_MS_PER_SECOND * dt, 6);
    // A healthy frame reports zero and leaves the tuned behaviour exactly alone.
    expect(adaptiveRenderDelay(100, calm, 100, dt, RENDER_DELAY_CEIL_MS, 0)).toBe(100);
    // And the ceiling still wins over any shortfall.
    expect(adaptiveRenderDelay(RENDER_DELAY_CEIL_MS, calm, 100, dt, RENDER_DELAY_CEIL_MS, 500)).toBe(RENDER_DELAY_CEIL_MS);
  });

  it("honours a designer-lowered ceiling", () => {
    const awful = Array.from({ length: 20 }, () => 400);
    let delay = 100;
    for (let i = 0; i < 300; i++) delay = adaptiveRenderDelay(delay, awful, 100, dt, 200);
    expect(delay).toBe(200);
  });
});

/**
 * The playback clock. Every case here is stated in terms of the real room:
 * `ArenaRoom` steps its sim at 30 Hz and broadcasts at 20 Hz, so a patch carries
 * whichever tick was most recent when it fired — 33.3 ms of travel, then 66.7,
 * alternating.
 */
describe("stampSnapshot", () => {
  const TICK_MS = 1000 / 30;
  const PATCH_MS = 50;
  /** Sim time the patch broadcast at `patchMs` actually carries. */
  const tickBefore = (patchMs: number): number => Math.floor(patchMs / TICK_MS) * TICK_MS;

  it("spaces samples by SERVER time, not by arrival time", () => {
    const clock = createSnapshotClock();
    const times: number[] = [];
    for (let patch = 0; patch <= 500; patch += PATCH_MS) {
      times.push(stampSnapshot(clock, tickBefore(patch), patch).timeMs);
    }
    // Arrival stamping would have produced a uniform 50 ms here — which is the
    // bug: it plays 66.7 ms of travel back over 50 ms and then 33.3 ms over 50,
    // i.e. every remote hull surging 1.33x then 0.67x, ten times a second.
    const steps = times.slice(1).map((t, i) => t - times[i]!);
    for (const step of steps) expect(step === 0 || Math.abs(step - TICK_MS) < 1e-6 || Math.abs(step - 2 * TICK_MS) < 1e-6).toBe(true);
    expect(steps.some((s) => s > 1.5 * TICK_MS)).toBe(true);
    expect(steps.some((s) => s < 1.5 * TICK_MS)).toBe(true);
    // And the timeline as a whole still keeps pace with the wall clock.
    expect(times[times.length - 1]).toBeCloseTo(tickBefore(500), 6);
  });

  it("ignores a late patch instead of warping the timeline for it", () => {
    // Jitter is the render delay's problem. A patch that queued for 80 ms must
    // still be filed at the instant the server sampled it, or the jitter is
    // written straight into the rendered speed of everything in the segment.
    const clock = createSnapshotClock();
    for (let patch = 0; patch < 400; patch += PATCH_MS) stampSnapshot(clock, tickBefore(patch), patch);
    const onTime = stampSnapshot(clock, tickBefore(400), 400).timeMs;
    const late = stampSnapshot(clock, tickBefore(450), 450 + 80).timeMs;
    expect(late - onTime).toBeCloseTo(tickBefore(450) - tickBefore(400), 3);
  });

  it("slews out a drifting server clock without ever stepping the timeline", () => {
    // `elapsed` advances by a fixed 1/30 per tick while the host's timer fires on
    // a real interval, so the sim clock runs a percent or two off wall time.
    // Unmanaged, that walks the whole buffer out of the render window inside a
    // minute. The correction is bounded to 3% of a segment, so it is invisible.
    const clock = createSnapshotClock();
    const DRIFT = 1.02; // server sim clock runs 2% fast
    let worstBend = 0;
    let previous = 0;
    let previousServer = 0;
    for (let patch = 0; patch <= 60_000; patch += PATCH_MS) {
      const server = tickBefore(patch) * DRIFT;
      const time = stampSnapshot(clock, server, patch).timeMs;
      if (patch > 0) {
        const bend = Math.abs(time - previous - (server - previousServer));
        worstBend = Math.max(worstBend, bend / Math.max(1, server - previousServer));
      }
      previous = time;
      previousServer = server;
      // The lag of the playback timeline behind arrival must stay bounded: this
      // is the quantity that walks away without drift control (2% of 60 s = 1.2 s
      // of it, twenty times the whole interpolation buffer).
      expect(Math.abs(patch - time)).toBeLessThan(60);
    }
    expect(worstBend).toBeLessThanOrEqual(0.031);
  });

  it("keeps timestamps strictly increasing when the server clock stalls", () => {
    // A room whose sim tick was starved republishes the same `matchTimer`. Two
    // samples at one instant is a zero-length segment, i.e. a divide by zero in
    // `bracket` and NaN in every mesh position downstream.
    const clock = createSnapshotClock();
    const a = stampSnapshot(clock, 1000, 5000).timeMs;
    const b = stampSnapshot(clock, 1000, 5050).timeMs;
    const c = stampSnapshot(clock, 1000, 5100).timeMs;
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
    expect(bracket([{ time: a }, { time: b }, { time: c }], b)![2]).not.toBeNaN();
  });

  it("reseeds when the match goes live and `matchTimer` leaves 0", () => {
    // The whole lobby replicates `matchTimer = 0`; GO starts it moving, which is
    // a clock jump of however long the lobby lasted. Slewing across that at
    // 30 ms/s would leave the buffer unusable for minutes.
    const clock = createSnapshotClock();
    // A frozen clock is not a jump: the lobby itself never reseeds, however long
    // it lasts, and its timestamps still only ever increase.
    let last = -Infinity;
    for (let patch = 0; patch < 3000; patch += PATCH_MS) {
      const stamp = stampSnapshot(clock, 0, patch);
      expect(stamp.reset).toBe(patch === 0);
      expect(stamp.timeMs).toBeGreaterThan(last);
      last = stamp.timeMs;
    }
    const live = stampSnapshot(clock, TICK_MS, 3000);
    expect(live.reset).toBe(true);
    expect(live.timeMs).toBe(3000);
    // ...and it is a one-off: normal play afterwards never resets again.
    for (let patch = 3050; patch < 6000; patch += PATCH_MS) {
      expect(stampSnapshot(clock, tickBefore(patch - 3000) + TICK_MS, patch).reset).toBe(false);
    }
  });

  it("reseeds when the server clock jumps BACKWARD (a match restart)", () => {
    const clock = createSnapshotClock();
    for (let patch = 0; patch < 2000; patch += PATCH_MS) stampSnapshot(clock, tickBefore(patch) + 60_000, patch);
    expect(stampSnapshot(clock, 0, 2000).reset).toBe(true);
  });

  it("degrades to arrival stamping, without a reset, for one unusable sample", () => {
    const clock = createSnapshotClock();
    for (let patch = 0; patch < 500; patch += PATCH_MS) stampSnapshot(clock, tickBefore(patch), patch);
    const broken = stampSnapshot(clock, Number.NaN, 500);
    expect(broken.reset).toBe(false);
    expect(broken.timeMs).toBe(500);
  });
});

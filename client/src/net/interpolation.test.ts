import { describe, expect, it } from "vitest";
import { adaptiveRenderDelay, angularVelocity, bracket, createSnapshotClock, decayCorrection, ExtrapolationBlender, frameDelta, hermiteFrame, hermitePosition, lerpHeading, MAX_ANGULAR_EXTRAPOLATION_RAD, MAX_EXTRAPOLATION_MS, p90ArrivalGap, VELOCITY_TANGENT_CHORD_LIMIT, RENDER_DELAY_CEIL_MS, rotateByVector, stampSnapshot, timeBasedPull, WIDEN_MS_PER_SECOND, type TimedFrame, type TimedPos, type Vec3 } from "./interpolation.js";
import { decodeCenti, decodeHeading, encodeCenti, encodeHeading, facingVec, interpolateFrame, upFromAttitude, type FrameAttitude } from "@space-arena/shared";

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

/**
 * Velocity-tangent Hermite (2026-08-18), the second half of the patch phase-lock
 * work: `PlayerState` now replicates the ship's own velocity, so the curve's end
 * tangents can be the TRUE derivative at each knot instead of an estimate
 * reconstructed from where the hull happened to be sampled nearby.
 */
describe("hermitePosition with replicated velocity", () => {
  /** `time` in ms, `vel` in units per SECOND — the units the wire uses. */
  const V = (time: number, x: number, vx: number): TimedPos => ({
    time,
    pos: { x, y: 0, z: 0 },
    vel: { x: vx, y: 0, z: 0 },
  });
  const P = (time: number, x: number): TimedPos => ({ time, pos: { x, y: 0, z: 0 } });
  const at = (prev: TimedPos | null, from: TimedPos, to: TimedPos, next: TimedPos | null, t: number): Vec3 =>
    hermitePosition(prev, from, to, next, t, { x: 0, y: 0, z: 0 });

  /**
   * A representative patch gap (the pre-60 Hz room's 15 Hz cadence). The curve
   * math is cadence-agnostic; this suite's fixtures and hand-derived slope
   * expectations were built at this H, so it stays PINNED — re-deriving every
   * expectation for 16.7 ms would buy nothing (the shipped-cadence pipeline is
   * covered end to end by renderPacing.test.ts).
   */
  const H = 1000 / 15;

  it("makes the curve's derivative at a knot the sample's OWN velocity", () => {
    // This is the whole claim. A finite difference answers the average slope of
    // the neighbourhood; the replicated value answers what the ship was actually
    // doing at that instant, which is what a tangent is supposed to be.
    const from = V(0, 0, 30);
    const to = V(H, 3, 60);
    const eps = 1e-6;
    const dAt = (t: number): number =>
      (at(null, from, to, null, t + eps).x - at(null, from, to, null, t - eps).x) / (2 * eps * (H / 1000));
    expect(dAt(0)).toBeCloseTo(30, 6);
    expect(dAt(1)).toBeCloseTo(60, 6);
  });

  it("reproduces a CUBIC path exactly, which finite differences cannot", () => {
    // Cubic Hermite with exact end tangents is exact on any cubic. A
    // Catmull-Rom finite difference is not: on x = t³ it overestimates the
    // tangent by h², so the reconstructed path bulges. This is the accuracy
    // difference in its cleanest form — and it is not academic, it is what
    // "motion the samples do not show" means for a hull whose thrust is
    // changing inside one 66.7 ms patch gap.
    const x = (ms: number): number => Math.pow(ms / 1000, 3);
    const v = (ms: number): number => 3 * Math.pow(ms / 1000, 2); // units per second
    const times = [0, H, 2 * H, 3 * H];
    const withVel = times.map((ms) => V(ms, x(ms), v(ms)));
    const withoutVel = times.map((ms) => P(ms, x(ms)));

    let velErr = 0;
    let fdErr = 0;
    for (let i = 0; i <= 32; i++) {
      const t = i / 32;
      const atMs = H + t * H; // the middle segment, which HAS both neighbours
      velErr = Math.max(velErr, Math.abs(at(withVel[0]!, withVel[1]!, withVel[2]!, withVel[3]!, t).x - x(atMs)));
      fdErr = Math.max(fdErr, Math.abs(at(withoutVel[0]!, withoutVel[1]!, withoutVel[2]!, withoutVel[3]!, t).x - x(atMs)));
    }
    expect(velErr).toBeLessThan(1e-12);
    expect(fdErr).toBeGreaterThan(velErr * 1000);
  });

  it("keeps the NEWEST segment curved, where a finite difference has no neighbour", () => {
    // The buffer's last segment has no `next` sample by construction, so the
    // finite-difference path degrades that end to the chord — i.e. to lerp —
    // exactly on the segment closest to what the pilot is looking at. The
    // replicated velocity needs no neighbour at all.
    const from = V(0, 0, 30);
    const to = V(H, 3, 60);
    const eps = 1e-6;
    const endSlope = (a: TimedPos, b: TimedPos): number =>
      (at(null, a, b, null, 1).x - at(null, a, b, null, 1 - eps).x) / (eps * (H / 1000));
    expect(endSlope(from, to)).toBeCloseTo(60, 4);
    // Same samples with the velocity stripped: the end slope is just the chord.
    expect(endSlope(P(0, 0), P(H, 3))).toBeCloseTo(3 / (H / 1000), 4);
  });

  it("falls back to finite differences per END, so a mixed pair still works", () => {
    // Back-compat: a sample with no velocity (pre-velocity server, decoded
    // all-zero triple) must not poison the end that does have one.
    const prev = P(-H, -3);
    const from = P(0, 0); // no velocity: falls back to the Catmull-Rom tangent
    const to = V(H, 3, 60); // velocity: exact tangent
    const eps = 1e-6;
    const slope = (t: number): number =>
      (at(prev, from, to, null, t + eps).x - at(prev, from, to, null, t - eps).x) / (2 * eps * (H / 1000));
    expect(slope(1)).toBeCloseTo(60, 4); // the velocity end is exact
    expect(slope(0)).toBeCloseTo(45, 4); // the other is (3 − −3)/(2H) = 45 u/s
  });

  it("is byte-identical to the old curve when NO sample carries velocity", () => {
    const s = [P(0, 0), P(H, 6), P(2 * H, 9), P(3 * H, 5)];
    // Same fixtures as the finite-difference suite above; nothing about adding
    // an optional field may move a curve for a peer that does not send it.
    for (let i = 0; i <= 16; i++) {
      const t = i / 16;
      expect(at(s[0]!, s[1]!, s[2]!, s[3]!, t).x).toBe(
        hermitePosition(s[0]!, s[1]!, s[2]!, s[3]!, t, { x: 0, y: 0, z: 0 }).x,
      );
    }
  });

  it("still degrades a REVERSAL to lerp — a velocity tangent is not a licence to overshoot", () => {
    // The ship bounced inside this segment: it is still travelling +x at the
    // `from` knot but the segment's chord runs −x. Smoothing through that would
    // draw the hull inside the rock it hit.
    const from = V(0, 9, 40);
    const to = V(H, 5, -40);
    for (const t of [0.2, 0.5, 0.8]) {
      expect(at(null, from, to, null, t).x).toBeCloseTo(9 - 4 * t, 12);
    }
  });

  it("still clamps a velocity far longer than the chord — a hard brake", () => {
    // Reported 300 u/s into a segment that only travelled 1 unit: the ship
    // stopped dead inside the gap, so |M1| is 20x the chord. The velocity bound
    // is looser than the finite-difference one (3x the chord, the
    // Fritsch-Carlson limit) but it is still a bound: the excursion past the
    // chord stays under (4/27)·3 ≈ 0.45·|chord|.
    const from = V(0, 0, 300);
    const to = V(H, 1, 0);
    for (let i = 0; i <= 32; i++) {
      const t = i / 32;
      expect(Math.abs(at(null, from, to, null, t).x - t)).toBeLessThanOrEqual(0.45);
    }
  });

  it("lets an ACCELERATING ship's true tangent through, where a 1x chord cap would not", () => {
    // A hull under thrust has endpoint velocities that straddle the chord's
    // average by construction, so a 1x cap would fire on every accelerating
    // ship on every frame — silently throwing away exactly the information
    // velocity was replicated to provide. Here 30→60 u/s across the segment.
    const from = V(0, 0, 30);
    const to = V(H, 3, 60);
    const eps = 1e-6;
    const slope = (t: number): number =>
      (at(null, from, to, null, t + eps).x - at(null, from, to, null, t - eps).x) / (2 * eps * (H / 1000));
    expect(slope(0)).toBeCloseTo(30, 4);
    expect(slope(1)).toBeCloseTo(60, 4);
    // |M2| here is 4 against a chord of 3 — 1.33x, comfortably inside the 3x
    // bound and comfortably outside the old one.
    expect(60 * (H / 1000)).toBeGreaterThan(3);
    expect(60 * (H / 1000)).toBeLessThan(3 * VELOCITY_TANGENT_CHORD_LIMIT);
  });

  it("still passes exactly through both bracketing samples", () => {
    const from = V(0, 4, 25);
    const to = V(H, 8, -12);
    expect(at(null, from, to, null, 0).x).toBe(4);
    expect(at(null, from, to, null, 1).x).toBe(8);
  });
});

/**
 * Bounded dead reckoning past the newest sample (2026-08-18).
 *
 * `bracket` still clamps its PAIR and PHASE to the newest sample — the dry-branch
 * rewind regression it was written to fix stays fixed — and now additionally
 * reports how far the render point overran, so a caller holding a replicated
 * velocity can carry the hull forward instead of parking it.
 */
describe("bracket extrapolation lead", () => {
  const buf = [{ time: 0 }, { time: 66 }, { time: 132 }];

  it("reports no lead while the bracket is wet", () => {
    expect(bracket(buf, 0)![3]).toBe(0);
    expect(bracket(buf, 100)![3]).toBe(0);
    expect(bracket(buf, 132)![3]).toBe(0);
    expect(bracket(buf, -500)![3]).toBe(0);
    expect(bracket([{ time: 5 }], 900)![3]).toBe(0);
  });

  it("reports the overrun once dry, and SATURATES at one patch gap", () => {
    expect(bracket(buf, 152)![3]).toBe(20);
    expect(bracket(buf, 232)![3]).toBe(MAX_EXTRAPOLATION_MS);
    // A long outage does not keep growing the guess: it degrades to the old
    // freeze, just 100 ms further along.
    expect(bracket(buf, 5000)![3]).toBe(MAX_EXTRAPOLATION_MS);
  });

  it("leaves the clamped pair and phase exactly as they were", () => {
    const dry = bracket(buf, 400)!;
    expect(dry[0]).toBe(buf[1]);
    expect(dry[1]).toBe(buf[2]);
    expect(dry[2]).toBe(1);
  });
});

describe("ExtrapolationBlender", () => {
  const V = { x: 10, y: 0, z: 0 };
  const at = (x: number): Vec3 => ({ x, y: 0, z: 0 });
  const DT = 1 / 60;

  it("is a pure pass-through while the buffer is healthy", () => {
    const b = new ExtrapolationBlender();
    const out = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < 10; i++) {
      expect(b.resolve(1, at(i), V, 0, DT, out)).toEqual({ x: i, y: 0, z: 0 });
    }
    expect(b.residualOf(1)).toBeUndefined();
  });

  it("carries the hull forward along its velocity instead of freezing", () => {
    const b = new ExtrapolationBlender();
    const out = { x: 0, y: 0, z: 0 };
    b.resolve(1, at(0), V, 0, DT, out);
    // `base` is frozen at the newest sample (bracket clamps t = 1) while the
    // lead grows — so all the motion here comes from the dead reckoning.
    expect(b.resolve(1, at(0), V, 16, DT, out).x).toBeCloseTo(0.16, 12);
    expect(b.resolve(1, at(0), V, 50, DT, out).x).toBeCloseTo(0.5, 12);
    expect(b.resolve(1, at(0), V, 100, DT, out).x).toBeCloseTo(1, 12);
  });

  it("freezes, exactly as before, for a sample with no velocity", () => {
    const b = new ExtrapolationBlender();
    const out = { x: 0, y: 0, z: 0 };
    expect(b.resolve(1, at(7), undefined, 100, DT, out)).toEqual({ x: 7, y: 0, z: 0 });
  });

  it("NEVER rewinds when a fresh sample lands under an over-eager guess", () => {
    // The regression this class exists to avoid. The ship was decelerating, so
    // the straight-line guess ran ahead of where it really went: a naive
    // hand-back would teleport the hull BACKWARD onto the curve.
    const b = new ExtrapolationBlender();
    const out = { x: 0, y: 0, z: 0 };
    b.resolve(1, at(0), V, 0, DT, out);
    const guessed = b.resolve(1, at(0), V, 100, DT, out).x;
    expect(guessed).toBeCloseTo(1, 12);
    // Patch lands: the true path only reached 0.4 in that time.
    const handback = b.resolve(1, at(0.4), V, 0, DT, out).x;
    // Continuous in VELOCITY, not merely in position: the hull carries its last
    // known speed across the seam (`+ v·dt`) rather than being pinned to exactly
    // where it was, which would draw a stalled frame. Never backward.
    expect(handback).toBeCloseTo(guessed + 10 * DT, 12);
    expect(handback).toBeGreaterThan(guessed);
    expect(b.residualOf(1)!.x).toBeCloseTo(1 + 10 * DT - 0.4, 12);
  });

  it("draws a FULL frame of motion on the handback, not a stalled one", () => {
    // Position-only continuity (`anchor = drawn`) passes every no-rewind
    // assertion and still costs one frozen frame at the exact moment the buffer
    // recovers — the freeze this class removes, relocated. The handback frame
    // must advance by a normal frame's travel.
    const b = new ExtrapolationBlender();
    const out = { x: 0, y: 0, z: 0 };
    b.resolve(1, at(0), V, 0, DT, out);
    const last = b.resolve(1, at(0), V, 100, DT, out).x;
    const handback = b.resolve(1, at(1.0), V, 0, DT, out).x;
    expect(handback - last).toBeCloseTo(10 * DT, 12);
  });

  it("repays the residual smoothly, always moving forward, and lets go", () => {
    const b = new ExtrapolationBlender();
    const out = { x: 0, y: 0, z: 0 };
    b.resolve(1, at(0), V, 0, DT, out);
    b.resolve(1, at(0), V, 100, DT, out); // guess reaches 1.0
    let base = 0.4;
    let last = b.resolve(1, at(base), V, 0, DT, out).x;
    const drawn: number[] = [last];
    for (let frame = 0; frame < 120; frame++) {
      base += 10 * DT; // the true path resumes at cruise
      const x = b.resolve(1, at(base), V, 0, DT, out).x;
      expect(x).toBeGreaterThanOrEqual(last - 1e-12); // monotone: no rewind, ever
      last = x;
      drawn.push(x);
    }
    // Converged onto the authoritative path and released its state.
    expect(last).toBeCloseTo(base, 6);
    expect(b.residualOf(1)).toBeUndefined();
    // And it got there quickly — the residual is gone well inside a second.
    expect(drawn[36]! - (0.4 + 36 * 10 * DT)).toBeLessThan(0.05);
  });

  it("stays continuous when a second starve interrupts a repayment", () => {
    const b = new ExtrapolationBlender();
    const out = { x: 0, y: 0, z: 0 };
    b.resolve(1, at(0), V, 0, DT, out);
    b.resolve(1, at(0), V, 100, DT, out);
    const afterFirst = b.resolve(1, at(0.4), V, 0, DT, out).x;
    b.resolve(1, at(0.4), V, 0, DT, out); // one frame of decay
    const beforeSecond = b.resolve(1, at(0.4), V, 0, DT, out).x;
    // Dry again: the residual FREEZES and the new lead is added on top of it,
    // so the very first dry frame does not step either.
    const firstDry = b.resolve(1, at(0.4), V, 1, DT, out).x;
    expect(firstDry).toBeGreaterThan(beforeSecond);
    expect(firstDry - beforeSecond).toBeLessThan(0.02);
    expect(afterFirst).toBeGreaterThan(beforeSecond); // it really had been decaying
  });

  it("snaps rather than blending across a respawn-sized residual", () => {
    // A blend would drag the hull across the arena for half a second. Same
    // judgement `decayCorrection` makes with its snapDistance.
    const b = new ExtrapolationBlender();
    const out = { x: 0, y: 0, z: 0 };
    b.resolve(1, at(0), V, 0, DT, out);
    b.resolve(1, at(0), V, 100, DT, out);
    expect(b.resolve(1, at(-400), V, 0, DT, out)).toEqual({ x: -400, y: 0, z: 0 });
    expect(b.residualOf(1)).toBeUndefined();
  });

  it("keeps ships independent and forgets the ones that leave", () => {
    const b = new ExtrapolationBlender();
    const out = { x: 0, y: 0, z: 0 };
    for (const id of [1, 2]) {
      b.resolve(id, at(0), V, 0, DT, out);
      b.resolve(id, at(0), V, 100, DT, out);
      b.resolve(id, at(0.4), V, 0, DT, out);
    }
    const expected = 1 + 10 * DT - 0.4; // the velocity-continuous re-anchor
    expect(b.residualOf(1)!.x).toBeCloseTo(expected, 12);
    expect(b.residualOf(2)!.x).toBeCloseTo(expected, 12);
    b.retain(new Set([1]));
    expect(b.residualOf(1)).toBeDefined();
    expect(b.residualOf(2)).toBeUndefined();
    // A ship that left and came back starts clean rather than inheriting a
    // residual measured against a position it no longer has.
    expect(b.resolve(2, at(80), V, 0, DT, out)).toEqual({ x: 80, y: 0, z: 0 });
    b.clear();
    expect(b.residualOf(1)).toBeUndefined();
  });
});

describe("adaptiveRenderDelay", () => {
  const dt = 1 / 60;
  // The session computes the p90 once per patch and hands the number to every
  // frame (the per-frame sort was hot-path churn); these tests compose the two
  // exactly as `NetGameSession` does.
  const p90 = (gaps: readonly number[]) => p90ArrivalGap(gaps);

  it("stays at the authored floor on a calm network", () => {
    // Steady 50 ms patches want 2×p90 = 100 = the floor: behaviour unchanged.
    const gaps = Array.from({ length: 20 }, () => 50);
    expect(adaptiveRenderDelay(100, p90(gaps), 100, dt)).toBe(100);
  });

  it("stays floor-dominated at the shipped 60 Hz cadence", () => {
    // The production steady state after the 60 Hz patch change: ~16.7 ms gaps
    // against the 50 ms authored floor — 2×p90 ≈ 33 stays under the floor, so
    // a calm network renders at exactly the authored delay.
    const gaps = Array.from({ length: 20 }, () => 1000 / 60);
    expect(adaptiveRenderDelay(50, p90(gaps), 50, dt)).toBe(50);
  });

  it("holds the floor until enough gaps exist to say anything", () => {
    // The first patches of a match must not swing the delay on noise.
    expect(adaptiveRenderDelay(100, p90([]), 100, dt)).toBe(100);
    expect(adaptiveRenderDelay(100, p90([200, 210, 190]), 100, dt)).toBe(100);
  });

  it("widens FAST but never steps — a delay step is a backward step in render time", () => {
    // The measured localhost profile: ~62 ms median with bursts. 2×p90 keeps a
    // full burst of headroom between the render point and the newest snapshot.
    const gaps = [60, 62, 61, 95, 63, 62, 90, 61, 64, 62];
    // One frame moves at most one frame's worth of widening. The first cut
    // jumped the full width here, and every up-jump rewound `now - delay` —
    // the owner saw remote ships hitch backwards once per burst sample.
    const oneFrame = adaptiveRenderDelay(100, p90(gaps), 100, dt);
    expect(oneFrame).toBeCloseTo(100 + WIDEN_MS_PER_SECOND * dt, 6);
    // A zero-dt frame moves nothing at all.
    expect(adaptiveRenderDelay(100, p90(gaps), 100, 0)).toBe(100);
    // But it converges onto the burst target inside a second of frames.
    let delay = 100;
    for (let i = 0; i < 60; i++) delay = adaptiveRenderDelay(delay, p90(gaps), 100, dt);
    expect(delay).toBeGreaterThan(150);
  });

  it("narrows SLOWLY once the network calms down", () => {
    const calm = p90(Array.from({ length: 20 }, () => 50));
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
    const awful = p90(Array.from({ length: 20 }, () => 400));
    let delay = 100;
    for (let i = 0; i < 300; i++) delay = adaptiveRenderDelay(delay, awful, 100, dt);
    expect(delay).toBe(RENDER_DELAY_CEIL_MS);
  });

  it("never drops below the authored floor", () => {
    // A network faster than the floor asks for less; the floor wins.
    const fast = p90(Array.from({ length: 20 }, () => 20));
    expect(adaptiveRenderDelay(100, fast, 100, dt)).toBe(100);
  });

  it("widens on a MEASURED shortfall even when the gap estimate is happy", () => {
    // Closed loop: the arrival cadence says 50 ms patches (target = the floor),
    // but the render point actually overran the newest sample by 40 ms. The
    // open-loop estimator cannot see that — a duplicated `matchTimer`, a sim tick
    // lost to a server GC — so the shortfall has to be able to raise the target
    // on its own. Still rate-limited: no step, same as any other widening.
    const calm = p90(Array.from({ length: 20 }, () => 50));
    expect(adaptiveRenderDelay(100, calm, 100, dt, RENDER_DELAY_CEIL_MS, 40)).toBeCloseTo(100 + WIDEN_MS_PER_SECOND * dt, 6);
    // A healthy frame reports zero and leaves the tuned behaviour exactly alone.
    expect(adaptiveRenderDelay(100, calm, 100, dt, RENDER_DELAY_CEIL_MS, 0)).toBe(100);
    // And the ceiling still wins over any shortfall.
    expect(adaptiveRenderDelay(RENDER_DELAY_CEIL_MS, calm, 100, dt, RENDER_DELAY_CEIL_MS, 500)).toBe(RENDER_DELAY_CEIL_MS);
  });

  it("honours a designer-lowered ceiling", () => {
    const awful = p90(Array.from({ length: 20 }, () => 400));
    let delay = 100;
    for (let i = 0; i < 300; i++) delay = adaptiveRenderDelay(delay, awful, 100, dt, 200);
    expect(delay).toBe(200);
  });

  it("p90ArrivalGap answers null until four gaps exist, then the p90", () => {
    expect(p90ArrivalGap([])).toBeNull();
    expect(p90ArrivalGap([50, 60, 70])).toBeNull();
    expect(p90ArrivalGap([50, 50, 50, 50])).toBe(50);
    // 10 samples: index floor(10 * 0.9) = 9 → the largest.
    expect(p90ArrivalGap([1, 2, 3, 4, 5, 6, 7, 8, 9, 95])).toBe(95);
  });
});

/**
 * The playback clock. Every case here is stated in terms of the RETIRED room —
 * a 30 Hz sim beside a free 20 Hz patch timer, so a patch carried whichever
 * tick was most recent when it fired: 33.3 ms of travel, then 66.7,
 * alternating. That cadence is deliberately kept as the fixture: stampSnapshot
 * must handle ANY cadence a host can produce (timer slip, starved ticks,
 * duplicated matchTimer), and the alternating stream is the hardest legal one.
 * The shipped uniform 60 Hz cadence is the EASY case and is covered end to end
 * in renderPacing.test.ts.
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

/* ------------------------------------------------------------------------- *
 * Orientation: the same curve, applied to the rotation axis
 * ------------------------------------------------------------------------- */

/** A frame sample from an attitude, with the up axis the sim would give it. */
const FR = (time: number, heading: number, pitch = 0): TimedFrame => ({
  time,
  heading,
  pitch,
  up: upFromAttitude(heading, pitch, { x: 0, y: 0, z: 0 }),
});
const blankFrame = (): FrameAttitude => ({ heading: 0, pitch: 0, up: { x: 0, y: 1, z: 0 } });
/** The nose direction a blended frame ended up pointing. */
const noseOf = (f: FrameAttitude): Vec3 => facingVec(f.heading, f.pitch, { x: 0, y: 0, z: 0 });
const angleBetween = (
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
): number => Math.acos(Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z)));

describe("hermiteFrame", () => {
  const curve = (prev: TimedFrame | null, from: TimedFrame, to: TimedFrame, next: TimedFrame | null, t: number): Vec3 =>
    noseOf(hermiteFrame(prev, from, to, next, t, blankFrame()));
  const nlerp = (from: TimedFrame, to: TimedFrame, t: number): Vec3 =>
    noseOf(interpolateFrame(from.heading, from.pitch, from.up, to.heading, to.pitch, to.up, t, blankFrame()));

  it("passes exactly through the bracketing samples", () => {
    const [s0, s1, s2, s3] = [FR(0, 0.1, 0.05), FR(50, 0.4, 0.1), FR(100, 0.9, 0.2), FR(150, 1.7, 0.25)];
    expect(angleBetween(curve(s0, s1, s2, s3, 0), nlerp(s1!, s1!, 0))).toBeLessThan(1e-9);
    expect(angleBetween(curve(s0, s1, s2, s3, 1), nlerp(s2!, s2!, 0))).toBeLessThan(1e-9);
  });

  it("reproduces the old nlerp EXACTLY when no neighbour brackets the segment", () => {
    // The buffer edge, and a ship that just spawned. Cubic Hermite with chord
    // tangents IS lerp algebraically, so this change can only ever act where
    // there is real neighbour information to act on.
    const [from, to] = [FR(0, -0.3, 0.4), FR(50, 0.6, -0.2)];
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const c = hermiteFrame(null, from!, to!, null, t, blankFrame());
      const n = interpolateFrame(from!.heading, from!.pitch, from!.up, to!.heading, to!.pitch, to!.up, t, blankFrame());
      expect(c.heading).toBeCloseTo(n.heading, 12);
      expect(c.pitch).toBeCloseTo(n.pitch, 12);
      expect(c.up.x).toBeCloseTo(n.up.x, 12);
      expect(c.up.y).toBeCloseTo(n.up.y, 12);
      expect(c.up.z).toBeCloseTo(n.up.z, 12);
    }
  });

  it("is C1 across a knot where the nlerp steps - the 15 Hz turn shudder", () => {
    // An ACCELERATING yaw: the sampled turn rate differs from segment to
    // segment, which is where a C0 orientation blend kicks. (A perfectly uniform
    // turn is the one case nlerp already handles, by symmetry - the artefact
    // lives in the stick input actually changing, which is all a dogfight is.)
    const alpha = 7.5e-6; // rad per ms^2 = 7.5 rad/s^2 - a stick being fed in
    const s = Array.from({ length: 5 }, (_, i) => FR(i * 50, 0.5 * alpha * (i * 50) * (i * 50)));
    const knot = 100;
    const eps = 0.05; // ms
    // Angular velocity as the nose's own derivative vector: `acos` of a dot
    // product loses every digit that matters at the angles a 0.05 ms step turns
    // through, and the quantity under test IS that derivative.
    const rateJump = (left: (tau: number) => Vec3, right: (tau: number) => Vec3): number => {
      const l0 = left(knot - eps);
      const l1 = left(knot);
      const r0 = right(knot);
      const r1 = right(knot + eps);
      // Value continuity first: both segments must land on the sample itself.
      expect(Math.hypot(l1.x - r0.x, l1.y - r0.y, l1.z - r0.z)).toBeLessThan(1e-12);
      return Math.hypot(
        (r1.x - r0.x) / eps - (l1.x - l0.x) / eps,
        (r1.y - r0.y) / eps - (l1.y - l0.y) / eps,
        (r1.z - r0.z) / eps - (l1.z - l0.z) / eps,
      );
    };
    const hermiteJump = rateJump(
      (tau) => curve(s[0]!, s[1]!, s[2]!, s[3]!, (tau - 50) / 50),
      (tau) => curve(s[1]!, s[2]!, s[3]!, s[4]!, (tau - 100) / 50),
    );
    const nlerpJump = rateJump(
      (tau) => nlerp(s[1]!, s[2]!, (tau - 50) / 50),
      (tau) => nlerp(s[2]!, s[3]!, (tau - 100) / 50),
    );
    expect(nlerpJump).toBeGreaterThan(1e-5);
    expect(hermiteJump).toBeLessThan(nlerpJump / 20);
  });

  it("degrades a REVERSED turn to the nlerp rather than swinging through an arc", () => {
    // The hull bounced, or the pilot slammed the stick the other way: the
    // neighbourhood reverses at this knot and smoothing through it would draw a
    // rotation the ship never made.
    const [s0, s1, s2, s3] = [FR(0, 0), FR(50, 0.4), FR(100, 0.8), FR(150, 0.2)];
    for (const t of [0.25, 0.5, 0.75]) {
      expect(angleBetween(curve(s0!, s1!, s2!, s3!, t), nlerp(s1!, s2!, t))).toBeLessThan(1e-12);
    }
  });
});

describe("frame rotation algebra", () => {
  it("recovers the rotation between two frames, exactly for a single axis", () => {
    const nose = { x: 1, y: 0, z: 0 };
    const up = { x: 0, y: 1, z: 0 };
    for (const r of [{ x: 0, y: 0.3, z: 0 }, { x: 0.2, y: 0, z: 0 }, { x: 0, y: 0, z: -0.45 }]) {
      const bNose = rotateByVector(nose, r, { x: 0, y: 0, z: 0 });
      const bUp = rotateByVector(up, r, { x: 0, y: 0, z: 0 });
      const back = frameDelta(nose, up, bNose, bUp, { x: 0, y: 0, z: 0 });
      expect(back.x).toBeCloseTo(r.x, 12);
      expect(back.y).toBeCloseTo(r.y, 12);
      expect(back.z).toBeCloseTo(r.z, 12);
    }
  });

  it("answers zero for identical frames and never divides by a null rotation", () => {
    const d = frameDelta({ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 0 });
    expect(Math.hypot(d.x, d.y, d.z)).toBe(0);
    const v = rotateByVector({ x: 1, y: 2, z: 3 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    expect(v).toEqual({ x: 1, y: 2, z: 3 });
  });

  it("measures a ship's turn rate from two samples", () => {
    // A yaw of 0.1 rad across one 66.7 ms patch gap is 1.5 rad/s.
    const w = angularVelocity(FR(0, 0), FR(0, 0.1), 1 / 15, { x: 0, y: 0, z: 0 })!;
    expect(Math.hypot(w.x, w.y, w.z)).toBeCloseTo(0.1 * 15, 9);
    // No separation in time is not a turn rate of infinity.
    expect(angularVelocity(FR(0, 0), FR(0, 0.1), 0, { x: 0, y: 0, z: 0 })).toBeUndefined();
  });
});

describe("ExtrapolationBlender orientation", () => {
  const NOSE = { x: 1, y: 0, z: 0 };
  const UP = { x: 0, y: 1, z: 0 };
  const OMEGA = { x: 0, y: 1.5, z: 0 }; // rad/s - a hard but legal turn
  const out = (): { nose: Vec3; up: Vec3 } => ({ nose: { x: 0, y: 0, z: 0 }, up: { x: 0, y: 0, z: 0 } });
  const dt = 1 / 60;
  const turned = (rad: number): Vec3 => rotateByVector(NOSE, { x: 0, y: rad, z: 0 }, { x: 0, y: 0, z: 0 });

  it("is a pure pass-through while the buffer is healthy", () => {
    const b = new ExtrapolationBlender();
    const o = out();
    b.resolveFrame(1, NOSE, UP, OMEGA, 0, dt, o);
    expect(o.nose).toEqual(NOSE);
    expect(o.up).toEqual(UP);
    expect(b.frameResidualOf(1)).toBeUndefined();
  });

  it("keeps the nose TURNING through a starve instead of freezing it", () => {
    // The gap this closes: position dead-reckons, so the hull kept flying with a
    // frozen nose - which reads as a ship that stopped steering, and a pilot
    // leads their shot on it.
    const b = new ExtrapolationBlender();
    const o = out();
    b.resolveFrame(1, NOSE, UP, OMEGA, 100, dt, o);
    expect(angleBetween(o.nose, NOSE)).toBeCloseTo(1.5 * 0.1, 9);
    // With no turn rate to go on it freezes, exactly as it always did.
    const frozen = out();
    b.resolveFrame(2, NOSE, UP, undefined, 100, dt, frozen);
    expect(frozen.nose).toEqual(NOSE);
  });

  it("truncates a nonsense turn rate instead of spinning the hull", () => {
    // A respawn or a collision between the two bracketed samples reports tens of
    // radians per second; extrapolating that through a starve is a spinning top.
    const b = new ExtrapolationBlender();
    const o = out();
    b.resolveFrame(1, NOSE, UP, { x: 0, y: 40, z: 0 }, 100, dt, o);
    expect(angleBetween(o.nose, NOSE)).toBeCloseTo(MAX_ANGULAR_EXTRAPOLATION_RAD, 9);
  });

  it("NEVER jumps the attitude when a fresh sample lands under an over-eager guess", () => {
    const b = new ExtrapolationBlender();
    const o = out();
    let drawn: { x: number; y: number; z: number } = NOSE;
    const step = (nose: { x: number; y: number; z: number }, lead: number): number => {
      b.resolveFrame(1, nose, UP, OMEGA, lead, dt, o);
      const moved = angleBetween(drawn, o.nose);
      drawn = { x: o.nose.x, y: o.nose.y, z: o.nose.z };
      return moved;
    };
    step(NOSE, 0);
    for (const lead of [20, 50, 80, 100]) step(NOSE, lead);
    // The patch lands and the server turned LESS than the guess assumed. A naive
    // hand-back rotates the nose backward by the whole error in one frame.
    const moved = step(turned(0.05), 0);
    // One frame of the ship's own turn rate, and no more - never a step back.
    expect(moved).toBeLessThan(OMEGA.y * dt * 1.5);
  });

  it("repays the attitude residual and lets go", () => {
    const b = new ExtrapolationBlender();
    const o = out();
    b.resolveFrame(1, NOSE, UP, OMEGA, 100, dt, o);
    const curve = turned(0.02);
    b.resolveFrame(1, curve, UP, OMEGA, 0, dt, o);
    const seeded = b.frameResidualOf(1)!;
    let previous = Math.hypot(seeded.x, seeded.y, seeded.z);
    expect(previous).toBeGreaterThan(0.05);
    for (let i = 0; i < 600; i++) {
      b.resolveFrame(1, curve, UP, OMEGA, 0, dt, o);
      const r = b.frameResidualOf(1);
      if (!r) break;
      const now = Math.hypot(r.x, r.y, r.z);
      expect(now).toBeLessThanOrEqual(previous + 1e-12); // monotone repayment
      previous = now;
    }
    expect(b.frameResidualOf(1)).toBeUndefined();
    // And once released the hull is drawn exactly on the curve again.
    b.resolveFrame(1, curve, UP, OMEGA, 0, dt, o);
    expect(angleBetween(o.nose, curve)).toBeLessThan(1e-9);
  });

  it("snaps rather than blending across a respawn-sized attitude change", () => {
    const b = new ExtrapolationBlender();
    const o = out();
    b.resolveFrame(1, NOSE, UP, OMEGA, 100, dt, o);
    // The ship reappears pointing the other way: sweeping the nose through that
    // arc would draw a rotation it never flew.
    const flipped = turned(2.5);
    const flippedUp = rotateByVector(UP, { x: 0, y: 2.5, z: 0 }, { x: 0, y: 0, z: 0 });
    b.resolveFrame(1, flipped, flippedUp, OMEGA, 0, dt, o);
    expect(b.frameResidualOf(1)).toBeUndefined();
    expect(o.nose).toEqual(flipped);
  });

  it("keeps ships independent and forgets the ones that leave", () => {
    const b = new ExtrapolationBlender();
    const o = out();
    b.resolveFrame(1, NOSE, UP, OMEGA, 100, dt, o);
    b.resolveFrame(2, NOSE, UP, OMEGA, 100, dt, o);
    const curve = turned(0.02);
    b.resolveFrame(1, curve, UP, OMEGA, 0, dt, o);
    b.resolveFrame(2, curve, UP, OMEGA, 0, dt, o);
    expect(b.frameResidualOf(1)).toBeDefined();
    b.retain(new Set([2]));
    expect(b.frameResidualOf(1)).toBeUndefined();
    expect(b.frameResidualOf(2)).toBeDefined();
    b.clear();
    expect(b.frameResidualOf(2)).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import {
  advanceFrame,
  bodyYawDelta,
  interpolateFrame,
  orthonormalizeUp,
  seedUp,
  transportUp,
  upFromAttitude,
  type FrameAttitude,
} from "./frame.js";
import { advanceAttitude, facingVec, wrapAngle, type Attitude } from "./math.js";

/**
 * Acceptance criteria of docs/HANDOFF-2026-07-30-FLIGHT-FRAME.md, stated as
 * tests on the frame integrator itself. The shipped interceptor regime is used
 * throughout: turnRate 3 rad/s, pitchRateMult 0.8, 30 Hz, free pitch.
 */

const DT = 1 / 30;
const TURN_RATE = 3;
const PITCH_RATE_MULT = 0.8;

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

function frame(heading = 0, pitch = 0): FrameAttitude {
  return { heading, pitch, up: seedUp(heading, pitch) };
}

function noseOf(f: { heading: number; pitch: number }): Vec3 {
  return facingVec(f.heading, f.pitch, { x: 0, y: 0, z: 0 });
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function len(a: Vec3): number {
  return Math.hypot(a.x, a.y, a.z);
}

/** Unsigned angle between two unit-ish vectors. */
function angleBetween(a: Vec3, b: Vec3): number {
  return Math.acos(Math.max(-1, Math.min(1, dot(a, b) / (len(a) * len(b)))));
}

function step(f: FrameAttitude, yaw: number, pitch: number): void {
  advanceFrame(f.heading, f.pitch, f.up, yaw, pitch, null, f);
}

describe("advanceFrame — the full-frame integrator", () => {
  it("criterion 1 (amended): full turn + full pitch flies a smooth cone — the near-pole spin trap cannot form", () => {
    // The confirmed reproduction in the handoff: under the nose-only
    // integration this exact input converged to pitch ~88.7° with heading
    // advancing 77° PER TICK — a stable attractor just below vertical.
    //
    // The handoff's criterion asked for this input to "cross both poles", but a
    // constant body-frame angular rate is CONING motion for any rigid body: the
    // nose traces a fixed tilted circle (max pitch atan-ish of the rate ratio,
    // ~40° for the shipped interceptor), the way a real aircraft holding
    // constant yaw+pitch rates does. Crossing the poles under this input would
    // itself be a frame error. What the criterion is really after — and what is
    // pinned here — is that the attractor is gone: pitch OSCILLATES through the
    // whole run instead of pinning near vertical, and the heading coordinate
    // never runs away (the old model advanced it 1.35 rad per tick).
    const yawStep = TURN_RATE * DT;
    const pitchStep = TURN_RATE * PITCH_RATE_MULT * DT;
    const f = frame(0, 0);
    let maxAbsPitch = 0;
    let zeroCrossings = 0;
    let prevSign = 0;
    let maxHeadingStep = 0;
    let prevHeading = f.heading;
    for (let i = 0; i < 3000; i++) {
      step(f, yawStep, pitchStep);
      maxAbsPitch = Math.max(maxAbsPitch, Math.abs(wrapAngle(f.pitch)));
      const sign = Math.sign(f.pitch);
      if (sign !== 0 && prevSign !== 0 && sign !== prevSign) zeroCrossings++;
      if (sign !== 0) prevSign = sign;
      maxHeadingStep = Math.max(maxHeadingStep, Math.abs(wrapAngle(f.heading - prevHeading)));
      prevHeading = f.heading;
    }
    // The cone: well past level, never trapped against vertical.
    expect(maxAbsPitch).toBeGreaterThan(0.5);
    expect(maxAbsPitch).toBeLessThan(Math.PI / 2);
    // Periodic motion, not an attractor (100 s of input, many revolutions).
    expect(zeroCrossings).toBeGreaterThan(10);
    // No heading-coordinate runaway: the old trap advanced 1.35 rad per tick.
    expect(maxHeadingStep).toBeLessThan(0.2);
  });

  it("criterion 2: per-tick frame rotation is bounded by the commanded yaw plus pitch", () => {
    const yawStep = TURN_RATE * DT;
    const pitchStep = TURN_RATE * PITCH_RATE_MULT * DT;
    const budget = yawStep + pitchStep + 1e-9;
    const f = frame(0.3, 0);
    for (let i = 0; i < 2000; i++) {
      const noseBefore = noseOf(f);
      const upBefore = { ...f.up };
      step(f, yawStep, pitchStep);
      expect(angleBetween(noseBefore, noseOf(f))).toBeLessThanOrEqual(budget);
      expect(angleBetween(upBefore, f.up)).toBeLessThanOrEqual(budget);
    }
  });

  it("criterion 3: pure body yaw preserves the persisted up exactly", () => {
    const f = frame(0.7, 1.2);
    const before = { ...f.up };
    for (let i = 0; i < 400; i++) step(f, TURN_RATE * DT, 0);
    expect(f.up.x).toBe(before.x);
    expect(f.up.y).toBe(before.y);
    expect(f.up.z).toBe(before.z);
  });

  it("criterion 3: pure pitch rotates nose and up together about the right axis, leaving W fixed", () => {
    const f = frame(0.7, 0.4);
    const n0 = noseOf(f);
    const u0 = { ...f.up };
    // W = N × U before...
    const w0 = {
      x: n0.y * u0.z - n0.z * u0.y,
      y: n0.z * u0.x - n0.x * u0.z,
      z: n0.x * u0.y - n0.y * u0.x,
    };
    for (let i = 0; i < 300; i++) step(f, 0, TURN_RATE * PITCH_RATE_MULT * DT);
    const n1 = noseOf(f);
    const u1 = f.up;
    const w1 = {
      x: n1.y * u1.z - n1.z * u1.y,
      y: n1.z * u1.x - n1.x * u1.z,
      z: n1.x * u1.y - n1.y * u1.x,
    };
    expect(angleBetween(w0, w1)).toBeLessThan(1e-6);
  });

  it("criterion 3: the frame stays unit-length and mutually orthogonal over a long mixed run", () => {
    const f = frame(0.2, 0);
    // A deterministic pseudo-random stick schedule with plenty of pole traffic.
    for (let i = 0; i < 20000; i++) {
      const yaw = Math.sin(i * 0.13) * TURN_RATE * DT;
      const pitch = Math.cos(i * 0.071) * TURN_RATE * PITCH_RATE_MULT * DT;
      step(f, yaw, pitch);
    }
    expect(len(f.up)).toBeCloseTo(1, 9);
    expect(Math.abs(dot(noseOf(f), f.up))).toBeLessThan(1e-9);
  });

  it("criterion 4: a pure-pitch full loop is continuous through the ±π wire crossing", () => {
    const pitchStep = TURN_RATE * PITCH_RATE_MULT * DT;
    const f = frame(0.3, 0);
    const ticks = Math.ceil((2 * Math.PI * 2) / pitchStep);
    let wraps = 0;
    let prevPitch = f.pitch;
    for (let i = 0; i < ticks; i++) {
      step(f, 0, pitchStep);
      expect(f.pitch).toBeGreaterThan(-Math.PI);
      expect(f.pitch).toBeLessThanOrEqual(Math.PI);
      const raw = f.pitch - prevPitch;
      // Every step is small once the wrap is accounted for.
      expect(Math.abs(wrapAngle(raw))).toBeLessThan(pitchStep * 1.5);
      if (raw < 0) wraps++;
      prevPitch = f.pitch;
    }
    expect(wraps).toBe(2);
    // Heading holds its spelling through both loops.
    expect(f.heading).toBeCloseTo(0.3, 9);
  });

  it("criterion 5: a body-yaw step at 80°/85°/89°/90°+ pitch moves the up vector by ~the commanded angle, not 30–90°", () => {
    // The handoff's measured defect: a 0.1 rad yaw step jumped the DERIVED up by
    // 29.5° at 80° pitch, 48.8° at 85°, 80.1° at 89° and exactly 90° at the
    // pole. The persisted frame moves it not at all (yaw is about the up).
    for (const deg of [80, 85, 89, 90, 91]) {
      const f = frame(0.7, (deg * Math.PI) / 180);
      const before = { ...f.up };
      step(f, 0.1, 0);
      // Tolerance is acos precision, not physics: the up is bit-identical
      // (yaw is ABOUT the up), and criterion 3 pins that exactly.
      expect(angleBetween(before, f.up)).toBeLessThan(1e-6);
    }
  });

  it("criterion 5: crossing 89°→91° under combined input keeps hull-frame motion continuous", () => {
    const yawStep = TURN_RATE * DT;
    const pitchStep = TURN_RATE * PITCH_RATE_MULT * DT;
    const budget = yawStep + pitchStep + 1e-9;
    const f = frame(0.2, (89 * Math.PI) / 180);
    for (let i = 0; i < 60; i++) {
      const noseBefore = noseOf(f);
      const upBefore = { ...f.up };
      step(f, yawStep, pitchStep);
      expect(angleBetween(noseBefore, noseOf(f))).toBeLessThanOrEqual(budget);
      expect(angleBetween(upBefore, f.up)).toBeLessThanOrEqual(budget);
    }
  });

  it("criterion 10: level flight is bit-identical to the nose-only integration", () => {
    const scratch: Attitude = { heading: 0, pitch: 0 };
    const f = frame(0.9, 0);
    let legacyHeading = 0.9;
    for (let i = 0; i < 500; i++) {
      advanceAttitude(legacyHeading, 0, TURN_RATE * DT, 0, null, scratch);
      legacyHeading = scratch.heading;
      step(f, TURN_RATE * DT, 0);
      expect(f.heading).toBe(legacyHeading);
      expect(f.pitch).toBe(0);
      expect(f.up).toEqual({ x: 0, y: 1, z: 0 });
    }
  });

  it("delegates to the legacy nose-only path when a pack authors the pitch clamp", () => {
    // Under the clamp the hull can never roll or invert (the pre-loop
    // contract), so the original integration is used bit-for-bit and the up is
    // simply the derived one.
    const scratch: Attitude = { heading: 0, pitch: 0 };
    const f = frame(0.4, 0.2);
    let h = 0.4;
    let p = 0.2;
    for (let i = 0; i < 300; i++) {
      advanceAttitude(h, p, 0.05, 0.03, 1.4, scratch);
      h = scratch.heading;
      p = scratch.pitch;
      advanceFrame(f.heading, f.pitch, f.up, 0.05, 0.03, 1.4, f);
      expect(f.heading).toBe(h);
      expect(f.pitch).toBe(p);
      const derived = upFromAttitude(h, p, { x: 0, y: 0, z: 0 });
      expect(f.up).toEqual(derived);
    }
    expect(p).toBe(1.4); // the clamp really pinned the nose
  });

  it("returns the state untouched for a zero-delta tick (the coasting exactness the sim relies on)", () => {
    const f = frame(1.1, 2.3);
    const up = { ...f.up };
    step(f, 0, 0);
    expect(f.heading).toBe(1.1);
    expect(f.pitch).toBe(2.3);
    expect(f.up).toEqual(up);
  });
});

describe("frame helpers", () => {
  it("seedUp/upFromAttitude give the roll-less up, orthonormal to the nose at any attitude", () => {
    for (const heading of [0, 0.7, -2.4, Math.PI]) {
      for (const pitch of [0, 1.2, -0.4, 2.8, -3.0]) {
        const up = seedUp(heading, pitch);
        expect(len(up)).toBeCloseTo(1, 12);
        expect(Math.abs(dot(noseOf({ heading, pitch }), up))).toBeLessThan(1e-12);
      }
    }
  });

  it("orthonormalizeUp squares a drifted up against the nose and falls back on degenerate input", () => {
    const up = { x: 0.1, y: 1.2, z: -0.05 };
    orthonormalizeUp(0.3, 0.2, up);
    expect(len(up)).toBeCloseTo(1, 12);
    expect(Math.abs(dot(noseOf({ heading: 0.3, pitch: 0.2 }), up))).toBeLessThan(1e-12);

    // Degenerate: an up parallel to the nose has no projection left; the
    // derived up is the deterministic fallback.
    const nose = noseOf({ heading: 0.3, pitch: 0.2 });
    const bad = { ...nose };
    orthonormalizeUp(0.3, 0.2, bad);
    expect(bad).toEqual(upFromAttitude(0.3, 0.2, { x: 0, y: 0, z: 0 }));
  });

  it("transportUp carries the up by the minimal nose rotation and is exact in both degenerate cases", () => {
    // Quarter-turn of the nose in the horizontal plane: the up (world Y here)
    // is on the rotation axis and must not move.
    const up = { x: 0, y: 1, z: 0 };
    transportUp({ x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, up);
    expect(up.x).toBeCloseTo(0, 12);
    expect(up.y).toBeCloseTo(1, 12);
    expect(up.z).toBeCloseTo(0, 12);

    // Nose pitching up 90°: the up tips over with it.
    const up2 = { x: 0, y: 1, z: 0 };
    transportUp({ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, up2);
    expect(up2.x).toBeCloseTo(-1, 12);
    expect(up2.y).toBeCloseTo(0, 12);
    expect(up2.z).toBeCloseTo(0, 12);

    // Parallel noses: identity. Antiparallel: π about the up, up unchanged.
    const up3 = { x: 0, y: 1, z: 0 };
    transportUp({ x: 1, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, up3);
    expect(up3).toEqual({ x: 0, y: 1, z: 0 });
    transportUp({ x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }, up3);
    expect(up3).toEqual({ x: 0, y: 1, z: 0 });
  });

  it("interpolateFrame blends nose and up as one rotation and re-squares the result", () => {
    const a = frame(0.2, 1.4);
    const b = frame(0.2, 1.7); // past vertical: the heading SPELLING flips by π
    const out: FrameAttitude = { heading: 0, pitch: 0, up: { x: 0, y: 0, z: 0 } };
    interpolateFrame(a.heading, a.pitch, a.up, b.heading, b.pitch, b.up, 0.5, out);
    // The blended nose bisects the two samples...
    const n = noseOf(out);
    expect(angleBetween(n, noseOf(a))).toBeCloseTo(angleBetween(n, noseOf(b)), 6);
    // ...the frame is orthonormal...
    expect(len(out.up)).toBeCloseTo(1, 9);
    expect(Math.abs(dot(n, out.up))).toBeLessThan(1e-9);
    // ...and the pitch spelling is continuous with the short-way blend.
    expect(out.pitch).toBeCloseTo(1.55, 3);
  });

  it("interpolateFrame at the endpoints reproduces the samples", () => {
    const a = frame(-2.9, 0.4);
    const b = frame(3.0, 0.6);
    const out: FrameAttitude = { heading: 0, pitch: 0, up: { x: 0, y: 0, z: 0 } };
    interpolateFrame(a.heading, a.pitch, a.up, b.heading, b.pitch, b.up, 0, out);
    expect(out.heading).toBeCloseTo(a.heading, 9);
    expect(out.pitch).toBeCloseTo(a.pitch, 9);
    interpolateFrame(a.heading, a.pitch, a.up, b.heading, b.pitch, b.up, 1, out);
    expect(out.heading).toBeCloseTo(b.heading, 9);
    expect(out.pitch).toBeCloseTo(b.pitch, 9);
  });

  it("bodyYawDelta measures the signed yaw about the ship's own up — bounded at every attitude (criterion 7's basis)", () => {
    // Level: equals the heading delta exactly.
    const f0 = frame(0.7, 0);
    expect(bodyYawDelta(0.7, 0, f0.up, 0.8, 0)).toBeCloseTo(0.1, 9);
    // Steep pitch: one yaw step reads as one yaw step, even though the heading
    // COORDINATE moved by ψ / cos(p) — the unbounded rate that used to spike
    // the cosmetic bank near the pole.
    const steep = frame(0.7, 1.53);
    const next: FrameAttitude = { heading: 0, pitch: 0, up: { x: 0, y: 0, z: 0 } };
    advanceFrame(steep.heading, steep.pitch, steep.up, 0.1, 0, null, next);
    expect(Math.abs(next.heading - steep.heading)).toBeGreaterThan(0.5); // the coordinate raced
    expect(bodyYawDelta(steep.heading, steep.pitch, steep.up, next.heading, next.pitch)).toBeCloseTo(0.1, 6);
    // Sign flips with direction.
    expect(bodyYawDelta(0.7, 0, f0.up, 0.6, 0)).toBeCloseTo(-0.1, 9);
  });
});

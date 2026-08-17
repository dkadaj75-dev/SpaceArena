import { describe, expect, it } from "vitest";
import { GameLoop, type ShipSnapshot, type Snapshot } from "@space-arena/shared";
import { bracket } from "./interpolation.js";
import { interpolate } from "./NetGameSession.js";

/**
 * **Render-time smoothness of the ONLINE pipeline (2026-08-17).**
 *
 * The owner reported online movement as jerky long after reconciliation had been
 * proved clean, and `onlineLoop.test.ts` could not see it: that suite measures
 * SIM-STATE correctness (does the predictor track the server), which was never
 * the problem. The judder lived one layer up, in the composition of the two
 * interpolation stages the drawn frame actually goes through:
 *
 *   1. the session resamples its snapshot buffer at `now - renderDelay`, and
 *   2. `main.ts` blends the resulting `prev`/`cur` pair with an alpha.
 *
 * Stage 1 used to run from `GameSession.tick`, i.e. on the fixed-step GameLoop,
 * so the pair's endpoints were the WALL-CLOCK instants the tick callback fired
 * at, while the alpha blending them was the fixed-step ACCUMULATOR's phase. Two
 * clocks. They agree exactly on a metronome-steady frame time — which is why
 * every headless test and every "is the interpolation right?" reading of the
 * code came back clean — and diverge by the frame-pacing error otherwise.
 *
 * These tests therefore sample the pipeline the way an eye does: at DISPLAY
 * frames, with the frame times a browser really produces (jitter plus the odd
 * hitch), and assert on the rendered SPEED — the derivative, where judder lives
 * and where position-space assertions see nothing.
 */

const REMOTE_ID = 2;
const LOCAL_ID = 1;
/** Server patch interval (ArenaRoom PATCH_RATE_MS). */
const PATCH_MS = 50;
const RENDER_DELAY_MS = 100; // tuning.netRenderDelayMs
const FRAME_MS = 1000 / 60;

/** A remote ship on a constant-speed circle: curvature, so lerp cannot cheat. */
const RADIUS = 120;
const OMEGA = 0.8; // rad/s → 96 u/s, a normal interceptor cruise
function truePos(ms: number): { x: number; y: number; z: number } {
  const a = (OMEGA * ms) / 1000;
  return { x: RADIUS * Math.cos(a), y: 0, z: RADIUS * Math.sin(a) };
}
const TRUE_SPEED = RADIUS * OMEGA;

function ship(id: number, pos: { x: number; y: number; z: number }): ShipSnapshot {
  // Only the fields the interpolator and these assertions touch are meaningful;
  // the snapshot shape is large and the rest would be noise.
  return {
    id,
    team: 0,
    pos,
    heading: 0,
    pitch: 0,
    up: { x: 0, y: 1, z: 0 },
    hull: 100,
    hullMax: 100,
    targetId: null,
    throttle: 1,
    lockProgress: 0,
    locked: false,
    modules: [],
  };
}

function snapshotAt(simMs: number): Snapshot {
  return {
    tick: Math.round(simMs / PATCH_MS),
    elapsed: simMs / 1000,
    phase: "live",
    teamScores: [],
    countdownRemaining: 0,
    winnerTeam: null,
    ships: [ship(LOCAL_ID, { x: 0, y: 0, z: 0 }), ship(REMOTE_ID, truePos(simMs))],
    asteroids: [],
    projectiles: [],
    decoys: [],
    flags: [],
  };
}

/** The client's buffer: patches at a steady cadence, so only frame pacing varies. */
function buildBuffer(durationMs: number): { time: number; snapshot: Snapshot }[] {
  const out: { time: number; snapshot: Snapshot }[] = [];
  for (let t = 0; t <= durationMs; t += PATCH_MS) out.push({ time: t, snapshot: snapshotAt(t) });
  return out;
}

/** One resample of the buffer at wall-clock `now` — exactly what `renderAt` does. */
function sample(buffer: { time: number; snapshot: Snapshot }[], now: number): Snapshot {
  const b = bracket(buffer, now - RENDER_DELAY_MS);
  if (!b) throw new Error("empty buffer");
  const [a, z, t] = b;
  const ia = buffer.indexOf(a);
  const iz = buffer.indexOf(z);
  return interpolate(
    a,
    z,
    t,
    ia > 0 ? buffer[ia - 1]! : null,
    iz >= 0 && iz + 1 < buffer.length ? buffer[iz + 1]! : null,
    LOCAL_ID,
  );
}

/** Browser-ish frame times: vsync jitter, plus a periodic hitch (GC, texture upload). */
function frameTimes(count: number, jitter: number): number[] {
  let seed = 1;
  const rnd = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    out.push(i > 0 && i % 97 === 0 ? 80 : FRAME_MS * (1 + (rnd() - 0.5) * 2 * jitter));
  }
  return out;
}

interface Drawn {
  atMs: number;
  x: number;
  z: number;
}

/**
 * Drive the real {@link GameLoop} through `dts` and collect the REMOTE ship's
 * drawn position each frame.
 *
 * `mode: "fixed-step"` reproduces the shipped-until-now wiring (resample inside
 * the fixed tick, blend with `loop.alpha`); `mode: "render"` is the fix
 * (resample in `sampleForRender`, alpha 1). Everything else — the buffer, the
 * bracket, the Hermite curve, the loop — is the production code.
 */
function drawFrames(
  buffer: { time: number; snapshot: Snapshot }[],
  dts: number[],
  mode: "fixed-step" | "render",
): Drawn[] {
  let now = 0;
  let cur = sample(buffer, now);
  let prev = cur;
  const loop = new GameLoop(
    () => {
      if (mode !== "fixed-step") return;
      prev = cur;
      cur = sample(buffer, now);
    },
    { maxTicksPerStep: 5 },
  );
  const drawn: Drawn[] = [];
  for (const dt of dts) {
    now += dt;
    loop.step(dt);
    let alpha = loop.alpha;
    if (mode === "render") {
      prev = cur;
      cur = sample(buffer, now);
      alpha = 1;
    }
    const p = prev.ships.find((s) => s.id === REMOTE_ID)!;
    const c = cur.ships.find((s) => s.id === REMOTE_ID)!;
    drawn.push({
      atMs: now,
      x: p.pos.x + (c.pos.x - p.pos.x) * alpha,
      z: p.pos.z + (c.pos.z - p.pos.z) * alpha,
    });
  }
  return drawn;
}

/**
 * Worst per-frame rendered speed as a fraction of the ship's true speed. A
 * perfectly paced pipeline draws 1.0 every frame no matter the frame times; the
 * eye reads any excursion from it as the hull surging and stalling.
 */
function speedSpread(drawn: Drawn[]): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  // Skip the buffer-warmup frames, where `renderTime` is still before the first
  // sample and the bracket legitimately clamps.
  for (let i = 1; i < drawn.length; i++) {
    const a = drawn[i - 1]!;
    const b = drawn[i]!;
    const dtSec = (b.atMs - a.atMs) / 1000;
    if (a.atMs < RENDER_DELAY_MS + PATCH_MS) continue;
    const v = Math.hypot(b.x - a.x, b.z - a.z) / dtSec / TRUE_SPEED;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}

describe("online render pacing", () => {
  const buffer = buildBuffer(8000);
  const dts = frameTimes(420, 0.15);

  it("draws a constant-speed remote ship at a constant speed under real frame jitter", () => {
    const spread = speedSpread(drawFrames(buffer, dts, "render"));
    // Measures 0.9998–1.0001: all that is left is the Hermite curve's chord
    // approximation of a circle over one 50 ms patch. The bound is loose enough
    // that a tangent/clamp change can move within it, tight enough that any
    // return of a pacing term (which is a tens-of-percent effect) trips it.
    expect(spread.min).toBeGreaterThan(0.97);
    expect(spread.max).toBeLessThan(1.03);
  });

  it("CHARACTERIZES the fixed-step sampling this replaced: a >30% frame-rate speed wobble", () => {
    // Guard rail, not a target: if a future change puts the online session back
    // on the fixed-step clock, this is what comes back with it — measured 0x to
    // 1.53x the true speed, i.e. frames that draw NO motion at all next to
    // frames that draw half again too much.
    const spread = speedSpread(drawFrames(buffer, dts, "fixed-step"));
    expect(spread.max).toBeGreaterThan(1.3);
    expect(spread.min).toBeLessThan(0.7);
  });

  it("keeps every frame moving through a hitch instead of stalling then double-stepping", () => {
    // Two fixed ticks caught in one `step()` used to collapse `prev` and `cur`
    // onto the same instant, so the frame drew no motion at all and the next
    // drew two frames' worth.
    const drawn = drawFrames(buffer, dts, "render");
    let stalled = 0;
    for (let i = 1; i < drawn.length; i++) {
      const a = drawn[i - 1]!;
      const b = drawn[i]!;
      if (a.atMs < RENDER_DELAY_MS + PATCH_MS) continue;
      if (Math.hypot(b.x - a.x, b.z - a.z) < TRUE_SPEED * ((b.atMs - a.atMs) / 1000) * 0.5) stalled++;
    }
    expect(stalled).toBe(0);
    expect(drawn.length).toBeGreaterThan(400);
  });

  it("advances the match clock with the frame, not in server-patch steps", () => {
    // `elapsed` poses asteroid spin and decoy tumble directly, and is the
    // denominator of the bank-roll and speed-readout rates. Copying it verbatim
    // off the newer sample left it constant across a patch and then stepping.
    const a = sample(buffer, 1000);
    const b = sample(buffer, 1000 + FRAME_MS);
    expect(b.elapsed).toBeGreaterThan(a.elapsed);
    // One frame of match time, to the millisecond — not zero, and not 50 ms.
    expect(b.elapsed - a.elapsed).toBeCloseTo(FRAME_MS / 1000, 4);
  });
});

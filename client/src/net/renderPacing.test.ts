import { describe, expect, it } from "vitest";
import { GameLoop, type ShipSnapshot, type Snapshot } from "@space-arena/shared";
import { bracket, createSnapshotClock, stampSnapshot } from "./interpolation.js";
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

/**
 * **The server does not sample the world every 50 ms (2026-08-18).**
 *
 * Everything above models a patch as carrying the world AT the instant it was
 * broadcast. `ArenaRoom` does not work that way, and the difference is the jank
 * the owner kept reporting after all of the above shipped:
 *
 *   - `setSimulationInterval(..., 1000 / SIM_TICK_RATE)` steps the sim at 30 Hz;
 *   - `setPatchRate(PATCH_RATE_MS)` broadcasts at 20 Hz.
 *
 * Two independent timers. A patch therefore carries whichever sim tick was most
 * recent when it fired, so consecutive patches are ONE tick apart (33.3 ms of
 * simulated travel) and then TWO (66.7 ms), alternating, forever — while
 * arriving a uniform 50 ms apart. Filing them under their ARRIVAL time plays
 * 66.7 ms of travel back over 50 ms and then 33.3 over 50: every remote hull in
 * the arena surges to 1.33x and stalls to 0.67x, ten times a second, on a
 * perfect network, at any frame rate, with a full buffer.
 *
 * No amount of buffer depth, C1 curve fitting or render-delay adaptation can
 * touch it, because all three faithfully interpolate a timeline that is itself
 * wrong. `stampSnapshot` files each sample under the SERVER clock it was taken
 * at (`matchTimer`, already on the wire) instead.
 */
describe("online pacing against the room's REAL tick/patch cadence", () => {
  const TICK_MS = 1000 / 30; // ArenaRoom: SIM_TICK_RATE
  /** The world sample a patch broadcast at `patchMs` actually carries. */
  const tickBefore = (patchMs: number): number => Math.floor(patchMs / TICK_MS) * TICK_MS;

  function buildRealBuffer(durationMs: number, stamping: "arrival" | "server"): { time: number; snapshot: Snapshot }[] {
    const clock = createSnapshotClock();
    const out: { time: number; snapshot: Snapshot }[] = [];
    for (let patch = 0; patch <= durationMs; patch += PATCH_MS) {
      const snapshot = snapshotAt(tickBefore(patch));
      const time = stamping === "arrival" ? patch : stampSnapshot(clock, snapshot.elapsed * 1000, patch).timeMs;
      out.push({ time, snapshot });
    }
    return out;
  }

  const dts = frameTimes(420, 0.15);

  it("CHARACTERIZES arrival-time stamping: a 2:1 speed sawtooth on a perfect network", () => {
    // Guard rail. These frame times have only ±15% jitter and the buffer never
    // starves — every millisecond of this spread is the tick/patch beat being
    // replayed on the wrong clock.
    const spread = speedSpread(drawFrames(buildRealBuffer(8000, "arrival"), dts, "render"));
    // Measures 0.667x-1.485x here: the 2:1 beat itself, plus what frame jitter
    // compounds on top of it.
    expect(spread.max).toBeGreaterThan(1.25);
    expect(spread.min).toBeLessThan(0.8);
  });

  it("draws the same ship at a constant speed once samples are stamped with the server clock", () => {
    const spread = speedSpread(drawFrames(buildRealBuffer(8000, "server"), dts, "render"));
    // Same bound as the idealised-cadence test above: all that is left is the
    // Hermite curve's chord approximation of a circle.
    expect(spread.min).toBeGreaterThan(0.97);
    expect(spread.max).toBeLessThan(1.03);
  });
});

describe("interpolating the entity kinds that used to step at the patch rate", () => {
  const t = 0.5;
  const pair = (from: Snapshot, to: Snapshot): Snapshot =>
    interpolate({ time: 0, snapshot: from }, { time: PATCH_MS, snapshot: to }, t, null, null, LOCAL_ID);

  const withExtras = (x: number): Snapshot => ({
    ...snapshotAt(0),
    projectiles: [{ id: 9, kind: "missile", pos: { x, y: 0, z: 0 }, heading: 0 }],
    decoys: [{ id: 8, team: 0, pos: { x, y: 0, z: 0 }, radius: 1, lifeFraction: 0.5 }],
    flags: [
      {
        id: 7,
        team: 1,
        state: "carried",
        carrierId: LOCAL_ID,
        pos: { x, y: 0, z: 0 },
        home: { x: 0, y: 0, z: 0 },
        baseRadius: 5,
        dropRemaining: 0,
        trail: [],
      },
    ],
  });

  it("moves missiles, decoys and carried flags between patches", () => {
    // Online the renderer is handed `alpha = 1` (the session has already resampled
    // for this frame), so anything left un-interpolated here is drawn at the raw
    // 20 Hz patch rate while every hull around it moves smoothly. Missiles were
    // the loudest: `EntityView.syncProjectiles` poses one along its frame-to-frame
    // displacement, which read zero on most frames and a whole patch-step on the
    // rest, flipping the nose between two different poses several times a second.
    const mid = pair(withExtras(0), withExtras(10));
    expect(mid.projectiles[0]!.pos.x).toBeCloseTo(5, 6);
    expect(mid.decoys[0]!.pos.x).toBeCloseTo(5, 6);
    expect(mid.flags[0]!.pos.x).toBeCloseTo(5, 6);
    // Everything else still comes off the newer sample verbatim.
    expect(mid.flags[0]!.state).toBe("carried");
    expect(mid.projectiles[0]!.kind).toBe("missile");
  });

  it("passes a shot launched inside the segment through untouched", () => {
    const spawned = pair(snapshotAt(0), withExtras(10));
    expect(spawned.projectiles[0]!.pos.x).toBe(10);
  });

  it("does not clone remote ships' modules on every drawn frame", () => {
    // The local ship's modules ARE cloned: `applyPendingToggles` writes the
    // optimistic deploy state onto them, and must not reach into the buffer.
    const mod = { hardpointIndex: 0, moduleId: "m", state: "retracted" as const, rounds: 0, heat: 0, heatCapacity: 1, energy: 0, energyCapacity: 1, stateTimer: 0, cycleTimer: 0, channeling: false, shieldPool: 0 };
    const base = snapshotAt(0);
    const armed: Snapshot = {
      ...base,
      ships: base.ships.map((s) => ({ ...s, modules: [{ ...mod }] })),
    };
    const out = interpolate({ time: 0, snapshot: armed }, { time: PATCH_MS, snapshot: armed }, t, null, null, LOCAL_ID);
    const remote = armed.ships.find((s) => s.id === REMOTE_ID)!;
    expect(out.ships.find((s) => s.id === REMOTE_ID)!.modules[0]).toBe(remote.modules[0]);
    const local = armed.ships.find((s) => s.id === LOCAL_ID)!;
    expect(out.ships.find((s) => s.id === LOCAL_ID)!.modules[0]).not.toBe(local.modules[0]);
  });
});

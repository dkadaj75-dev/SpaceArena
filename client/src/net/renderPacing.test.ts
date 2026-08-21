import { describe, expect, it } from "vitest";
import { GameLoop, type ShipSnapshot, type Snapshot } from "@space-arena/shared";
import { bracket, createSnapshotClock, ExtrapolationBlender, MAX_EXTRAPOLATION_MS, stampSnapshot } from "./interpolation.js";
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
/** ArenaRoom SIM_TICK_RATE. */
const TICK_MS = 1000 / 30;
/**
 * The room's patch interval: `PATCH_EVERY_TICKS` (2) sim ticks, broadcast from
 * the sim loop itself. Uniform 66.7 ms, every patch carrying a fresh tick.
 */
const PATCH_MS = 2 * TICK_MS;
/**
 * The 20 Hz free-running patch timer this replaced. Kept as a constant because
 * the characterization tests at the bottom of this file still model it — that is
 * what makes them guard rails rather than folklore.
 */
const LEGACY_PATCH_MS = 50;
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

/** True velocity (units/second) of the circling ship at `ms` — what the wire carries. */
function trueVel(ms: number): { x: number; y: number; z: number } {
  const a = (OMEGA * ms) / 1000;
  return { x: -RADIUS * OMEGA * Math.sin(a), y: 0, z: RADIUS * OMEGA * Math.cos(a) };
}

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
 * **The server used not to sample the world on the beat it broadcast (2026-08-18).**
 *
 * Everything above models a patch as carrying the world AT the instant it was
 * broadcast. `ArenaRoom` did not work that way, and the difference is the jank
 * the owner kept reporting after all of the above shipped:
 *
 *   - `setSimulationInterval(..., 1000 / SIM_TICK_RATE)` stepped the sim at 30 Hz;
 *   - `setPatchRate(50)` broadcast from an INDEPENDENT 20 Hz timer.
 *
 * Two unsynchronised timers. A patch therefore carried whichever sim tick was
 * most recent when it fired, so consecutive patches were ONE tick apart (33.3 ms
 * of simulated travel) and then TWO (66.7 ms), alternating, forever — while
 * arriving a uniform 50 ms apart. Filing them under their ARRIVAL time plays
 * 66.7 ms of travel back over 50 ms and then 33.3 over 50: every remote hull in
 * the arena surges to 1.33x and stalls to 0.67x, ten times a second, on a
 * perfect network, at any frame rate, with a full buffer.
 *
 * No amount of buffer depth, C1 curve fitting or render-delay adaptation could
 * touch it, because all three faithfully interpolate a timeline that is itself
 * wrong. Two fixes landed, and they are independent:
 *
 *  1. `stampSnapshot` files each sample under the SERVER clock it was taken at
 *     (`matchTimer`, already on the wire), which repairs the TIMELINE for any
 *     cadence at all — including the ones a host's timer slip still produces.
 *  2. the room now broadcasts from the sim loop, phase-locked every 2 ticks, so
 *     the alternating cadence does not happen in the first place and every patch
 *     carries a world the client has not already been shown.
 *
 * Both are asserted below, the old cadence as a characterization guard rail.
 */
describe("online pacing against the room's REAL tick/patch cadence", () => {
  /** The world sample a patch broadcast at `patchMs` carries, under a free timer. */
  const tickBefore = (patchMs: number): number => Math.floor(patchMs / TICK_MS) * TICK_MS;

  function buildLegacyBuffer(durationMs: number, stamping: "arrival" | "server"): { time: number; snapshot: Snapshot }[] {
    const clock = createSnapshotClock();
    const out: { time: number; snapshot: Snapshot }[] = [];
    for (let patch = 0; patch <= durationMs; patch += LEGACY_PATCH_MS) {
      const snapshot = snapshotAt(tickBefore(patch));
      const time = stamping === "arrival" ? patch : stampSnapshot(clock, snapshot.elapsed * 1000, patch).timeMs;
      out.push({ time, snapshot });
    }
    return out;
  }

  /** The room as it is now: a patch every 2 sim ticks, straight from the loop. */
  function buildPhaseLockedBuffer(durationMs: number, stamping: "arrival" | "server"): { time: number; snapshot: Snapshot }[] {
    const clock = createSnapshotClock();
    const out: { time: number; snapshot: Snapshot }[] = [];
    for (let tick = 0; tick * TICK_MS <= durationMs; tick += 2) {
      const simMs = tick * TICK_MS;
      const snapshot = snapshotAt(simMs);
      const time = stamping === "arrival" ? simMs : stampSnapshot(clock, snapshot.elapsed * 1000, simMs).timeMs;
      out.push({ time, snapshot });
    }
    return out;
  }

  const dts = frameTimes(420, 0.15);

  it("CHARACTERIZES the old free-running 20 Hz timer: a 2:1 speed sawtooth on a perfect network", () => {
    // Guard rail. These frame times have only ±15% jitter and the buffer never
    // starves — every millisecond of this spread is the tick/patch beat being
    // replayed on the wrong clock.
    const spread = speedSpread(drawFrames(buildLegacyBuffer(8000, "arrival"), dts, "render"));
    // Measures 0.667x-1.485x here: the 2:1 beat itself, plus what frame jitter
    // compounds on top of it.
    expect(spread.max).toBeGreaterThan(1.25);
    expect(spread.min).toBeLessThan(0.8);
  });

  it("draws the same ship at a constant speed once samples are stamped with the server clock", () => {
    const spread = speedSpread(drawFrames(buildLegacyBuffer(8000, "server"), dts, "render"));
    // Same bound as the idealised-cadence test above: all that is left is the
    // Hermite curve's chord approximation of a circle.
    expect(spread.min).toBeGreaterThan(0.97);
    expect(spread.max).toBeLessThan(1.03);
  });

  it("phase-locks every patch onto a fresh sim tick, so the sample spacing is UNIFORM", () => {
    // The room-side half of the fix, stated as the property it buys: consecutive
    // patches are exactly 2 ticks of simulated travel apart. Under the old timer
    // this alternated 1, 2, 1, 2 — which is what halved the effective sample
    // rate of a remote hull's motion on every other patch, whatever the client
    // then did with the timestamps.
    const buf = buildPhaseLockedBuffer(2000, "arrival");
    const steps = buf.slice(1).map((s, i) => s.snapshot.elapsed - buf[i]!.snapshot.elapsed);
    for (const step of steps) expect(step).toBeCloseTo((2 * TICK_MS) / 1000, 12);
    expect(new Set(steps.map((s) => s.toFixed(9))).size).toBe(1);
  });

  it("is smooth under BOTH stampings once phase-locked — the timeline is no longer skewed", () => {
    // With sampling and broadcast on the same beat, arrival time and server time
    // describe the same spacing, so the arrival-stamped buffer is now as smooth
    // as the server-stamped one. That is the point: the client's clock work is
    // no longer compensating for a systematic server-side error, and is free to
    // spend its authority on the jitter it was written for.
    for (const stamping of ["arrival", "server"] as const) {
      const spread = speedSpread(drawFrames(buildPhaseLockedBuffer(8000, stamping), dts, "render"));
      expect(spread.min, stamping).toBeGreaterThan(0.97);
      expect(spread.max, stamping).toBeLessThan(1.03);
    }
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

  it("carries the replicated velocity through to the drawn frame", () => {
    // The Hermite tangents and the HUD speed readout both read `velocity` off
    // the frame `interpolate` produces, so it has to survive the blend.
    const withVel = (ms: number): Snapshot => {
      const s = snapshotAt(ms);
      return { ...s, ships: s.ships.map((x) => ({ ...x, velocity: trueVel(ms) })) };
    };
    const mid = interpolate({ time: 0, snapshot: withVel(0) }, { time: PATCH_MS, snapshot: withVel(PATCH_MS) }, 0.5, null, null, LOCAL_ID);
    expect(mid.ships[0]!.velocity).toEqual(trueVel(PATCH_MS));
  });

  it("does not clone remote ships' modules on every drawn frame", () => {
    // The local ship's modules ARE cloned: `applyPendingToggles` writes the
    // optimistic deploy state onto them, and must not reach into the buffer.
    const mod = { hardpointIndex: 0, moduleId: "m", state: "retracted" as const, rounds: 0, energy: 0, energyCapacity: 1, stateTimer: 0, cycleTimer: 0, channeling: false, shieldPool: 0 };
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

/**
 * **A starved buffer no longer freezes the arena (2026-08-18).**
 *
 * `adaptiveRenderDelay` exists to keep the bracket wet, and it cannot always
 * win: one dropped patch, a Wi-Fi power-save burst, a GC pause on the host, and
 * the render point overruns the newest sample. Until now that meant every remote
 * hull stopped dead until the next patch shoved it forward.
 *
 * With velocity on the wire the client can do better, and the constraint on
 * "better" is absolute: it must NEVER rewind. This suite drives the real
 * `bracket` + `interpolate` + `ExtrapolationBlender` through a real starve and
 * asserts both halves — the ship keeps moving through the gap, and its drawn
 * position never once steps backward along its path, including on the frame the
 * fresh patch lands.
 */
describe("bounded dead reckoning through a starved buffer", () => {
  /** A buffer that stops being fed at `starveAtMs`, carrying true velocities. */
  function buildBufferWithVelocity(durationMs: number): { time: number; snapshot: Snapshot }[] {
    const out: { time: number; snapshot: Snapshot }[] = [];
    for (let t = 0; t <= durationMs; t += PATCH_MS) {
      const base = snapshotAt(t);
      out.push({
        time: t,
        snapshot: { ...base, ships: base.ships.map((s) => ({ ...s, velocity: s.id === REMOTE_ID ? trueVel(t) : { x: 0, y: 0, z: 0 } })) },
      });
    }
    return out;
  }

  /**
   * Draw the remote ship every 16.67 ms across a window in which the buffer is
   * frozen for `starveMs` and then catches up — the real render path, with the
   * session's own blender.
   */
  function drawThroughStarve(starveMs: number): { atMs: number; pos: { x: number; y: number; z: number } }[] {
    const full = buildBufferWithVelocity(4000);
    const blender = new ExtrapolationBlender();
    const drawn: { atMs: number; pos: { x: number; y: number; z: number } }[] = [];
    const STARVE_AT = 1500;
    let lastNow = 1000;
    for (let now = 1000; now <= 2600; now += FRAME_MS) {
      // The buffer the client HAS at this instant: everything that had arrived
      // by `now`, minus whatever the starve window swallowed.
      const cutoff = now > STARVE_AT && now < STARVE_AT + starveMs ? STARVE_AT : now;
      const buffer = full.filter((s) => s.time <= cutoff);
      const b = bracket(buffer, now - RENDER_DELAY_MS);
      if (!b) continue;
      const [a, z, t, leadMs] = b;
      const ia = buffer.indexOf(a);
      const iz = buffer.indexOf(z);
      const frame = interpolate(
        a,
        z,
        t,
        ia > 0 ? buffer[ia - 1]! : null,
        iz >= 0 && iz + 1 < buffer.length ? buffer[iz + 1]! : null,
        LOCAL_ID,
        { blender, leadMs, dtSeconds: (now - lastNow) / 1000 },
      );
      lastNow = now;
      drawn.push({ atMs: now, pos: frame.ships.find((s) => s.id === REMOTE_ID)!.pos });
    }
    return drawn;
  }

  /** Progress along the circle, unwrapped — the quantity that must never decrease. */
  function arcLength(drawn: { pos: { x: number; y: number; z: number } }[]): number[] {
    const out: number[] = [];
    let total = 0;
    let prevAngle = Math.atan2(drawn[0]!.pos.z, drawn[0]!.pos.x);
    for (const d of drawn) {
      const angle = Math.atan2(d.pos.z, d.pos.x);
      let step = angle - prevAngle;
      if (step > Math.PI) step -= Math.PI * 2;
      if (step < -Math.PI) step += Math.PI * 2;
      total += step * RADIUS;
      prevAngle = angle;
      out.push(total);
    }
    return out;
  }

  /** Frames that drew less than a third of the true travel — i.e. froze. */
  function stalledFrames(drawn: { pos: { x: number; y: number; z: number } }[]): number {
    const s = arcLength(drawn);
    let stalled = 0;
    for (let i = 1; i < s.length; i++) {
      if (s[i]! - s[i - 1]! < TRUE_SPEED * (FRAME_MS / 1000) * 0.33) stalled++;
    }
    return stalled;
  }

  it("keeps the hull moving through a starve INSIDE the extrapolation budget", () => {
    // A 150 ms gap between patches overruns the 100 ms render delay by ~83 ms,
    // which the 100 ms budget covers entirely: not one frame freezes, where
    // every frame past the overrun used to.
    expect(stalledFrames(drawThroughStarve(150))).toBe(0);
    expect(drawThroughStarve(0).length).toBe(drawThroughStarve(150).length);
  });

  it("degrades to the old freeze past the budget rather than guessing further", () => {
    // The bound is the whole point (see MAX_EXTRAPOLATION_MS): a long outage
    // must not have the client inventing a second of flight. Past 100 ms of
    // overrun the hull parks, exactly as it always did — just 100 ms of real
    // travel further along, and without a rewind when the patch finally lands.
    expect(stalledFrames(drawThroughStarve(900))).toBeGreaterThan(0);
    // Still strictly better than freezing at the overrun: the long starve draws
    // fewer frozen frames than the whole dry window is long.
    expect(stalledFrames(drawThroughStarve(900))).toBeLessThan(
      Math.round((900 - RENDER_DELAY_MS) / FRAME_MS),
    );
  });

  it("NEVER draws the hull backward, including on the frame the patch lands", () => {
    for (const starveMs of [80, 150, 200, 400, 900]) {
      const arc = arcLength(drawThroughStarve(starveMs));
      for (let i = 1; i < arc.length; i++) {
        expect(arc[i]! - arc[i - 1]!, `starve ${starveMs}ms, frame ${i}`).toBeGreaterThanOrEqual(-1e-9);
      }
    }
  });

  it("saturates the guess and rejoins the true path once the buffer refills", () => {
    const starved = drawThroughStarve(200);
    const truth = drawThroughStarve(0);
    const last = starved.length - 1;
    // By the end of the window the residual has been repaid and the two runs
    // agree — the extrapolation is a transient, not a permanent lead.
    expect(Math.hypot(
      starved[last]!.pos.x - truth[last]!.pos.x,
      starved[last]!.pos.z - truth[last]!.pos.z,
    )).toBeLessThan(0.5);
    // And the excursion during the starve was bounded: one patch gap of travel
    // (~6.4 units at this speed) plus the curve's own slack, never unbounded.
    let maxLead = 0;
    for (let i = 0; i < starved.length; i++) {
      maxLead = Math.max(maxLead, Math.hypot(
        starved[i]!.pos.x - truth[i]!.pos.x,
        starved[i]!.pos.z - truth[i]!.pos.z,
      ));
    }
    expect(maxLead).toBeLessThan(TRUE_SPEED * (MAX_EXTRAPOLATION_MS / 1000) * 1.5);
  });
});

/**
 * **The nose has to survive a starve too (2026-08-21).**
 *
 * Bounded dead reckoning shipped for POSITION only, so a starved buffer drew a
 * hull that kept flying with a frozen nose and then snapped to a new attitude
 * when the patch landed. That is not a smaller version of the freeze it fixed —
 * it is a different lie, and a worse one for the pilot shooting at it: a hull
 * sliding with a fixed nose reads as a ship that stopped steering.
 *
 * Same harness as the position suite above, with the ship's attitude tracking
 * its own turn, driving the REAL `bracket` + `interpolate` + blender.
 */
describe("bounded dead reckoning of the ATTITUDE through a starved buffer", () => {
  /** Heading of a hull yawing with the circle it is flying. */
  const trueHeading = (ms: number): number => (OMEGA * ms) / 1000;

  function turningBuffer(durationMs: number): { time: number; snapshot: Snapshot }[] {
    const out: { time: number; snapshot: Snapshot }[] = [];
    for (let t = 0; t <= durationMs; t += PATCH_MS) {
      const base = snapshotAt(t);
      out.push({
        time: t,
        snapshot: {
          ...base,
          ships: base.ships.map((s) =>
            s.id === REMOTE_ID
              ? { ...s, heading: trueHeading(t), velocity: trueVel(t) }
              : { ...s, velocity: { x: 0, y: 0, z: 0 } },
          ),
        },
      });
    }
    return out;
  }

  /** Drawn heading per frame, unwrapped — the quantity that must keep advancing. */
  function drawHeadings(starveMs: number): number[] {
    const full = turningBuffer(4000);
    const blender = new ExtrapolationBlender();
    const out: number[] = [];
    const STARVE_AT = 1500;
    let lastNow = 1000;
    let unwrapped = 0;
    let previous: number | null = null;
    for (let now = 1000; now <= 2600; now += FRAME_MS) {
      const cutoff = now > STARVE_AT && now < STARVE_AT + starveMs ? STARVE_AT : now;
      const buffer = full.filter((s) => s.time <= cutoff);
      const b = bracket(buffer, now - RENDER_DELAY_MS);
      if (!b) continue;
      const [a, z, t, leadMs] = b;
      const ia = buffer.indexOf(a);
      const iz = buffer.indexOf(z);
      const frame = interpolate(
        a,
        z,
        t,
        ia > 0 ? buffer[ia - 1]! : null,
        iz >= 0 && iz + 1 < buffer.length ? buffer[iz + 1]! : null,
        LOCAL_ID,
        { blender, leadMs, dtSeconds: (now - lastNow) / 1000 },
      );
      lastNow = now;
      const heading = frame.ships.find((s) => s.id === REMOTE_ID)!.heading;
      if (previous !== null) {
        let step = heading - previous;
        if (step > Math.PI) step -= Math.PI * 2;
        if (step < -Math.PI) step += Math.PI * 2;
        unwrapped += step;
      }
      previous = heading;
      out.push(unwrapped);
    }
    return out;
  }

  /** Frames that turned less than a third of the true rate — i.e. a frozen nose. */
  function stalledNoseFrames(headings: number[]): number {
    let stalled = 0;
    for (let i = 1; i < headings.length; i++) {
      if (Math.abs(headings[i]! - headings[i - 1]!) < OMEGA * (FRAME_MS / 1000) * 0.33) stalled++;
    }
    return stalled;
  }

  it("keeps the nose TURNING through a starve inside the extrapolation budget", () => {
    // Includes the HAND-BACK frame, which is where a naive re-anchor draws zero
    // rotation: see the `ω·dt` carry in `interpolate`.
    expect(stalledNoseFrames(drawHeadings(150))).toBe(0);
  });

  it("degrades to a held attitude past the budget rather than spinning on", () => {
    expect(stalledNoseFrames(drawHeadings(900))).toBeGreaterThan(0);
  });

  it("NEVER rotates the nose backward, including on the frame the patch lands", () => {
    for (const starveMs of [80, 150, 200, 400, 900]) {
      const h = drawHeadings(starveMs);
      for (let i = 1; i < h.length; i++) {
        expect(h[i]! - h[i - 1]!, `starve ${starveMs}ms, frame ${i}`).toBeGreaterThanOrEqual(-1e-9);
      }
    }
  });

  it("rejoins the true attitude once the buffer refills", () => {
    const starved = drawHeadings(200);
    const truth = drawHeadings(0);
    const last = Math.min(starved.length, truth.length) - 1;
    expect(Math.abs(starved[last]! - truth[last]!)).toBeLessThan(0.01);
  });
});

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ArenaSimulation,
  ConfigService as ConfigServiceImpl,
  decodeCenti,
  decodeHeading,
  decodePitch,
  encodeCenti,
  encodeHeading,
  encodePitch,
  flightStep,
  interpolateFrame,
  pitchTuningOf,
  resolveShipStats,
  seedUp,
  wrapAngle,
  type ConfigService,
  type ShipConfig,
  type SteerState,
  type TuningConfig,
} from "@space-arena/shared";
import { correctPrediction, decodeUp, steeringSnapDistance } from "./NetGameSession.js";

/**
 * **The ONLINE loop (2026-07-27).** After free pitch shipped, the owner reported
 * bumps that the offline tests could not reproduce — and could not, because
 * offline play has no wire, no render delay and no reconciliation at all.
 *
 * This drives the layers that only exist in real play: a real
 * {@link ArenaSimulation} as the authority, every replicated field pushed through
 * the REAL int16 codecs, a few ticks of latency, snapshot interpolation, and the
 * session's own {@link correctPrediction}. The ship holds a pitch-up stick and
 * loops, so both poles and the ±PI wrap are crossed repeatedly.
 */

const DT = 1 / 60;
const SHIP_ID = "ship.interceptor";
/** Snapshots the client is behind the server, i.e. the render delay in ticks. */
const LATENCY_TICKS = 5;

// Same content-loading approach as the sibling prediction suite.
function findContentDir(start: string): string {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    if (existsSync(path.join(dir, "content", "manifest.json"))) return path.join(dir, "content");
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`content/manifest.json not found by walking up from ${start}`);
}
const CONTENT_DIR = findContentDir(process.cwd());
async function fsLoader(relPath: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(CONTENT_DIR, relPath), "utf8"));
}

let configs: ConfigService;
beforeAll(async () => {
  const service = new ConfigServiceImpl(fsLoader);
  const result = await service.load("manifest.json");
  if (!result.ok) throw new Error("test content failed to load: " + JSON.stringify(result.errors));
  // Measured over a fixed tick budget, so run without the match-start countdown.
  const tuning = service.getAll<TuningConfig>("tuning")[0]!;
  const replaced = service.replace({ ...tuning, matchCountdownSec: 0 });
  if (!replaced.ok) throw new Error("failed to zero matchCountdownSec for tests");
  configs = service;
});

interface WireSample {
  pos: { x: number; y: number; z: number };
  heading: number;
  pitch: number;
  up: { x: number; y: number; z: number };
}

/** Exactly what the room writes and the client decodes — nothing simulated. */
function throughWire(
  pos: { x: number; y: number; z: number },
  heading: number,
  pitch: number,
  up: { x: number; y: number; z: number },
): WireSample {
  const decodedHeading = decodeHeading(encodeHeading(heading));
  const decodedPitch = decodePitch(encodePitch(pitch));
  return {
    pos: {
      x: decodeCenti(encodeCenti(pos.x)),
      y: decodeCenti(encodeCenti(pos.y)),
      z: decodeCenti(encodeCenti(pos.z)),
    },
    heading: decodedHeading,
    pitch: decodedPitch,
    // The up rides as float32 components (ArenaState) and is normalized by the
    // client's real decode helper.
    up: decodeUp(Math.fround(up.x), Math.fround(up.y), Math.fround(up.z), decodedHeading, decodedPitch),
  };
}

/** The client's snapshot interpolation between two buffered samples — one FRAME, not Euler lerps. */
function interpolateSample(a: WireSample, b: WireSample, t: number): WireSample {
  const frame = interpolateFrame(a.heading, a.pitch, a.up, b.heading, b.pitch, b.up, t, {
    heading: 0,
    pitch: 0,
    up: { x: 0, y: 1, z: 0 },
  });
  return {
    pos: {
      x: a.pos.x + (b.pos.x - a.pos.x) * t,
      y: a.pos.y + (b.pos.y - a.pos.y) * t,
      z: a.pos.z + (b.pos.z - a.pos.z) * t,
    },
    heading: frame.heading,
    pitch: frame.pitch,
    up: frame.up,
  };
}

interface RunOptions {
  pitchStick: number;
  turn: number;
  ticks: number;
  latency?: number;
}

function flyOnline({ pitchStick, turn, ticks, latency = LATENCY_TICKS }: RunOptions) {
  const sim = new ArenaSimulation(configs, "arena.deep-field", "gamemode.practice", 3);
  const cfg = configs.get<ShipConfig>("ship", SHIP_ID)!;
  const id = sim.spawnPlayer(SHIP_ID, [...cfg.defaultFitting], 0);
  const tf = sim.world.transforms.get(id)!;
  tf.pos.x = 0;
  tf.pos.y = 0;
  tf.pos.z = 0;
  tf.heading = 0.4;
  tf.pitch = 0;
  Object.assign(tf.up, seedUp(0.4, 0));

  const tuning = configs.getAll<TuningConfig>("tuning")[0]!;
  const core = resolveShipStats(cfg, configs, { fittedModuleIds: cfg.defaultFitting.filter((m): m is string => m !== null) });
  const params = {
    nominalSpeed: core.engine.nominalSpeed,
    accel: core.engine.accel,
    turnRate: core.engine.turnRate,
    ...pitchTuningOf(tuning),
  };

  const pred: SteerState = { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, heading: 0.4, pitch: 0, up: seedUp(0.4, 0) };
  const serverVel = { x: 0, y: 0, z: 0 };
  const buffer: WireSample[] = [];
  const held = { throttle: 1, turn, pitchStick, boostMult: 1 };

  sim.applyOrder(id, { kind: "flight", throttle: 1, turn, pitchStick, boost: false, fire: false });

  const rendered: { pitch: number; heading: number; pos: { x: number; y: number; z: number } }[] = [];
  let snaps = 0;
  let maxResidual = 0;

  for (let i = 0; i < ticks; i++) {
    sim.tick(DT);
    const truth = sim.world.transforms.get(id)!;
    buffer.push(throughWire(truth.pos, truth.heading, truth.pitch, truth.up));

    // The client renders LATENCY_TICKS behind, interpolating between the two
    // samples that straddle its render time (t = 0.5 keeps it mid-bracket).
    if (buffer.length <= latency + 1) continue;
    const a = buffer[buffer.length - latency - 1]!;
    const b = buffer[buffer.length - latency]!;
    const sample = interpolateSample(a, b, 0.5);
    serverVel.x = (b.pos.x - a.pos.x) / DT;
    serverVel.y = (b.pos.y - a.pos.y) / DT;
    serverVel.z = (b.pos.z - a.pos.z) / DT;

    // The predictor integrates the held input, then is corrected — the session's
    // order of operations exactly.
    flightStep(pred, held, params, DT);
    // A snap is the correction moving the predictor bodily. The blend moves it by
    // a fraction of the residual, so anything approaching the full residual is a
    // teleport — which is what the player feels as a bump.
    const bx = pred.pos.x;
    const by = pred.pos.y;
    const bz = pred.pos.z;
    const residual = Math.hypot(sample.pos.x - bx, sample.pos.y - by, sample.pos.z - bz);
    correctPrediction(pred, sample, serverVel, { steering: true, dt: DT, correctionRate: 8 });
    const moved = Math.hypot(pred.pos.x - bx, pred.pos.y - by, pred.pos.z - bz);
    if (residual > 0 && moved > residual * 0.9) snaps++;
    maxResidual = Math.max(maxResidual, residual);
    rendered.push({ pitch: pred.pitch, heading: pred.heading, pos: { ...pred.pos } });
  }

  return { rendered, snaps, maxResidual, params, truth: sim.world.transforms.get(id)! };
}

describe("a loop flown through the ONLINE path (wire + latency + reconciliation)", () => {
  it("renders a monotonic loop with no frame-to-frame attitude jump", () => {
    const { rendered, params } = flyOnline({ pitchStick: 1, turn: 0, ticks: 600 });

    // One tick of pitch at full stick — the largest legitimate step there is.
    const tickStep = params.turnRate * params.pitchRateMult * DT;
    let maxStep = 0;
    let backwards = 0;
    for (let i = 1; i < rendered.length; i++) {
      const step = wrapAngle(rendered[i]!.pitch - rendered[i - 1]!.pitch);
      maxStep = Math.max(maxStep, Math.abs(step));
      if (step <= 0) backwards++;
    }

    // The nose never once goes backwards, and never moves more in a frame than
    // one tick of the stick plus a little correction. A reconciliation snap at the
    // wrap shows up here as a step of order PI.
    expect(backwards).toBe(0);
    expect(maxStep).toBeLessThan(tickStep * 2);

    // It really did loop, repeatedly. A RAW decrease is the +PI -> -PI wrap, and
    // the point of the assertions above is that every one of those reads as a
    // small forward step once `wrapAngle` is applied — i.e. the wrap is invisible
    // to the player rather than a bump.
    const wraps = rendered.filter((r, i) => i > 0 && r.pitch < rendered[i - 1]!.pitch).length;
    expect(wraps).toBeGreaterThanOrEqual(2);
    expect(rendered.some((r) => Math.abs(r.pitch) > Math.PI / 2)).toBe(true);
    expect(rendered.some((r) => r.pitch > 0 && r.pitch < Math.PI / 2)).toBe(true);
  });

  it("never teleports the rendered position during an honestly-predicted loop", () => {
    const { rendered, snaps, params } = flyOnline({ pitchStick: 1, turn: 0, ticks: 600 });
    // A snap is a hard cut of the rendered position: the thing the player feels as
    // a bump. Under a held stick with a correctly-sized threshold there are none.
    expect(snaps).toBe(0);
    const perTick = params.nominalSpeed * DT;
    for (let i = 1; i < rendered.length; i++) {
      const d = Math.hypot(
        rendered[i]!.pos.x - rendered[i - 1]!.pos.x,
        rendered[i]!.pos.y - rendered[i - 1]!.pos.y,
        rendered[i]!.pos.z - rendered[i - 1]!.pos.z,
      );
      expect(d).toBeLessThan(perTick * 2);
    }
  });

  it("does the same for a hard TURN, which curves just as much", () => {
    const { rendered, snaps } = flyOnline({ pitchStick: 0, turn: 1, ticks: 400 });
    expect(snaps).toBe(0);
    for (let i = 1; i < rendered.length; i++) {
      expect(Math.abs(wrapAngle(rendered[i]!.heading - rendered[i - 1]!.heading))).toBeLessThan(0.2);
    }
  });

  it("keeps the predicted attitude a legal wrapped angle throughout", () => {
    // A `lerpHeading` result is deliberately unwrapped, so the correction has to
    // re-wrap or the predictor drifts off the circle and every consumer that
    // assumes (-PI, PI] — the codec included — starts clamping.
    const { rendered } = flyOnline({ pitchStick: 1, turn: 0.3, ticks: 600 });
    for (const r of rendered) {
      expect(r.pitch).toBeGreaterThan(-Math.PI);
      expect(r.pitch).toBeLessThanOrEqual(Math.PI);
      expect(r.heading).toBeGreaterThan(-Math.PI);
      expect(r.heading).toBeLessThanOrEqual(Math.PI);
    }
  });

  it("still snaps on a REAL desync, so the widened budget is not a blank cheque", () => {
    // The threshold has to keep catching genuine divergence. A sample teleported
    // far from the predictor is a collision or a rejected order, and it must snap.
    const pred: SteerState = {
      pos: { x: 0, y: 0, z: 0 },
      vel: { x: 34, y: 0, z: 0 },
      heading: 0,
      pitch: 0,
      up: { x: 0, y: 1, z: 0 },
    };
    const far = { pos: { x: 60, y: 0, z: 0 }, heading: 0, pitch: 0, up: { x: 0, y: 1, z: 0 } };
    correctPrediction(pred, far, { x: 0, y: 0, z: 0 }, { steering: true, dt: DT, correctionRate: 8 });
    expect(pred.pos.x).toBe(60); // snapped outright, not blended
    expect(pred.vel.x).toBe(0); // and adopted the server's velocity with it
  });

  it("tracks PITCHED TURNS, where the two body axes interact", () => {
    // Body-frame yaw (BUBBLE.md §A) couples the axes: a turn rotates the nose
    // about the ship's own up, so the pitch axis it is combined with is moving
    // underneath it. That is the trajectory most likely to expose a predictor
    // that mirrors the sim only approximately, so fly several of them.
    for (const [pitchStick, turn] of [
      [1, 1],
      [1, -1],
      [-1, 0.6],
      [0.5, 1],
    ] as const) {
      const { rendered, snaps, maxResidual } = flyOnline({ pitchStick, turn, ticks: 500 });
      expect(snaps).toBe(0);
      // Larger than a loop's 0.07 — a spiral settles further behind the delayed
      // sample — but comfortably inside the speed-scaled budget.
      expect(maxResidual).toBeLessThan(steeringSnapDistance(34));
      for (const r of rendered) {
        expect(r.pitch).toBeGreaterThan(-Math.PI);
        expect(r.pitch).toBeLessThanOrEqual(Math.PI);
      }
      // No frame-to-frame jump — asserted on the NOSE DIRECTION, not on the
      // heading coordinate. Body-frame yaw moves `heading` by `psi / cos(pitch)`,
      // which races away near vertical while the nose itself is turning at a
      // perfectly ordinary rate; bounding the coordinate would fail on correct
      // behaviour. The direction is what the player sees and what teleports if
      // reconciliation goes wrong.
      const noseOf = (a: { heading: number; pitch: number }) => ({
        x: Math.cos(a.pitch) * Math.cos(a.heading),
        y: Math.sin(a.pitch),
        z: Math.cos(a.pitch) * Math.sin(a.heading),
      });
      // The first frames are the predictor catching up from a cold seed; steady
      // state is what a player experiences. The bound is derived, not guessed:
      // full stick on both axes rotates the hull at hypot(3, 2.4) = 3.84 rad/s,
      // i.e. 0.064 rad per 60 Hz frame, and the attitude pull adds its share of a
      // render-delay-sized error on top. Three times the hull's own per-frame
      // rotation is the line between "correcting" and "teleporting". Measured
      // 0.161 here; it was 0.240 while the pull acted on the two Euler
      // coordinates independently, which is the regression this bound catches.
      const maxNoseStep = 3 * Math.hypot(3, 3 * 0.8) * DT;
      for (let i = 60; i < rendered.length; i++) {
        const a = noseOf(rendered[i - 1]!);
        const b = noseOf(rendered[i]!);
        const cos = Math.min(1, Math.max(-1, a.x * b.x + a.y * b.y + a.z * b.z));
        expect(Math.acos(cos)).toBeLessThan(maxNoseStep);
      }
    }
  });

  it("scales the steering budget with speed, never below the blunder threshold", () => {
    expect(steeringSnapDistance(0)).toBe(3);
    expect(steeringSnapDistance(-5)).toBe(3); // a nonsense speed cannot shrink it
    // Must clear the ~3.15 units a full-stick pitched turn actually measures.
    expect(steeringSnapDistance(34)).toBeGreaterThan(3.15);
  });

  it("holds the residual well under the snap threshold at any render delay", () => {
    // The reason the snap branch never fires above, stated as a measurement: the
    // predictor is pulled onto the DELAYED trajectory and then integrates the same
    // held input, so it becomes a lagged copy rather than diverging around the
    // curve. This was worth pinning because the opposite is intuitive — a curved
    // path *looks* like it should open a chord between predictor and sample — and
    // acting on that intuition would mean loosening a threshold that is doing its
    // job.
    for (const latency of [3, 6, 10, 14, 20]) {
      const { snaps, maxResidual } = flyOnline({ pitchStick: 1, turn: 0, ticks: 400, latency });
      expect(snaps).toBe(0);
      expect(maxResidual).toBeLessThan(1);
    }
  });
});

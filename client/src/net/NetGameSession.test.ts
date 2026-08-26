import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ArenaSimulation,
  ConfigService as ConfigServiceImpl,
  SIM_TICK_RATE,
  flightStep,
  pitchTuningOf,
  resolveShipStats,
  seedUp,
  type ConfigService,
  type ModuleConfig,
  type ShipConfig,
  type SteerState,
  type TuningConfig,
  type UpgradeLevels,
} from "@space-arena/shared";
import {
  boostMult,
  decodeCosmeticId,
  decodeModules,
  decodeRoomPhase,
  sampledVelocity,
  snapPrediction,
  FlightReconciler,
  isReplicatedPlayerAlive,
  type PredictedFlight,
} from "./NetGameSession.js";

describe("replicated respawn roster", () => {
  it("excludes a dead roster entry from render snapshots until the server revives it", () => {
    expect(isReplicatedPlayerAlive({ alive: false })).toBe(false);
    expect(isReplicatedPlayerAlive({ alive: true })).toBe(true);
    expect(isReplicatedPlayerAlive({})).toBe(true); // protocol compatibility
  });
});

describe("online room phase", () => {
  it("keeps the lobby distinct from the authoritative 3-2-1 countdown", () => {
    expect(decodeRoomPhase("waiting", 3)).toBe("waiting");
    expect(decodeRoomPhase("live", 3)).toBe("countdown");
    expect(decodeRoomPhase("live", 0)).toBe("live");
  });
});

/**
 * Sol review Finding 2 (HIGH) regression coverage: the replicated
 * `PlayerState.modules` array is sparse-safe (see `shared/src/sim/spawn.ts`),
 * so a fitting like `{0: laser, 2: shield}` only replicates 2 array entries
 * whose own `hardpointIndex` fields are 0 and 2 — `decodeModules` must never
 * synthesize `hardpointIndex` from array position, and must read `moduleId`/
 * `cycleTimer`/`shieldPool` verbatim off the wire (never from
 * `ship.defaultFitting`, which a saved Hangar fitting can differ from).
 */
describe("decodeModules (Finding 2 + 5)", () => {
  it("preserves true hardpointIndex for a sparse fitting instead of reindexing by array position", () => {
    const raw = [
      { hardpointIndex: 0, moduleId: "module.laser-mk1", state: 2, energy: 0, energyCapacity: 0, stateTimer: 0, cycleTimer: 0.1, shieldPool: 0 },
      { hardpointIndex: 2, moduleId: "module.shield-mk1", state: 2, energy: 0, energyCapacity: 0, stateTimer: 0, cycleTimer: 0, shieldPool: 8 },
    ];
    const modules = decodeModules(raw);
    expect(modules).toHaveLength(2);
    // hardpointIndex 0 and 2 survive — NOT reindexed to array positions 0 and 1.
    expect(modules.map((m) => m.hardpointIndex)).toEqual([0, 2]);
    expect(modules[1]!.hardpointIndex).toBe(2);
  });

  it("reads moduleId verbatim off the wire, never from a ship config's defaultFitting", () => {
    const raw = [{ hardpointIndex: 3, moduleId: "module.boost-mk2", state: 0, energy: 0, energyCapacity: 0, stateTimer: 0, cycleTimer: 0, shieldPool: 0 }];
    const modules = decodeModules(raw);
    // The old buggy path would have produced whatever id sat at array index 0
    // in some ship's defaultFitting — assert the actual replicated id instead.
    expect(modules[0]!.moduleId).toBe("module.boost-mk2");
  });

  it("wires replicated cycleTimer and shieldPool through per-module (Finding 5 — firing/shieldActive signals)", () => {
    const raw = [{ hardpointIndex: 0, moduleId: "module.laser-mk1", state: 2, energy: 0, energyCapacity: 0, stateTimer: 0, cycleTimer: 0.35, shieldPool: 0 }];
    const modules = decodeModules(raw);
    expect(modules[0]!.cycleTimer).toBe(0.35);
  });

  it("decodes the module state code (2 = active) via decodeModuleState", () => {
    const raw = [{ hardpointIndex: 0, moduleId: "module.laser-mk1", state: 2, energy: 0, energyCapacity: 0, stateTimer: 0, cycleTimer: 0, shieldPool: 0 }];
    expect(decodeModules(raw)[0]!.state).toBe("active");
  });

  it("wires rounds remaining and the reloading state through the snapshot", () => {
    const raw = [{ hardpointIndex: 0, moduleId: "module.kinetic-mk1", state: 5, rounds: 7, energy: 0, energyCapacity: 0, stateTimer: 1.2, cycleTimer: 0, shieldPool: 0 }];
    expect(decodeModules(raw)[0]).toMatchObject({ state: "reloading", rounds: 7, stateTimer: 1.2 });
  });

  it("wires the replicated continuous-channel flag through per-module", () => {
    // The ONLY new field the continuous beam adds to the wire: without it a
    // remote client has nothing to draw a channelled beam from, since a channel
    // emits one fire event at its start and none per tick afterwards.
    const raw = [
      { hardpointIndex: 0, moduleId: "module.beamlaser-mk1", state: 2, energy: 0, energyCapacity: 0, stateTimer: 0, cycleTimer: 0, channeling: true, shieldPool: 0 },
      { hardpointIndex: 1, moduleId: "module.laser-mk1", state: 2, energy: 0, energyCapacity: 0, stateTimer: 0, cycleTimer: 0.2, channeling: false, shieldPool: 0 },
    ];
    const modules = decodeModules(raw);
    expect(modules[0]!.channeling).toBe(true);
    expect(modules[1]!.channeling).toBe(false);
  });

  it("defaults a missing channeling flag to false without dropping the module", () => {
    const raw = [{ hardpointIndex: 1, moduleId: "module.kinetic-mk1", state: 0, energy: 0, energyCapacity: 0, stateTimer: 0, cycleTimer: 0, shieldPool: 0 }];
    expect(decodeModules(raw)[0]!.channeling).toBe(false);
  });

  it("defaults a missing shieldPool to 0 without dropping the module", () => {
    const raw = [{ hardpointIndex: 1, moduleId: "module.kinetic-mk1", state: 0, energy: 0, energyCapacity: 0, stateTimer: 0, cycleTimer: 0 }];
    expect(decodeModules(raw)[0]!.shieldPool).toBe(0);
  });

  it("accepts a Colyseus-style ArraySchema (a values()-bearing collection), not just a plain array", () => {
    const backing = [{ hardpointIndex: 0, moduleId: "module.laser-mk1", state: 2, energy: 0, energyCapacity: 0, stateTimer: 0, cycleTimer: 0, shieldPool: 0 }];
    const arraySchemaLike = { values: () => backing.values() };
    expect(decodeModules(arraySchemaLike)).toHaveLength(1);
    expect(decodeModules(arraySchemaLike)[0]!.hardpointIndex).toBe(0);
  });
});

/** Sol review Finding 4 (MED): boost multiplier must come from the fitted modules, not the ship's defaultFitting. */
describe("boostMult (Finding 4)", () => {
  function fakeConfigs(modules: Record<string, Partial<ModuleConfig>>): ConfigService {
    return {
      get: (_type: string, id: string) => modules[id] as ModuleConfig | undefined,
    } as unknown as ConfigService;
  }

  it("returns the boost module's speedMult when a boost module is among the FITTED ids", () => {
    const configs = fakeConfigs({
      "module.laser-mk1": {},
      "module.boost-mk1": { boost: { speedMult: 1.8 } },
    });
    expect(boostMult(configs, ["module.laser-mk1", "module.boost-mk1"])).toBe(1.8);
  });

  it("returns 1 when no fitted module has a boost block, even if other modules exist", () => {
    const configs = fakeConfigs({ "module.laser-mk1": {}, "module.shield-mk1": {} });
    expect(boostMult(configs, ["module.laser-mk1", "module.shield-mk1"])).toBe(1);
  });

  it("ignores a boost module that exists in the config registry but is NOT in the fitted id list", () => {
    // Regression: the old implementation read `ship.defaultFitting`, which
    // could include a boost module the player has since unfitted — a
    // Hangar-saved fit without a boost module must not get its speed bonus.
    const configs = fakeConfigs({ "module.boost-mk1": { boost: { speedMult: 1.8 } } });
    expect(boostMult(configs, ["module.laser-mk1"])).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Ack reconciliation (review Finding 4)
// ---------------------------------------------------------------------------

describe("FlightReconciler (Finding 4)", () => {
  // Bots and the current HUD fly planar (pitchStick 0) — the axis rides along
  // so the reconciler is exercised on the real predicted-state shape.
  const A: PredictedFlight = { throttle: 0.2, turn: 0, pitchStick: 0, boost: false, fire: false };
  const B: PredictedFlight = { throttle: 0.6, turn: 0.5, pitchStick: 0, boost: false, fire: true };
  const C: PredictedFlight = { throttle: 1, turn: -1, pitchStick: 0.5, boost: true, fire: false };

  it("keeps the newest accepted state when an OLDER order is rejected after it", () => {
    // The reported bug: A accepted, B rejected, C accepted — B's rejection used
    // to roll the predictor back to A, and C's ack only touched the "last
    // accepted" slot, so prediction sat on A forever while the server flew C.
    const r = new FlightReconciler();
    r.sent(1, A);
    r.acked(1, true);
    r.sent(2, B);
    r.sent(3, C);
    r.acked(3, true);
    r.acked(2, false); // late rejection of a superseded order
    expect(r.current).toBe(C);
  });

  it("still rolls back when the REJECTED order is the newest one sent", () => {
    // The case the rollback exists for: nothing newer is in flight, so the
    // server really is still integrating the last accepted state.
    const r = new FlightReconciler();
    r.sent(1, A);
    r.acked(1, true);
    r.sent(2, B);
    expect(r.acked(2, false)).toBe(true);
    expect(r.current).toBe(A);
  });

  it("rolls back to null when the very first order is rejected", () => {
    const r = new FlightReconciler();
    r.sent(1, A);
    expect(r.acked(1, false)).toBe(true);
    expect(r.current).toBeNull();
  });

  it("rolls back to the newest accepted state, not the oldest", () => {
    const r = new FlightReconciler();
    r.sent(1, A);
    r.acked(1, true);
    r.sent(2, B);
    r.acked(2, true);
    r.sent(3, C);
    r.acked(3, false);
    expect(r.current).toBe(B);
  });

  it("ignores acks for seqs that were not flight orders", () => {
    const r = new FlightReconciler();
    r.sent(1, A);
    r.acked(1, true);
    r.acked(2, false); // a moduleToggle rejection, say
    expect(r.current).toBe(A);
  });

  it("preserves the pitch axis across a rollback, not just throttle and turn", () => {
    // BUBBLE.md §B: `pitchStick` is a full member of the predicted flight state,
    // so a rejection has to restore the ATTITUDE the server is still flying. A
    // rollback that dropped the axis (or reset it to 0) would leave the
    // predictor levelling off while the real ship kept climbing — a growing
    // vertical error the correction blend cannot absorb, because the input
    // itself is wrong every tick.
    const climb: PredictedFlight = { throttle: 1, turn: 0, pitchStick: 0.75, boost: false, fire: true };
    const dive: PredictedFlight = { throttle: 1, turn: 0, pitchStick: -0.75, boost: false, fire: false };
    const r = new FlightReconciler();
    r.sent(1, climb);
    r.acked(1, true);
    r.sent(2, dive);
    r.acked(2, false); // newest sent → roll back
    expect(r.current).toBe(climb);
    expect(r.current!.pitchStick).toBe(0.75);
    expect(r.current!.fire).toBe(true);
  });

  it("does not let a straggling older acceptance overwrite a newer one", () => {
    const r = new FlightReconciler();
    r.sent(1, A);
    r.sent(2, B);
    r.acked(2, true);
    r.acked(1, true);
    r.sent(3, C);
    r.acked(3, false); // newest sent → roll back to the newest ACCEPTED
    expect(r.current).toBe(B);
  });
});

// ---------------------------------------------------------------------------
// Prediction snap (review Finding 5)
// ---------------------------------------------------------------------------

describe("snapPrediction (Finding 5)", () => {
  function state(): SteerState {
    // Cruising at nominal speed along +x, as the predictor would be mid-flight.
    return { pos: { x: 10, y: 0, z: 0 }, vel: { x: 40, y: 0, z: 0 }, heading: 0, pitch: 0, up: { x: 0, y: 1, z: 0 } };
  }

  it("replaces velocity instead of carrying the predictor's stale speed across a snap", () => {
    // The oscillation: an asteroid collision cancels the server's velocity, the
    // predictor snaps onto the corrected position but keeps flying at 40 u/s,
    // races back outside SNAP_DISTANCE and snaps again, every frame.
    const pred = state();
    snapPrediction(pred, { x: 4, y: -2, z: 1 }, 1.2, 0.3, { x: 0, y: 0, z: 0 }, seedUp(1.2, 0.3));
    expect(pred.pos).toEqual({ x: 4, y: -2, z: 1 });
    expect(pred.heading).toBe(1.2);
    expect(pred.pitch).toBe(0.3);
    expect(pred.vel).toEqual({ x: 0, y: 0, z: 0 });
    expect(pred.up).toEqual(seedUp(1.2, 0.3)); // the frame snaps with the pose
  });

  it("adopts the authoritative velocity when one can be derived", () => {
    const pred = state();
    snapPrediction(pred, { x: 4, y: 0, z: 1 }, 0, 0, { x: -3, y: 2, z: 7 }, { x: 0, y: 1, z: 0 });
    expect(pred.vel).toEqual({ x: -3, y: 2, z: 7 });
  });
});

describe("sampledVelocity (Finding 5)", () => {
  it("differences two authoritative samples into units per second", () => {
    expect(sampledVelocity({ x: 0, y: 0, z: 0 }, { x: 2, y: 1, z: -1 }, 0.05)).toEqual({ x: 40, y: 20, z: -20 });
  });

  it("reports zero rather than a divide when the samples share a timestamp", () => {
    // `bracket` returns [s, s, 0] while only one snapshot has arrived.
    expect(sampledVelocity({ x: 0, y: 0, z: 0 }, { x: 2, y: 1, z: -1 }, 0)).toEqual({ x: 0, y: 0, z: 0 });
  });
});

// ---------------------------------------------------------------------------
// Prediction parity (FLIGHT.md §5)
// ---------------------------------------------------------------------------

// Same content-loading approach as `hangarStats.test.ts` — see the long comment
// there for why client tests walk up from cwd instead of using import.meta.url.
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
  // Prediction parity is measured over a fixed tick budget, so this suite runs on
  // a pack with no match-start countdown (see ArenaSimulation). The countdown's
  // own effect on prediction — suspended integration — is covered in the sim's
  // countdown suite and by `applyPrediction`'s phase gate.
  const tuning = service.getAll<TuningConfig>("tuning")[0]!;
  const replaced = service.replace({ ...tuning, matchCountdownSec: 0 });
  if (!replaced.ok) throw new Error("failed to zero matchCountdownSec for tests");
  configs = service;
});

const DT = 1 / SIM_TICK_RATE;
const SHIP_ID = "ship.interceptor";
/** Long enough to cover the accel ramp AND the cruise phase (1.5 s). */
const RUN_TICKS = Math.round(1.5 * SIM_TICK_RATE);
const START = { x: 0, z: -49 };

/**
 * Fly the REAL sim and the client's `flightStep` predictor side by side from the
 * same start state and the same held flight input, and report the final gap.
 *
 * `predictorStats` chooses which stats the predictor integrates with — the whole
 * point of the resolved-stats requirement is that the answer changes.
 */
function driftOverRun(
  upgradeLevels: UpgradeLevels,
  predictorStats: "resolved" | "base",
  input: { throttle: number; turn: number; pitchStick?: number; boost: boolean } = {
    throttle: 1,
    turn: 0.25,
    boost: false,
  },
): { drift: number; hits: number; climb: number; pitch: number; pitchDrift: number } {
  const sim = new ArenaSimulation(configs, "arena.ring-nebula", "gamemode.practice-bots-1v1", 1);
  const cfg = configs.get<ShipConfig>("ship", SHIP_ID)!;
  const fitting = [...cfg.defaultFitting];
  const id = sim.spawnPlayer(SHIP_ID, fitting, 0, upgradeLevels);

  // Fly a clear lower-latitude corridor beneath ring-nebula's volumetric rock
  // clusters. Collisions and boundary rules are server-side events prediction
  // is NOT expected to mirror, so the run is placed where neither happens —
  // `hits` proves that held.
  const tf = sim.world.transforms.get(id)!;
  tf.pos.x = START.x;
  tf.pos.y = 0;
  tf.pos.z = START.z;
  tf.heading = 0;
  tf.pitch = 0;
  // The frame is authoritative: re-seed the up with the poked attitude, exactly
  // as the predictor below seeds its own.
  Object.assign(tf.up, seedUp(0, 0));

  const pred: SteerState = {
    pos: { x: START.x, y: 0, z: START.z },
    vel: { x: 0, y: 0, z: 0 },
    heading: 0,
    pitch: 0,
    up: seedUp(0, 0),
  };
  const fittedModuleIds = fitting.filter((m): m is string => m !== null);
  const core = resolveShipStats(cfg, configs, {
    fittedModuleIds,
    upgradeLevels: predictorStats === "resolved" ? upgradeLevels : undefined,
  });
  const engine = predictorStats === "resolved" ? core.engine : cfg.core.engine;
  const tuning = configs.getAll<TuningConfig>("tuning")[0]!;

  // This is a flight-only parity bench. Keeping the trigger released avoids
  // discrete auto-repeat damage events contaminating its collision counter.
  sim.applyOrder(id, { kind: "flight", ...input, fire: false });

  let hits = 0;
  for (let i = 0; i < RUN_TICKS; i++) {
    sim.tick(DT);
    for (const ev of sim.getEvents()) if (ev.type === "damage" || ev.type === "boundaryHit") hits++;
    flightStep(
      pred,
      { throttle: input.throttle, turn: input.turn, pitchStick: input.pitchStick ?? 0, boostMult: 1 },
      {
        nominalSpeed: engine.nominalSpeed,
        accel: engine.accel,
        turnRate: engine.turnRate,
        ...pitchTuningOf(tuning),
      },
      DT,
    );
  }

  const truth = sim.world.transforms.get(id)!;
  return {
    drift: Math.hypot(truth.pos.x - pred.pos.x, truth.pos.y - pred.pos.y, truth.pos.z - pred.pos.z),
    hits,
    // Reported so a "3D" parity assertion can prove the run actually LEFT the
    // ground plane — a pitched corridor that stayed at y=0 would pass a drift
    // check while testing nothing the planar runs above don't already cover.
    climb: truth.pos.y,
    pitch: truth.pitch,
    pitchDrift: Math.abs(truth.pitch - pred.pitch),
  };
}

describe("flight prediction vs the server sim (FLIGHT.md §5)", () => {
  it("tracks an un-upgraded ship with effectively zero drift", () => {
    const { drift, hits } = driftOverRun({ hull: 0, engine: 0, energy: 0 }, "resolved");
    expect(hits).toBe(0); // nothing but flight happened, so the gap is pure prediction error
    expect(drift).toBeLessThan(1e-9);
  });

  it("still tracks exactly when the player's ENGINE upgrades change the stats", () => {
    // The reason prediction must resolve stats rather than read `cfg.core.engine`:
    // under continuous flight a stat error is applied every tick and compounds,
    // instead of being a transient the correction blend can absorb.
    const levels: UpgradeLevels = { hull: 0, engine: 5, energy: 0 };
    const resolved = driftOverRun(levels, "resolved");
    expect(resolved.hits).toBe(0);
    expect(resolved.drift).toBeLessThan(1e-9);

    // Control: the same run predicted from BASE stats is metres out in 1.5 s —
    // far past SNAP_DISTANCE (3), i.e. a permanent rubber-band for the player.
    const base = driftOverRun(levels, "base");
    expect(base.drift).toBeGreaterThan(3);
  });

  it("holds a level-triggered input across the whole run without re-sending it", () => {
    // One order, 45 ticks: the predictor keeps integrating the held state exactly
    // as the sim's stored FlightState does (that is what makes it a mirror).
    const { drift, hits } = driftOverRun({ hull: 0, engine: 2, energy: 0 }, "resolved", {
      throttle: 0.6,
      turn: -0.1,
      boost: false,
    });
    expect(hits).toBe(0);
    expect(drift).toBeLessThan(1e-9);
  });

  // -------------------------------------------------------------------------
  // 3D (BUBBLE.md §B)
  // -------------------------------------------------------------------------

  it("tracks a PITCHED corridor in three dimensions with the same zero drift", () => {
    // ring-nebula deliberately, not deep-field: the point of this run is
    // prediction error, not a collision course. BUBBLE.md §E's authored
    // corridor leaves room through the volumetric placement field.
    const { drift, hits, climb, pitch, pitchDrift } = driftOverRun(
      { hull: 0, engine: 0, energy: 0 },
      "resolved",
      { throttle: 1, turn: 0.15, pitchStick: 0.6, boost: false },
    );
    expect(hits).toBe(0);
    // The run genuinely left the plane — otherwise this is the planar test again.
    expect(climb).toBeGreaterThan(5);
    expect(pitch).toBeGreaterThan(0.1);
    expect(drift).toBeLessThan(1e-9);
    expect(pitchDrift).toBeLessThan(1e-9);
  });

  it("mirrors a DIVE, where the wire's signed pitch matters most", () => {
    // turn −0.1, not the −0.2 this ran with under the nose-only integrator: the
    // full-frame body coupling bends a pitched turn differently (flight-frame
    // handoff) and the old corridor now clips a ring-nebula rock. The run's
    // point is prediction error, so it is placed where nothing else happens.
    const { drift, hits, climb, pitch } = driftOverRun({ hull: 0, engine: 3, energy: 0 }, "resolved", {
      throttle: 0.8,
      turn: -0.1,
      pitchStick: -0.5,
      boost: false,
    });
    expect(hits).toBe(0);
    expect(climb).toBeLessThan(-5);
    expect(pitch).toBeLessThan(-0.1);
    expect(drift).toBeLessThan(1e-9);
  });

  it("mirrors the sim's pitch WRAP, so a held stick loops without diverging", () => {
    // Held full-up for the whole run. Shipped tuning authors no `maxPitchRad`, so
    // the nose goes over the top and keeps going (BUBBLE.md §A) — the predictor
    // and the sim have to wrap on the same tick, because a mirror that crossed
    // ±π one tick late would put the two ships on opposite sides of a loop.
    const tuning = configs.getAll<TuningConfig>("tuning")[0]!;
    expect(pitchTuningOf(tuning).maxPitchRad).toBeNull();
    const { drift, hits, pitch, pitchDrift } = driftOverRun({ hull: 0, engine: 0, energy: 0 }, "resolved", {
      throttle: 1,
      turn: 0,
      pitchStick: 1,
      boost: false,
    });
    expect(hits).toBe(0);
    // A legal wrapped attitude, and one the old clamp could never have produced.
    expect(pitch).toBeGreaterThan(-Math.PI);
    expect(pitch).toBeLessThanOrEqual(Math.PI);
    expect(Math.abs(pitch)).toBeGreaterThan(Math.PI / 2);
    expect(pitchDrift).toBe(0);
    expect(drift).toBeLessThan(1e-9);
  });
});

/**
 * Cosmetics (protocol 5): the wire carries "" for "authored look" because a
 * schema string has no null, and the offline snapshot carries an ABSENT field
 * for the same state. Both must land on the renderer as one case.
 */
describe("decodeCosmeticId", () => {
  it("reads a replicated paint verbatim", () => {
    expect(decodeCosmeticId("cosmetic.paint-crimson")).toBe("cosmetic.paint-crimson");
  });

  it("maps the empty wire value and junk to absent but preserves retired ids for trust-boundary migration", () => {
    expect(decodeCosmeticId("")).toBeUndefined();
    expect(decodeCosmeticId("cosmetic.paint-standard")).toBe("cosmetic.paint-standard");
    expect(decodeCosmeticId(undefined)).toBeUndefined();
    expect(decodeCosmeticId(null)).toBeUndefined();
    expect(decodeCosmeticId(7)).toBeUndefined();
  });
});

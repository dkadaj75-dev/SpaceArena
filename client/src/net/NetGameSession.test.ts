import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ArenaSimulation,
  ConfigService as ConfigServiceImpl,
  flightStep,
  resolveShipStats,
  type ConfigService,
  type ModuleConfig,
  type ShipConfig,
  type SteerState,
  type UpgradeLevels,
} from "@space-arena/shared";
import { boostMult, decodeModules } from "./NetGameSession.js";

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
      { hardpointIndex: 0, moduleId: "module.laser-mk1", state: 2, heat: 12, stateTimer: 0, cycleTimer: 0.1, shieldPool: 0 },
      { hardpointIndex: 2, moduleId: "module.shield-mk1", state: 2, heat: 3, stateTimer: 0, cycleTimer: 0, shieldPool: 8 },
    ];
    const modules = decodeModules(raw);
    expect(modules).toHaveLength(2);
    // hardpointIndex 0 and 2 survive — NOT reindexed to array positions 0 and 1.
    expect(modules.map((m) => m.hardpointIndex)).toEqual([0, 2]);
    expect(modules[1]!.hardpointIndex).toBe(2);
  });

  it("reads moduleId verbatim off the wire, never from a ship config's defaultFitting", () => {
    const raw = [{ hardpointIndex: 3, moduleId: "module.boost-mk2", state: 0, heat: 0, stateTimer: 0, cycleTimer: 0, shieldPool: 0 }];
    const modules = decodeModules(raw);
    // The old buggy path would have produced whatever id sat at array index 0
    // in some ship's defaultFitting — assert the actual replicated id instead.
    expect(modules[0]!.moduleId).toBe("module.boost-mk2");
  });

  it("wires replicated cycleTimer and shieldPool through per-module (Finding 5 — firing/shieldActive signals)", () => {
    const raw = [{ hardpointIndex: 0, moduleId: "module.laser-mk1", state: 2, heat: 0, stateTimer: 0, cycleTimer: 0.35, shieldPool: 0 }];
    const modules = decodeModules(raw);
    expect(modules[0]!.cycleTimer).toBe(0.35);
  });

  it("decodes the module state code (2 = active) via decodeModuleState", () => {
    const raw = [{ hardpointIndex: 0, moduleId: "module.laser-mk1", state: 2, heat: 0, stateTimer: 0, cycleTimer: 0, shieldPool: 0 }];
    expect(decodeModules(raw)[0]!.state).toBe("active");
  });

  it("defaults a missing shieldPool to 0 without dropping the module", () => {
    const raw = [{ hardpointIndex: 1, moduleId: "module.kinetic-mk1", state: 0, heat: 0, stateTimer: 0, cycleTimer: 0 }];
    expect(decodeModules(raw)[0]!.shieldPool).toBe(0);
  });

  it("accepts a Colyseus-style ArraySchema (a values()-bearing collection), not just a plain array", () => {
    const backing = [{ hardpointIndex: 0, moduleId: "module.laser-mk1", state: 2, heat: 0, stateTimer: 0, cycleTimer: 0, shieldPool: 0 }];
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
      "module.boost-mk1": { boost: { speedMult: 1.8, heatPerSec: 5 } },
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
    const configs = fakeConfigs({ "module.boost-mk1": { boost: { speedMult: 1.8, heatPerSec: 5 } } });
    expect(boostMult(configs, ["module.laser-mk1"])).toBe(1);
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
  configs = service;
});

const DT = 1 / 30;
const SHIP_ID = "ship.interceptor";
/** Long enough to cover the accel ramp AND the cruise phase (1.5 s). */
const RUN_TICKS = 45;
const START = { x: 0, z: -70 };

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
  input = { throttle: 1, turn: 0.25, boost: false },
): { drift: number; hits: number } {
  const sim = new ArenaSimulation(configs, "arena.ring-nebula", "gamemode.practice", 1);
  const cfg = configs.get<ShipConfig>("ship", SHIP_ID)!;
  const fitting = [...cfg.defaultFitting];
  const id = sim.spawnPlayer(SHIP_ID, fitting, 0, upgradeLevels);

  // Fly a clear corridor (ring-nebula's rocks sit at the centre and at ±(34,18)
  // / ±(52,12)) well inside the radius-90 boundary. Collisions and boundary
  // rules are server-side events prediction is NOT expected to mirror, so the
  // run is placed where neither happens — `hits` proves that held.
  const tf = sim.world.transforms.get(id)!;
  tf.pos.x = START.x;
  tf.pos.z = START.z;
  tf.heading = 0;

  const pred: SteerState = { pos: { x: START.x, z: START.z }, vel: { x: 0, z: 0 }, heading: 0 };
  const fittedModuleIds = fitting.filter((m): m is string => m !== null);
  const core = resolveShipStats(cfg, configs, {
    fittedModuleIds,
    upgradeLevels: predictorStats === "resolved" ? upgradeLevels : undefined,
  });
  const engine = predictorStats === "resolved" ? core.engine : cfg.core.engine;

  sim.applyOrder(id, { kind: "flight", ...input });

  let hits = 0;
  for (let i = 0; i < RUN_TICKS; i++) {
    sim.tick(DT);
    for (const ev of sim.getEvents()) if (ev.type === "damage" || ev.type === "boundaryHit") hits++;
    flightStep(
      pred,
      { throttle: input.throttle, turn: input.turn, boostMult: 1 },
      { nominalSpeed: engine.nominalSpeed, accel: engine.accel, turnRate: engine.turnRate },
      DT,
    );
  }

  const truth = sim.world.transforms.get(id)!;
  return { drift: Math.hypot(truth.pos.x - pred.pos.x, truth.pos.z - pred.pos.z), hits };
}

describe("flight prediction vs the server sim (FLIGHT.md §5)", () => {
  it("tracks an un-upgraded ship with effectively zero drift", () => {
    const { drift, hits } = driftOverRun({ hull: 0, engine: 0, energy: 0, heat: 0 }, "resolved");
    expect(hits).toBe(0); // nothing but flight happened, so the gap is pure prediction error
    expect(drift).toBeLessThan(1e-9);
  });

  it("still tracks exactly when the player's ENGINE upgrades change the stats", () => {
    // The reason prediction must resolve stats rather than read `cfg.core.engine`:
    // under continuous flight a stat error is applied every tick and compounds,
    // instead of being a transient the correction blend can absorb.
    const levels: UpgradeLevels = { hull: 0, engine: 5, energy: 0, heat: 0 };
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
    const { drift, hits } = driftOverRun({ hull: 0, engine: 2, energy: 0, heat: 0 }, "resolved", {
      throttle: 0.6,
      turn: -0.1,
      boost: false,
    });
    expect(hits).toBe(0);
    expect(drift).toBeLessThan(1e-9);
  });
});

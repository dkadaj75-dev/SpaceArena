import { beforeAll, describe, expect, it } from "vitest";

import { ConfigService } from "../core/ConfigService.js";
import type { ModuleConfig, ShipConfig } from "../schemas/index.js";
import { ArenaSimulation } from "./ArenaSimulation.js";
import { loadTestConfigs, pinLock } from "./testutil.js";

/**
 * FEEL IDENTITIES of the heat/energy overhaul (2026-08-07), pinned as tests.
 *
 * The overhaul's acceptance numbers — a mk1 rack burns ~5 s, cools in ~2.5 s, and
 * a sprint drive holds boost ~3 s — lived only in `tools/heat-feel-bench.ts`, a
 * standalone script no gate runs. `balanceRegression.test.ts` pins the ARITHMETIC
 * of burn and recovery from the content numbers, which cannot see a sim-side
 * regression, and pins nothing at all about boost. A content edit could therefore
 * halve a weapon's uptime or a drive's boost window and leave every gate green
 * (proved: `docs/audits/2026-08-07-verification-mutation-matrix.md`, mutations
 * 8b/8c).
 *
 * This suite MEASURES the identities in the simulation instead, so both a content
 * edit and a sim change have to trip it.
 *
 * Anchors recorded 2026-08-07 against the shipped pack. A band violation means a
 * change moved the feel: if that was intentional, re-record the literal in the
 * same commit as the change, so the diff carries the design intent.
 *
 * Determinism: an asteroid-free bench arena, a fixed 30 Hz tick, fully scripted
 * orders and no RNG consumer.
 */

const DT = 1 / 30;
const TPS = 30;

const BENCH_ARENA = "arena.feel-bench";
const BENCH_MODE = "gamemode.feel-bench";

/** The free kit: what a brand-new pilot flies before spending a credit. */
const FREE_SHIP = "ship.interceptor";
/** Index of the interceptor's internal engine socket in its default fitting. */
const ENGINE_SLOT = 2;

let configs: ConfigService;

beforeAll(async () => {
  configs = await loadTestConfigs({ heatSystem: true });
  expectReplaced(
    configs.replace({
      id: BENCH_ARENA,
      type: "arena",
      version: 1,
      name: "Feel Bench",
      bounds: { shape: "sphere", radius: 307.67 },
      asteroidPlacements: [],
      spawnPoints: [
        { id: "f0", team: 0, position: { x: 0, z: 0 }, heading: 0 },
        { id: "f1", team: 1, position: { x: 22, z: 0 }, heading: Math.PI },
      ],
    }),
  );
  expectReplaced(
    configs.replace({
      id: BENCH_MODE,
      type: "gamemode",
      version: 1,
      name: "Feel Bench",
      teams: "1v1",
      winCondition: { type: "timeLimit", seconds: 3600 },
      eliminationEndsMatch: false,
      respawn: { enabled: false, delay: 0 },
      boundaryRule: { type: "warning" },
      rewards: { win: 0, loss: 0, perKill: 0 },
    }),
  );
});

function expectReplaced(result: { ok: boolean; errors: unknown[] }): void {
  if (!result.ok) throw new Error(`bench fixture rejected: ${JSON.stringify(result.errors)}`);
}

const fittingOf = (shipId: string): readonly string[] => configs.get<ShipConfig>("ship", shipId)!.defaultFitting;

const round = (v: number): number => Math.round(v * 100) / 100;

const expectNear = (label: string, value: number, recorded: number, band: number): void => {
  expect(
    Math.abs(value - recorded) <= band,
    `${label}: ${value} outside ${recorded} ±${band} — re-record if this feel change is intentional`,
  ).toBe(true);
};

// --------------------------------------------------------------------------
// Weapon thermal feel
// --------------------------------------------------------------------------

interface WeaponFeel {
  /** Seconds of held trigger before the rack locks out, from cold. */
  burnSec: number;
  /** Seconds the rack stays locked out before it re-arms. */
  lockoutSec: number;
  /** Seconds a full rack takes to reach zero with the trigger released. */
  recoverSec: number;
  /** Share of a 60 s held trigger the rack was NOT locked out (0..1). */
  uptime: number;
}

/**
 * Hold the trigger of one free-kit weapon on an immortal sparring partner and
 * watch its whole thermal cycle. The partner carries no live weapon and is healed
 * every tick, so nothing but the subject's own upkeep is being measured.
 */
function weaponFeel(moduleId: string): WeaponFeel {
  const sim = new ArenaSimulation(configs, BENCH_ARENA, BENCH_MODE, 1);
  const me = sim.spawnPlayerAt(FREE_SHIP, fittingOf(FREE_SHIP), 0, { x: 0, z: 0 }, 0);
  const foe = sim.spawnPlayerAt("ship.brawler", fittingOf("ship.brawler"), 1, { x: 22, z: 0 }, Math.PI);
  for (const m of sim.world.modules.get(foe)!.modules) {
    if (configs.get<ModuleConfig>("module", m.moduleId)?.fire) m.state = "retracted";
  }
  const foeCore = sim.world.shipCores.get(foe)!;
  const rack = sim.world.modules.get(me)!.modules.find((m) => m.moduleId === moduleId)!;
  sim.applyOrder(me, { kind: "flight", throttle: 0, turn: 0, boost: false, fire: true });

  const MEASURE_S = 60;
  let burn = -1;
  let lockout = -1;
  let upTicks = 0;
  for (let t = 1; t <= MEASURE_S * TPS; t++) {
    // Locks pinned every tick (FLIGHT.md §2): a targeting stall would read as a
    // thermal result.
    pinLock(sim.world, me);
    sim.tick(DT);
    sim.getEvents();
    foeCore.hull = foeCore.hullMax;
    if (rack.state !== "overheated") upTicks++;
    if (burn < 0 && rack.state === "overheated") burn = t / TPS;
    if (burn > 0 && lockout < 0 && rack.state !== "overheated") lockout = t / TPS - burn;
  }

  // Recovery is measured from a FULL rack with the trigger released, which is
  // the number a pilot feels when they let go.
  const cold = new ArenaSimulation(configs, BENCH_ARENA, BENCH_MODE, 1);
  const idle = cold.spawnPlayerAt(FREE_SHIP, fittingOf(FREE_SHIP), 0, { x: 0, z: 0 }, 0);
  const idleRack = cold.world.modules.get(idle)!.modules.find((m) => m.moduleId === moduleId)!;
  idleRack.heat = idleRack.heatCapacity;
  let recover = -1;
  for (let t = 1; t <= 30 * TPS; t++) {
    cold.tick(DT);
    cold.getEvents();
    if (idleRack.heat <= 0) {
      recover = t / TPS;
      break;
    }
  }

  return {
    burnSec: round(burn),
    lockoutSec: round(lockout),
    recoverSec: round(recover),
    uptime: round(upTicks / (MEASURE_S * TPS)),
  };
}

describe("free-kit weapon thermal feel (measured, not computed)", () => {
  it("pulse laser: ~5 s burn, ~2 s lockout, ~2.5 s recovery", () => {
    const f = weaponFeel("module.laser-mk1");
    expectNear("laser-mk1 burn", f.burnSec, 5.37, 0.6);
    expectNear("laser-mk1 lockout", f.lockoutSec, 1.9, 0.4);
    expectNear("laser-mk1 recovery", f.recoverSec, 2.53, 0.4);
    // Uptime is the number that decides whether holding the trigger is a build:
    // an edit that halves it changes the game without changing any TTK literal.
    expectNear("laser-mk1 uptime", f.uptime, 0.77, 0.08);
  });

  it("missile rack: no longer heat-limited at all — the shot clock is its limiter", () => {
    // RE-RECORDED 2026-08-14 (missiles halved to one shot every 2.4 s). The old
    // anchors — 6.07 s burn, 1.9 s lockout, 0.81 uptime — described a rack that
    // out-paced its own cooling. At half rate it no longer does: 58.1 heat a
    // shot every 2.4 s is 24.2/s against the free radiator's 40/s, so heat now
    // decays between missiles and the rack never reaches its capacity.
    //
    // `-1` is the harness's "never happened" for burn and lockout, and it is
    // recorded here deliberately rather than deleted: if a future edit makes a
    // missile rack overheat again, that is a feel change and this test should
    // say so.
    const f = weaponFeel("module.missile-mk1");
    expect(f.burnSec, "missile-mk1 never locks out").toBe(-1);
    expect(f.lockoutSec, "missile-mk1 never locks out").toBe(-1);
    expect(f.uptime, "missile-mk1 uptime").toBe(1);
    // The radiator itself is untouched — a rack filled by hand still cools in
    // the same ~2.5 s it always did.
    expectNear("missile-mk1 recovery", f.recoverSec, 2.53, 0.4);
  });

  it("keeps the trigger worth holding: the heat-gated rack is not locked out most of the fight", () => {
    // Scoped to the LASER on 2026-08-14. The pair-wise loop this replaced
    // asserted `uptime < 0.95` for both free-kit racks — "no rack may run so
    // cool that heat stops being a decision" — which the half-rate missile rack
    // now fails by design (uptime 1, see above). Heat is still a decision on
    // every rack the pilot holds down continuously; the missile is simply not
    // one of those any more.
    const f = weaponFeel("module.laser-mk1");
    expect(f.uptime, "laser-mk1 uptime").toBeGreaterThan(0.6);
    expect(f.uptime, "laser-mk1 uptime").toBeLessThan(0.95);
    expect(f.burnSec, "laser-mk1 burn").toBeGreaterThan(0);
    expect(f.lockoutSec, "laser-mk1 lockout").toBeGreaterThan(0);
  });
});

// --------------------------------------------------------------------------
// Boost feel
// --------------------------------------------------------------------------

interface BoostFeel {
  /** Seconds of held boost from a full tank until it empties. */
  activeSec: number;
  /** Seconds from empty back to a full tank with boost released. */
  rechargeSec: number;
}

/** Every mountable drive that can boost. `module.boost-*` has no socket that accepts it. */
const boostEngines = (): string[] =>
  configs
    .getAll<ModuleConfig>("module")
    .filter((m) => m.family === "engine" && m.boost && m.energy)
    .map((m) => m.id)
    .sort();

/** Hold boost on the free hull until the drive's tank empties, then time the refill. */
function boostFeel(engineId: string): BoostFeel {
  const fitting = [...fittingOf(FREE_SHIP)];
  fitting[ENGINE_SLOT] = engineId;
  const sim = new ArenaSimulation(configs, BENCH_ARENA, BENCH_MODE, 1);
  const me = sim.spawnPlayerAt(FREE_SHIP, fitting, 0, { x: 0, z: 0 }, 0);
  const drive = sim.world.modules.get(me)!.modules.find((m) => m.moduleId === engineId)!;
  // Boost drives spawn offline; bring the drive up before measuring.
  sim.applyOrder(me, { kind: "moduleToggle", hardpointIndex: drive.hardpointIndex });
  for (let t = 0; t < 30 && drive.state !== "active"; t++) {
    sim.applyOrder(me, { kind: "flight", throttle: 1, turn: 0, boost: true, fire: false });
    sim.tick(DT);
    sim.getEvents();
  }

  let active = -1;
  for (let t = 1; t <= 60 * TPS; t++) {
    sim.applyOrder(me, { kind: "flight", throttle: 1, turn: 0, boost: true, fire: false });
    sim.tick(DT);
    sim.getEvents();
    if (drive.energy <= 0) {
      active = t / TPS;
      break;
    }
  }
  let recharge = -1;
  for (let t = 1; t <= 120 * TPS; t++) {
    sim.applyOrder(me, { kind: "flight", throttle: 0, turn: 0, boost: false, fire: false });
    sim.tick(DT);
    sim.getEvents();
    if (drive.energy >= drive.energyCapacity - 1e-6) {
      recharge = t / TPS;
      break;
    }
  }
  return { activeSec: round(active), rechargeSec: round(recharge) };
}

describe("boost feel (measured on the free hull)", () => {
  // Anchors recorded 2026-08-07. The sprint drives share a ~3 s window; the
  // endurance drive is the deliberate outlier that trades speed for duration.
  const ANCHORS: Array<[engine: string, activeSec: number, rechargeSec: number]> = [
    ["module.engine-agile", 2.8, 6.0],
    ["module.engine-endurance", 5.03, 8.0],
    ["module.engine-racing", 2.53, 7.5],
    ["module.engine-sport", 2.77, 5.97],
  ];

  it.each(ANCHORS)("%s holds boost for its recorded window", (engine, activeSec, rechargeSec) => {
    const f = boostFeel(engine);
    expectNear(`${engine} boost window`, f.activeSec, activeSec, 0.4);
    expectNear(`${engine} boost recharge`, f.rechargeSec, rechargeSec, 0.8);
  });

  it("covers every mountable boost drive in the pack — a new one cannot ship unpinned", () => {
    expect(boostEngines()).toEqual(ANCHORS.map(([engine]) => engine));
  });

  it("keeps boost a burst, never a cruise mode or a tap", () => {
    for (const engine of boostEngines()) {
      const f = boostFeel(engine);
      // A window under a second is a tap; over six is free speed.
      expect(f.activeSec, `${engine} boost window`).toBeGreaterThan(2);
      expect(f.activeSec, `${engine} boost window`).toBeLessThan(6);
      // Refilling must cost more than the burst, or holding boost is strictly
      // better than managing it.
      expect(f.rechargeSec, `${engine} boost recharge`).toBeGreaterThan(f.activeSec);
      expect(f.rechargeSec, `${engine} boost recharge`).toBeLessThan(12);
    }
  });
});

import { beforeAll, describe, expect, it } from "vitest";

import { ConfigService } from "../core/ConfigService.js";
import type { ModuleConfig, ShipConfig } from "../schemas/index.js";
import { ArenaSimulation } from "./ArenaSimulation.js";
import type { EntityId } from "./components.js";
import { loadTestConfigs, pinLock } from "./testutil.js";

/**
 * ROADMAP §11 6.1 — "energy/heat sim over scripted 60 s engagements
 * (regression-guards balance)" + "TTK sanity bounds".
 *
 * These are BALANCE guards, not unit tests. They freeze the *shape* of the
 * capacitor/heat curves and the time-to-kill of the shipped fittings, so a
 * tuning change to a module, a ship core or the heat model that moves the game
 * outside its intended feel fails CI instead of shipping silently.
 *
 * Reading a failure:
 *  - a BAND violation means a content/tuning change moved a curve. If that was
 *    intentional, re-record the literal in the same commit as the content change
 *    so the diff shows the balance intent.
 *  - an INVARIANT failure (negative energy, energy above capacity, negative
 *    heat, TTK outside the hard floor/ceiling) means something is actually broken.
 *
 * Determinism: every scenario runs on a private, asteroid-free bench arena with
 * a fixed 30 Hz tick, a fully scripted order stream and no RNG consumer, so the
 * numbers reproduce exactly on any machine (there is an explicit test for that).
 */

const DT = 1 / 30;
const TPS = 30;
const ENGAGEMENT_SECONDS = 60;

const BENCH_ARENA = "arena.balance-bench";
const BENCH_MODE = "gamemode.balance-bench";
/** Synthetic module used only by the heat-model stress bench (see below). */
const HOT_LASER = "module.bench-hotlaser";

/** Absolute tolerance on a recorded 0..1 fraction. */
const BAND = 0.06;

let configs: ConfigService;

beforeAll(async () => {
  // Private service: the bench fixtures never leak into another suite.
  configs = await loadTestConfigs();

  // A featureless disc: no asteroids ⇒ no LoS breaks, no avoidance steering, no
  // impact damage. The bench measures the energy/heat model, nothing else.
  expectReplaced(
    configs.replace({
      id: BENCH_ARENA,
      type: "arena",
      version: 1,
      name: "Balance Bench",
      // Largest schema-valid bubble with the default 20-unit projectile margin.
      // Boundary warning does not alter motion, preserving the bench trajectories.
      bounds: { shape: "sphere", radius: 307.67 },
      asteroidPlacements: [],
      spawnPoints: [
        { id: "b0", team: 0, position: { x: 0, z: 0 }, heading: 0 },
        { id: "b1", team: 1, position: { x: 22, z: 0 }, heading: Math.PI },
      ],
    }),
  );

  // Long time limit + elimination disabled: a scenario must always run its full
  // script, never get cut short by a win condition.
  expectReplaced(
    configs.replace({
      id: BENCH_MODE,
      type: "gamemode",
      version: 1,
      name: "Balance Bench",
      teams: "1v1",
      winCondition: { type: "timeLimit", seconds: 3600 },
      eliminationEndsMatch: false,
      respawn: { enabled: false, delay: 0 },
      boundaryRule: { type: "warning" },
      rewards: { win: 0, loss: 0, perKill: 0 },
    }),
  );

  // Heat-model stress fixture: unlike every shipped weapon, this one out-paces
  // the interceptor's 9/s dissipation, so it exercises accumulation → overheat →
  // cooldown → resume. Guards the MODEL independently of shipped balance.
  expectReplaced(
    configs.replace({
      id: HOT_LASER,
      type: "module",
      version: 1,
      family: "laser",
      level: 1,
      name: "Bench Hot Laser",
      activation: { deployTime: 0, retractTime: 0 },
      energy: { drawIdle: 1, drawActive: 4 },
      heat: { perSecondActive: 240, overheatThreshold: 40, overheatCooldown: 4, overheatSelfDamage: 0 },
      fire: {
        mode: "held",
        range: 38,
        cycleTime: 0.2,
        damage: 1,
        damageType: "energy",
        requiresLineOfSight: true,
        projectile: null,
      },
      ui: { icon: "h", label: "Hot" },
      price: 0,
      requiresLevel: 1,
    }),
  );
});

function expectReplaced(result: { ok: boolean; errors: unknown[] }): void {
  if (!result.ok) throw new Error(`bench fixture rejected: ${JSON.stringify(result.errors)}`);
}

const fittingOf = (shipId: string): readonly string[] => configs.get<ShipConfig>("ship", shipId)!.defaultFitting;

const isWeapon = (moduleId: string): boolean => Boolean(configs.get<ModuleConfig>("module", moduleId)?.fire);

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}

// --------------------------------------------------------------------------
// Scripted 60 s engagement bench
// --------------------------------------------------------------------------

/** One scripted order, timestamped in whole seconds so a script reads as a timeline. */
interface ScriptStep {
  at: number;
  toggle?: number;
  flight?: { throttle: number; turn: number; boost: boolean };
}

interface Trajectory {
  /** capacitor.cur / capacitor.max sampled at {@link CHECKPOINTS}. */
  energy: number[];
  /** Lowest capacitor fraction seen at any tick. */
  energyFloor: number;
  /**
   * Highest heat any single module reached, as a fraction of its own
   * `overheatThreshold` — the number that actually decides whether a fitting
   * cooks itself, unlike the ship pool which is a sum over modules.
   */
  peakModuleHeat: number;
  /** Highest ship heat pool fraction (pool / heat.capacity) seen at any tick. */
  peakPoolHeat: number;
  /** Times a subject module was forced `overheated`. */
  overheats: number;
  /** Times the capacitor bottomed out and a module was force-retracted. */
  brownOuts: number;
}

const CHECKPOINTS = [5, 10, 20, 30, 40, 50, 60];

/**
 * Run `script` for the subject in a mutual 60 s duel: the opponent has every
 * weapon hot and the subject locked, and BOTH hulls are restored each tick, so
 * the fight never ends and shields keep absorbing (the only way a shield module
 * generates heat). Everything except the scripted orders is fixed.
 */
function runEngagement(shipId: string, script: readonly ScriptStep[], opponentShip = "ship.brawler"): Trajectory {
  const sim = new ArenaSimulation(configs, BENCH_ARENA, BENCH_MODE, 1);
  const subject = sim.spawnPlayerAt(shipId, fittingOf(shipId), 0, { x: 0, z: 0 }, 0);
  const opponent = sim.spawnPlayerAt(opponentShip, fittingOf(opponentShip), 1, { x: 22, z: 0 }, Math.PI);
  // No target orders: targeting is automatic (FLIGHT.md §2). Both hulls are nose
  // to nose inside each other's sensor cone, so each picks the other on tick 1.

  // Opponent fires from tick 0 — it is pressure, not a participant in the script.
  for (const m of sim.world.modules.get(opponent)!.modules) {
    if (isWeapon(m.moduleId)) m.state = "active";
  }
  sim.applyOrder(subject, { kind: "flight", throttle: 0, turn: 0, boost: false, fire: true });
  sim.applyOrder(opponent, { kind: "flight", throttle: 0, turn: 0, boost: false, fire: true });

  const byTick = new Map<number, ScriptStep[]>();
  for (const step of script) {
    const tick = Math.round(step.at * TPS);
    byTick.set(tick, [...(byTick.get(tick) ?? []), step]);
  }

  const traj: Trajectory = {
    energy: [],
    energyFloor: 1,
    peakModuleHeat: 0,
    peakPoolHeat: 0,
    overheats: 0,
    brownOuts: 0,
  };
  const checkpointTicks = new Set(CHECKPOINTS.map((s) => s * TPS));
  const subjectCore = sim.world.shipCores.get(subject)!;
  const opponentCore = sim.world.shipCores.get(opponent)!;
  const thresholds = new Map(
    sim.world.modules
      .get(subject)!
      .modules.map((m) => [m.hardpointIndex, configs.get<ModuleConfig>("module", m.moduleId)!.heat.overheatThreshold]),
  );

  for (let tick = 0; tick <= ENGAGEMENT_SECONDS * TPS; tick++) {
    for (const step of byTick.get(tick) ?? []) {
      if (step.toggle !== undefined) sim.applyOrder(subject, { kind: "moduleToggle", hardpointIndex: step.toggle });
      if (step.flight) sim.applyOrder(subject, { kind: "flight", ...step.flight, fire: true });
    }
    // Immortal sparring partners: the bench measures upkeep, not lethality.
    subjectCore.hull = subjectCore.hullMax;
    opponentCore.hull = opponentCore.hullMax;
    // Locks pinned every tick (FLIGHT.md §2): this bench measures the upkeep
    // curve, so the guns must never fall silent for a targeting reason. Lock
    // behaviour has its own tests.
    pinLock(sim.world, subject);
    pinLock(sim.world, opponent);

    const eventsBefore = sim.world.events.length;
    sim.tick(DT);
    for (const e of sim.world.events.slice(eventsBefore)) {
      if (e.type === "overheated" && e.entityId === subject) traj.overheats++;
      // active → retracted with no `retracting` step is the brown-out signature.
      if (e.type === "moduleStateChanged" && e.entityId === subject && e.from === "active" && e.to === "retracted") {
        traj.brownOuts++;
      }
    }
    sim.getEvents();

    // Hard invariants, every tick of every scenario.
    expect(subjectCore.capacitor.cur).toBeGreaterThanOrEqual(0);
    expect(subjectCore.capacitor.cur).toBeLessThanOrEqual(subjectCore.capacitor.max + 1e-9);
    expect(subjectCore.heat.cur).toBeGreaterThanOrEqual(0);

    const energyFraction = subjectCore.capacitor.cur / subjectCore.capacitor.max;
    if (energyFraction < traj.energyFloor) traj.energyFloor = energyFraction;
    traj.peakPoolHeat = Math.max(traj.peakPoolHeat, subjectCore.heat.cur / subjectCore.heat.capacity);
    for (const m of sim.world.modules.get(subject)!.modules) {
      expect(m.heat).toBeGreaterThanOrEqual(0);
      traj.peakModuleHeat = Math.max(traj.peakModuleHeat, m.heat / thresholds.get(m.hardpointIndex)!);
    }

    if (checkpointTicks.has(tick)) traj.energy.push(round(energyFraction));
  }
  traj.energyFloor = round(traj.energyFloor);
  traj.peakModuleHeat = round(traj.peakModuleHeat);
  traj.peakPoolHeat = round(traj.peakPoolHeat);
  return traj;
}

/** Assert a measured curve sits inside its recorded band, checkpoint by checkpoint. */
function expectWithinBand(label: string, measured: readonly number[], recorded: readonly number[]): void {
  expect(measured.length, `${label}: checkpoint count`).toBe(recorded.length);
  measured.forEach((value, i) => {
    expect(
      Math.abs(value - recorded[i]!) <= BAND,
      `${label} @${CHECKPOINTS[i]}s: ${value} outside ${recorded[i]} ±${BAND} — re-record if this balance change is intentional`,
    ).toBe(true);
  });
}

const expectNear = (label: string, value: number, recorded: number, band = BAND): void => {
  expect(Math.abs(value - recorded) <= band, `${label}: ${value} outside ${recorded} ±${band}`).toBe(true);
};

/**
 * Sustained brawl: every hardpoint up early and held, one cycled off and back
 * on, boost pulsed in three-second bursts. The "everything on" worst case for
 * the capacitor.
 *
 * The burst legs used to be tap-to-move dashes whose length the arrival logic
 * decided for us; move orders retired with FLIGHT.md §7, so the bursts are now
 * explicit and the SUSTAINED anchors below were re-recorded against them. What
 * the bench asserts is unchanged — upkeep curve, brown-out count, class
 * ordering — only the script that produces it is written in flight vocabulary.
 *
 * Scripts address HARDPOINT INDICES, exactly like a player's thumb does, so the
 * same script runs on every hull; a toggle for an index a hull does not have is
 * a documented no-op (see `ModuleSystem.test.ts`). Index 4 therefore only does
 * something on the five-hardpoint brawler.
 */
const SUSTAINED: ScriptStep[] = [
  // Weapons spawn ONLINE and internals are always on (2026-07-31), so the
  // script no longer deploys anything — "everything on" holds from tick 0. What
  // it still does is REST a rack for a stretch and pulse boost, which is what
  // the upkeep curve is measuring. Only hardpoint indices (0..3) are addressed:
  // slots 4+ are the internal bay on every hull, and toggling a ship's own
  // engine or generator is not a thing a pilot does.
  { at: 3, toggle: 3 },
  { at: 5, toggle: 2 },
  // Boost bursts, three seconds each. Throttle stays at 0 so the burst is a
  // pure energy/heat event: `resolveBoostMult` charges `drawActive` + boost heat
  // whenever boost is REQUESTED and the module is hot, and the bench wants that
  // upkeep without the range/LoS drift a 40-unit dash would smuggle in.
  { at: 6, toggle: 3, flight: { throttle: 0, turn: 0, boost: true } },
  { at: 9, flight: { throttle: 0, turn: 0, boost: false } },
  { at: 12, flight: { throttle: 0, turn: 0, boost: true } },
  { at: 15, flight: { throttle: 0, turn: 0, boost: false } },
  { at: 18, flight: { throttle: 0, turn: 0, boost: true } },
  { at: 21, flight: { throttle: 0, turn: 0, boost: false } },
  { at: 24, toggle: 3 },
  { at: 30, toggle: 2 },
  { at: 42, toggle: 2 },
  { at: 54, toggle: 0 },
];

/**
 * Disciplined skirmish: one weapon at a time, shield only in bursts, no boost.
 * The "playing well is rewarded" curve. Weapons spawn online, so discipline is
 * now expressed by RESTING the rack you are not using — the toggles below
 * produce exactly the same active windows as the pre-2026-07-31 script did:
 * laser [0,8] and [34,44], missile [12,20] and [48,58], shield [24,30].
 */
const DISCIPLINED: ScriptStep[] = [
  { at: 0, toggle: 1 }, // missile rack rested at the bell — laser only
  { at: 8, toggle: 0 }, // laser rested
  { at: 12, toggle: 1 },
  { at: 20, toggle: 1 },
  { at: 24, toggle: 2 },
  { at: 30, toggle: 2 },
  { at: 34, toggle: 0 },
  { at: 44, toggle: 0 },
  { at: 48, toggle: 1 },
  { at: 58, toggle: 1 },
];

describe("scripted 60 s engagements — energy/heat regression bands", () => {
  // Anchors re-recorded 2026-07-31 for the INTERNAL BAY: hulls now carry a
  // fixed systems block (engine/generator/transformer/heatsink/sensors) and far
  // fewer weapon hardpoints — light 2, medium 3, heavy 4 — so the upkeep curves
  // are a different shape entirely. The stock internals draw no idle power,
  // which is why the light and medium hulls now hold their capacitor; the heavy
  // still out-draws its plant with four racks firing.
  it("interceptor, sustained brawl (all four hardpoints, boost pulses)", () => {
    const t = runEngagement("ship.interceptor", SUSTAINED);
    expectWithinBand("interceptor sustained energy", t.energy, [1, 1, 1, 1, 1, 1, 1]);
    expectNear("interceptor sustained energy floor", t.energyFloor, 0.997);
    // Two racks on a light hull: sustained fire still cooks them, but the
    // capacitor comfortably keeps up.
    expect(t.overheats).toBe(3);
    expect(t.brownOuts).toBe(4);
  });

  it("interceptor, disciplined skirmish (one weapon at a time)", () => {
    const t = runEngagement("ship.interceptor", DISCIPLINED);
    expectWithinBand("interceptor disciplined energy", t.energy, [1, 1, 1, 1, 1, 1, 1]);
    expectNear("interceptor disciplined energy floor", t.energyFloor, 0.997);
    expect(t.overheats).toBe(0);
    expect(t.brownOuts).toBe(1);
  });

  it("brawler, sustained brawl — five hardpoints out-draw one capacitor", () => {
    const t = runEngagement("ship.brawler", SUSTAINED, "ship.interceptor");
    expectWithinBand("brawler sustained energy", t.energy, [0.929, 0.998, 1, 0.792, 0.487, 0.167, 0.265]);
    expectNear("brawler sustained energy floor", t.energyFloor, 0);
    // The heavy CANNOT run everything at once: four racks out-draw its plant,
    // it browns out, and those racks trade overheat lockouts all match long.
    expect(t.brownOuts).toBe(1);
    expect(t.overheats).toBe(10);
  });

  it("support, sustained brawl (big capacitor, strong dissipation)", () => {
    const t = runEngagement("ship.support", SUSTAINED, "ship.interceptor");
    expectWithinBand("support sustained energy", t.energy, [0.998, 0.982, 0.966, 0.94, 1, 0.975, 0.99]);
    expectNear("support sustained energy floor", t.energyFloor, 0.939);
    // The support's strong dissipation still keeps its racks under threshold.
    expect(t.overheats).toBe(0);
    expect(t.brownOuts).toBe(2);
  });

  it("keeps the class fantasy on upkeep: dissipation and capacitor still separate the hulls", () => {
    const support = runEngagement("ship.support", SUSTAINED, "ship.interceptor");
    const interceptor = runEngagement("ship.interceptor", SUSTAINED);
    const brawler = runEngagement("ship.brawler", SUSTAINED, "ship.interceptor");
    // With the internal bay in place the hulls separate on BOTH axes again: the
    // heavy's four racks starve its plant where the lighter hulls hold theirs,
    // and the support's dissipation keeps it cool where the others cook.
    expect(support.overheats).toBe(0);
    expect(interceptor.overheats).toBeGreaterThan(0);
    expect(brawler.overheats).toBeGreaterThan(interceptor.overheats);
    expect(brawler.energyFloor).toBeLessThan(support.energyFloor);
    expect(brawler.energyFloor).toBeLessThan(interceptor.energyFloor);
  });

  it("keeps the design contract: holding everything on costs more than cycling", () => {
    const sustained = runEngagement("ship.interceptor", SUSTAINED);
    const disciplined = runEngagement("ship.interceptor", DISCIPLINED);
    expect(sustained.energyFloor).toBeLessThanOrEqual(disciplined.energyFloor);
    expect(disciplined.energyFloor).toBeGreaterThan(0.5); // discipline never starves
    expect(sustained.peakModuleHeat).toBeGreaterThan(disciplined.peakModuleHeat);
    // An overheat may exceed its threshold by at most one tick's generation —
    // and brown-outs (not hull damage) are the relief valve for the capacitor,
    // so a legal all-on fit is still never an instant self-destruct.
    expect(sustained.peakModuleHeat).toBeLessThan(1.1);
    expect(disciplined.overheats).toBe(0);
  });

  it("a 60 s all-on engagement stays survivable: pool heat never goes critical", () => {
    // Heat now BINDS on the shipped fittings (that is the point of the rework):
    // individual racks trip and re-arm, but the SHIP pool must stay well under
    // the critical-damage line and the capacitor invariants hold every tick.
    for (const ship of ["ship.interceptor", "ship.brawler", "ship.support"]) {
      const t = runEngagement(ship, SUSTAINED, ship === "ship.brawler" ? "ship.interceptor" : "ship.brawler");
      expect(t.peakPoolHeat, `${ship} pool heat`).toBeLessThan(0.75);
    }
  });

  it("is bit-for-bit reproducible across runs", () => {
    const a = runEngagement("ship.interceptor", SUSTAINED);
    const b = runEngagement("ship.interceptor", SUSTAINED);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("heat model stress (synthetic fitting that out-paces dissipation)", () => {
  /** Interceptor flying the bench hot laser on its nose hardpoint, nothing else. */
  const HOT_FITTING = [HOT_LASER];

  function runHot(seconds: number): {
    overheats: number;
    peakHeat: number;
    statesSeen: string[];
    finalState: string;
    finalHeat: number;
  } {
    const sim = new ArenaSimulation(configs, BENCH_ARENA, BENCH_MODE, 1);
    const subject = sim.spawnPlayerAt("ship.interceptor", HOT_FITTING, 0, { x: 0, z: 0 }, 0);
    const target = sim.spawnPlayerAt("ship.brawler", fittingOf("ship.brawler"), 1, { x: 22, z: 0 }, Math.PI);
    // The hot laser spawns ONLINE (weapons do since 2026-07-31) — no toggle.
    sim.applyOrder(subject, { kind: "flight", throttle: 0, turn: 0, boost: false, fire: true });

    const targetCore = sim.world.shipCores.get(target)!;
    const mod = sim.world.modules.get(subject)!.modules[0]!;
    const statesSeen = new Set<string>();
    let overheats = 0;
    let peakHeat = 0;

    for (let tick = 0; tick < seconds * TPS; tick++) {
      targetCore.hull = targetCore.hullMax;
      const before = sim.world.events.length;
      sim.tick(DT);
      for (const e of sim.world.events.slice(before)) {
        if (e.type === "overheated" && e.entityId === subject) overheats++;
      }
      sim.getEvents();
      statesSeen.add(mod.state);
      peakHeat = Math.max(peakHeat, mod.heat);
      expect(mod.heat).toBeGreaterThanOrEqual(0);
      // A module may exceed its threshold within the tick it trips, but never
      // by more than one tick's worth of generation.
      expect(mod.heat).toBeLessThanOrEqual(40 + 240 * DT + 1e-9);
    }
    return { overheats, peakHeat: round(peakHeat), statesSeen: [...statesSeen].sort(), finalState: mod.state, finalHeat: round(mod.heat) };
  }

  it("accumulates past the threshold, forces the module offline, then re-arms", () => {
    const r = runHot(20);
    expect(r.overheats).toBeGreaterThan(1);
    expect(r.statesSeen).toContain("overheated");
    // Weapons re-arm straight to active after the lockout (2026-07-31) — the
    // module never passes through retracted any more.
    expect(r.statesSeen).toContain("active");
    expect(r.statesSeen).not.toContain("retracted");
    expect(r.peakHeat).toBeGreaterThan(40);
  });

  it("cycles overheat → 4 s lockout → straight back online at a stable, recorded rate", () => {
    // 60 s at cycleTime 0.2 / 240 heat-per-second-of-work / 9 dissipation:
    // the rack trips, sits out its 4 s cooldown, comes back ONLINE (weapons
    // auto-re-arm) and immediately starts climbing again — a stable
    // trip/lockout/resume duty cycle, eleven times in a minute.
    const r = runHot(60);
    expect(r.overheats).toBe(11);
    expect(["active", "overheated"]).toContain(r.finalState);
    expect(r.statesSeen).toEqual(["active", "overheated"]);
  });
});

// --------------------------------------------------------------------------
// TTK sanity bounds
// --------------------------------------------------------------------------

/** Hard design floor: no default fitting may delete a hull faster than this. */
const TTK_HARD_FLOOR_S = 1.5;
/** Hard design ceiling: a full-offence engagement must resolve inside a minute. */
const TTK_HARD_CEILING_S = 60;
/** Regression band around each recorded TTK, as a fraction of the recorded value. */
const TTK_BAND = 0.25;

/**
 * Ticks allowed for the sensor lock to complete before the TTK clock starts. The
 * slowest hull locks in 2.2 s; a pair that cannot lock at all (out of sensor
 * range) burns this window without firing and then reports Infinity as before.
 */
const LOCK_WARMUP_TICKS = 5 * TPS;

/**
 * Advance until `shooter` holds a lock, or the warm-up window expires. Nothing
 * can fire before the lock completes (FLIGHT.md §2), so this window is dead time
 * for every measurement below — running it before the clock starts keeps the
 * recorded TTKs measuring what they always measured: time-to-kill once engaged.
 */
function warmUpLock(sim: ArenaSimulation, shooter: EntityId): void {
  for (let t = 0; t < LOCK_WARMUP_TICKS; t++) {
    if (sim.world.targets.get(shooter)?.locked) return;
    sim.tick(DT);
    sim.getEvents();
  }
}

/**
 * Seconds for `attacker` (default fitting, every weapon already deployed, target
 * locked) to destroy a stationary `defender` whose modules stay offline, at
 * `range` world units. `Infinity` if the defender survives the ceiling.
 */
function timeToKill(
  attackerShip: string,
  defenderShip: string,
  range: number,
  semiRepullTicks?: number,
): number {
  const sim = new ArenaSimulation(configs, BENCH_ARENA, BENCH_MODE, 1);
  const attacker = sim.spawnPlayerAt(attackerShip, fittingOf(attackerShip), 0, { x: 0, z: 0 }, 0);
  const defender = sim.spawnPlayerAt(defenderShip, fittingOf(defenderShip), 1, { x: range, z: 0 }, Math.PI);
  for (const m of sim.world.modules.get(attacker)!.modules) {
    if (isWeapon(m.moduleId)) m.state = "active";
  }
  warmUpLock(sim, attacker);
  sim.applyOrder(attacker, { kind: "flight", throttle: 0, turn: 0, boost: false, fire: true });

  for (let tick = 1; tick <= TTK_HARD_CEILING_S * TPS; tick++) {
    if (semiRepullTicks && tick % semiRepullTicks === 0) {
      sim.applyOrder(attacker, { kind: "flight", throttle: 0, turn: 0, boost: false, fire: false });
    } else if (semiRepullTicks && tick % semiRepullTicks === 1 && tick > 1) {
      sim.applyOrder(attacker, { kind: "flight", throttle: 0, turn: 0, boost: false, fire: true });
    }
    sim.tick(DT);
    sim.getEvents();
    if (!sim.hasShip(defender as EntityId)) return round(tick / TPS);
  }
  return Infinity;
}

describe("TTK sanity bounds (default fittings, weapons hot)", () => {
  // Re-recorded 2026-07-31: authored heatPerShot means long grinds (notably
  // interceptor vs brawler) now include one or more 3 s overheat lockouts.
  const MATRIX: Array<[attacker: string, defender: string, range: number, recorded: number]> = [
    ["ship.interceptor", "ship.interceptor", 22, 3.5],
    ["ship.interceptor", "ship.brawler", 22, 10.433],
    ["ship.brawler", "ship.interceptor", 22, 2.2],
    ["ship.brawler", "ship.brawler", 22, 5.667],
    ["ship.support", "ship.interceptor", 22, 3.5],
  ];

  it.each(MATRIX)("%s vs %s at %i units", (attacker, defender, range, recorded) => {
    const ttk = timeToKill(attacker, defender, range);
    // Hard bounds encode design intent and must hold whatever the tuning is:
    // never a one-shot delete, never an unresolvable stalemate.
    expect(ttk).toBeGreaterThan(TTK_HARD_FLOOR_S);
    expect(ttk).toBeLessThan(TTK_HARD_CEILING_S);
    // The band catches a change that is still "legal" but reshapes play.
    expect(
      Math.abs(ttk - recorded) / recorded <= TTK_BAND,
      `${attacker} vs ${defender}: TTK ${ttk}s outside ${recorded}s ±${TTK_BAND * 100}%`,
    ).toBe(true);
  });

  it("records a deliberate missile re-pull bench beside the always-held anchor", () => {
    // Mk I missiles cycle every 2.5 s = 75 sim ticks. Release on tick 75 and
    // re-press on 76 so each cooled rack receives a new semi-auto rising edge.
    const repullTicks = 75;
    const recorded = 7.833; // re-recorded 2026-07-31 (internal bay)
    const ttk = timeToKill("ship.interceptor", "ship.brawler", 22, repullTicks);
    expect(ttk).toBeLessThan(timeToKill("ship.interceptor", "ship.brawler", 22));
    expect(
      Math.abs(ttk - recorded) / recorded <= TTK_BAND,
      `interceptor semi re-pull vs brawler: TTK ${ttk}s outside ${recorded}s ±${TTK_BAND * 100}%`,
    ).toBe(true);
  });

  it("keeps the class fantasy: the heavy out-trades the light and tanks longer", () => {
    const lightKillsHeavy = timeToKill("ship.interceptor", "ship.brawler", 22);
    const heavyKillsLight = timeToKill("ship.brawler", "ship.interceptor", 22);
    expect(heavyKillsLight).toBeLessThan(lightKillsHeavy);
    expect(timeToKill("ship.brawler", "ship.brawler", 22)).toBeGreaterThan(timeToKill("ship.interceptor", "ship.interceptor", 22));
  });

  it("nobody dies out of range", () => {
    // Past every default weapon's reach (missile-mk1 is the longest at 55).
    expect(timeToKill("ship.interceptor", "ship.interceptor", 120)).toBe(Infinity);
  });

  it("an active shield measurably extends survival", () => {
    // The heavy is the hull under test here: since the internal bay landed
    // (2026-07-31) the light hull's two hardpoints carry no shield at all.
    const sim = new ArenaSimulation(configs, BENCH_ARENA, BENCH_MODE, 1);
    const attacker = sim.spawnPlayerAt("ship.interceptor", fittingOf("ship.interceptor"), 0, { x: 0, z: 0 }, 0);
    const defender = sim.spawnPlayerAt("ship.brawler", fittingOf("ship.brawler"), 1, { x: 22, z: 0 }, Math.PI);
    for (const m of sim.world.modules.get(attacker)!.modules) {
      if (isWeapon(m.moduleId)) m.state = "active";
    }
    // Defender raises its shield (hardpoint 3 on the heavy hull) and holds it.
    sim.applyOrder(defender, { kind: "moduleToggle", hardpointIndex: 3 });
    warmUpLock(sim, attacker); // same pre-engagement window as timeToKill()
    sim.applyOrder(attacker, { kind: "flight", throttle: 0, turn: 0, boost: false, fire: true });

    let shieldedTtk = Infinity;
    for (let tick = 1; tick <= TTK_HARD_CEILING_S * TPS; tick++) {
      sim.tick(DT);
      sim.getEvents();
      if (!sim.hasShip(defender)) {
        shieldedTtk = round(tick / TPS);
        break;
      }
    }
    expect(shieldedTtk).toBeGreaterThan(timeToKill("ship.interceptor", "ship.brawler", 22));
    expect(shieldedTtk).toBeLessThanOrEqual(TTK_HARD_CEILING_S);
  });
});

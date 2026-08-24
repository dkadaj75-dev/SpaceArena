import { beforeAll, describe, expect, it } from "vitest";

import { ConfigService } from "../core/ConfigService.js";
import type { ModuleConfig, ShipConfig } from "../schemas/index.js";
import { ArenaSimulation } from "./ArenaSimulation.js";
import type { EntityId } from "./components.js";
import { loadTestConfigs, pinLock } from "./testutil.js";

/**
 * ROADMAP §11 6.1 — "energy sim over scripted 60 s engagements
 * (regression-guards balance)" + "TTK sanity bounds".
 *
 * These are BALANCE guards, not unit tests. They freeze the *shape* of the
 * per-module energy curves and the time-to-kill of the shipped fittings, so a
 * tuning change to a module or a ship core that moves the game outside its
 * intended feel fails CI instead of shipping silently.
 *
 * ## What the 2026-08-07 rebuild fixed
 *
 * The previous bench could not fail. It restored BOTH hulls every tick, so the
 * self-inflicted hull loss that dominated real matches was invisible; and
 * `timeToKill()` looped until the DEFENDER died, reporting `Infinity` when it
 * was in fact the ATTACKER that had died — which is how four of five stock
 * matchups came to be recorded as "unkillable" and asserted as correct.
 *
 * Both holes are closed here, and the closure is the point:
 *
 *  - {@link runEngagement} never touches hull. It MEASURES hull instead, and
 *    asserts that a ship holding its trigger at a target that cannot reach it
 *    loses no hull at all. Under the new model nothing a pilot fires can hurt
 *    their own ship — that invariant is now a test rather than a hope.
 *  - {@link timeToKill} returns a discriminated {@link KillResult}. An attacker
 *    dying is `attackerDied` and fails loudly; nothing collapses to `Infinity`.
 *  - The TTK matrix forbids `Infinity` outright: every stock matchup must
 *    resolve, and inside the 8–45 s design band.
 *
 * Reading a failure:
 *  - a BAND violation means a content/tuning change moved a curve. If that was
 *    intentional, re-record the literal in the same commit as the content change
 *    so the diff shows the balance intent.
 *  - an INVARIANT failure (a tank over capacity, self-inflicted
 *    hull loss, a TTK outside the band) means something is actually broken.
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
/** Absolute tolerance on a recorded 0..1 fraction. */
const BAND = 0.06;

let configs: ConfigService;

beforeAll(async () => {
  // Private service: the bench fixtures never leak into another suite.
  configs = await loadTestConfigs();

  // A featureless disc: no asteroids ⇒ no LoS breaks, no avoidance steering, no
  // impact damage. The bench measures the energy model, nothing else.
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
});

function expectReplaced(result: { ok: boolean; errors: unknown[] }): void {
  if (!result.ok) throw new Error(`bench fixture rejected: ${JSON.stringify(result.errors)}`);
}

const fittingOf = (shipId: string): readonly string[] => configs.get<ShipConfig>("ship", shipId)!.defaultFitting;

const isWeapon = (moduleId: string): boolean => Boolean(configs.get<ModuleConfig>("module", moduleId)?.fire);

/** The fitted-slot index of a spawned ship's shield module (throws if it has none). */
function shieldSlotOf(sim: ArenaSimulation, entityId: EntityId): number {
  for (const m of sim.world.modules.get(entityId)!.modules) {
    if (configs.get<ModuleConfig>("module", m.moduleId)?.mitigation) return m.hardpointIndex;
  }
  throw new Error(`ship ${entityId} carries no shield module`);
}

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
  /** Emptiest module tank (0..1 of its own capacity) sampled at {@link CHECKPOINTS}. */
  energy: number[];
  /** Lowest tank fraction seen at any tick. */
  energyFloor: number;
  /**
   * Hull the SUBJECT lost across the whole engagement. The opponent in this
   * bench is out of weapon range, so this is self-inflicted damage and the
   * whole scenario asserts it is zero — the failure the old bench could not see
   * (it restored hull every tick and therefore measured nothing).
   */
  hullLost: number;
}

const CHECKPOINTS = [5, 10, 20, 30, 40, 50, 60];

/**
 * Run `script` for the subject for 60 s with the trigger held and every module
 * it toggles honoured, against a DISARMED sparring partner at knife range.
 *
 * The partner is scenery: its hull is restored every tick so the scenario always
 * runs its full minute, and it carries no live weapon, so it can never touch the
 * subject. The SUBJECT is never restored and never healed. Any hull it loses is
 * therefore its own doing — which is the exact measurement the pre-overhaul
 * bench threw away by restoring both hulls, and the reason it certified a
 * catalogue in which 58.8% of all damage was self-inflicted.
 */
function runEngagement(
  shipId: string,
  script: readonly ScriptStep[],
  opponentShip = "ship.brawler",
  opts: { returnFire?: boolean } = {},
): Trajectory {
  const sim = new ArenaSimulation(configs, BENCH_ARENA, BENCH_MODE, 1);
  const subject = sim.spawnPlayerAt(shipId, fittingOf(shipId), 0, { x: 0, z: 0 }, 0);
  const opponent = sim.spawnPlayerAt(opponentShip, fittingOf(opponentShip), 1, { x: 22, z: 0 }, Math.PI);
  // Disarm the partner outright: this bench measures the subject's upkeep, and
  // an unattributable point of hull loss would defeat its whole purpose. The one
  // exception is the LIVE-PROBE scenario below, which needs the partner shooting
  // to prove `hullLost` is still wired to anything at all.
  for (const m of sim.world.modules.get(opponent)!.modules) {
    if (isWeapon(m.moduleId)) m.state = opts.returnFire ? "active" : "retracted";
  }
  // No target orders: targeting is automatic (FLIGHT.md §2).
  sim.applyOrder(subject, { kind: "flight", throttle: 0, turn: 0, boost: false, fire: true });
  if (opts.returnFire) sim.applyOrder(opponent, { kind: "flight", throttle: 0, turn: 0, boost: false, fire: true });

  const byTick = new Map<number, ScriptStep[]>();
  for (const step of script) {
    const tick = Math.round(step.at * TPS);
    byTick.set(tick, [...(byTick.get(tick) ?? []), step]);
  }

  const traj: Trajectory = {
    energy: [],
    energyFloor: 1,
    hullLost: 0,
  };
  const checkpointTicks = new Set(CHECKPOINTS.map((s) => s * TPS));
  const subjectCore = sim.world.shipCores.get(subject)!;
  const opponentCore = sim.world.shipCores.get(opponent)!;
  const startHull = subjectCore.hull;

  for (let tick = 0; tick <= ENGAGEMENT_SECONDS * TPS; tick++) {
    for (const step of byTick.get(tick) ?? []) {
      if (step.toggle !== undefined) sim.applyOrder(subject, { kind: "moduleToggle", hardpointIndex: step.toggle });
      if (step.flight) sim.applyOrder(subject, { kind: "flight", ...step.flight, fire: true });
    }
    // The partner is restored — it is a target, not a participant. The subject
    // never is.
    opponentCore.hull = opponentCore.hullMax;
    // Locks pinned every tick (FLIGHT.md §2): this bench measures the upkeep
    // curve, so the guns must never fall silent for a targeting reason. Lock
    // behaviour has its own tests.
    pinLock(sim.world, subject);
    if (opts.returnFire) pinLock(sim.world, opponent);

    sim.tick(DT);
    sim.getEvents();

    // A subject shot to pieces has lost all of it; there is nothing left to
    // sample. Only reachable under `returnFire`.
    if (!sim.hasShip(subject)) return { ...traj, hullLost: round(startHull), energyFloor: round(traj.energyFloor) };

    // Hard invariants, every tick of every scenario.
    let emptiest = 1;
    for (const m of sim.world.modules.get(subject)!.modules) {
      expect(m.energy).toBeGreaterThanOrEqual(0);
      expect(m.energy).toBeLessThanOrEqual(m.energyCapacity + 1e-9);
      if (m.energyCapacity > 0) emptiest = Math.min(emptiest, m.energy / m.energyCapacity);
    }
    if (emptiest < traj.energyFloor) traj.energyFloor = emptiest;
    if (checkpointTicks.has(tick)) traj.energy.push(round(emptiest));
  }

  traj.hullLost = round(startHull - subjectCore.hull);
  traj.energyFloor = round(traj.energyFloor);
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
 * Sustained brawl: every hardpoint held down, one rack rested for a stretch and
 * brought back, boost pulsed in three-second bursts. The "everything on" worst
 * case for the module tanks.
 *
 * Scripts address HARDPOINT INDICES, exactly like a player's thumb does, so the
 * same script runs on every hull; a toggle for an index a hull does not have is
 * a documented no-op (see `ModuleSystem.test.ts`).
 */
const SUSTAINED: ScriptStep[] = [
  { at: 3, toggle: 3 },
  { at: 5, toggle: 2 },
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
 * expressed by RESTING the rack you are not using.
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

describe("scripted 60 s engagements — per-module energy regression bands", () => {
  // Anchors recorded 2026-08-07, re-recorded 2026-08-20 when heat was deleted,
  // and again 2026-08-22 for the owner's per-hull combat-profile pass (each
  // hull's `core.combat` damage/rate multipliers, shipped intentionally hot for
  // testing) landing together with the module-bay rework that gave the engine
  // module its own 55-point boost tank. A held trigger still costs nothing —
  // the curve is the emptiest module tank, and what spends tanks now is BOOST
  // (the engine reserve) and a raised shield.
  it("interceptor, sustained brawl (both racks held, boost pulses)", () => {
    const t = runEngagement("ship.interceptor", SUSTAINED);
    // Since the engine module carries a boost tank, the light hull's curve is
    // no longer flat: the script's three boost pulses (6–21 s) empty the
    // reserve — the 10 s checkpoint catches it at 0.17 mid-pulse — and it is
    // refilled by 20 s and never touched again.
    expectWithinBand("interceptor sustained energy", t.energy, [1, 0.17, 1, 1, 1, 1, 1]);
    expectNear("interceptor sustained energy floor", t.energyFloor, 0);
    expect(t.hullLost).toBe(0);
  });

  it("interceptor, disciplined skirmish (one weapon at a time)", () => {
    const t = runEngagement("ship.interceptor", DISCIPLINED);
    // No boost anywhere in this script, so the boost tank never drains and the
    // light hull's curve stays flat at 1 — weapons alone still cost nothing.
    expectWithinBand("interceptor disciplined energy", t.energy, [1, 1, 1, 1, 1, 1, 1]);
    expect(t.hullLost).toBe(0);
  });

  it("brawler, sustained brawl — three racks and a shield on one hull", () => {
    const t = runEngagement("ship.brawler", SUSTAINED, "ship.interceptor");
    // Two tanks trade the minimum now: the shield (raised at t=3, drains on
    // upkeep, refills while down, raised again at t=24) and the engine's boost
    // reserve during the pulse window.
    expectWithinBand("brawler sustained energy", t.energy, [1, 0.579, 0.311, 1, 0.124, 0.743, 1]);
    expectNear("brawler sustained energy floor", t.energyFloor, 0);
    expect(t.hullLost).toBe(0);
  });

  it("support, sustained brawl (cool hull, deep tanks)", () => {
    const t = runEngagement("ship.support", SUSTAINED, "ship.interceptor");
    expectWithinBand("support sustained energy", t.energy, [1, 0.744, 0.193, 0.598, 1, 0.579, 0.027]);
    expectNear("support sustained energy floor", t.energyFloor, 0);
    expect(t.hullLost).toBe(0);
  });

  it("keeps the design contract: boost and shields are the only things a minute of fire costs", () => {
    // The 2026-08-20 form of this contract ("only a shield's tank can empty,
    // and only on a hull that carries one") died with the engine module's boost
    // tank: every stock hull now carries a spendable reserve, including the
    // light. The surviving contract is one step narrower again: holding every
    // trigger for a minute still costs nothing by itself — only BOOSTING or
    // raising a shield spends a tank. The disciplined script (no boost, and the
    // light hull ships no shield) is the boost-free control that proves it.
    const light = runEngagement("ship.interceptor", SUSTAINED);
    const lightNoBoost = runEngagement("ship.interceptor", DISCIPLINED);
    const heavy = runEngagement("ship.brawler", SUSTAINED, "ship.interceptor");
    expect(lightNoBoost.energyFloor, "a boost-free minute of fire costs the light hull nothing").toBe(1);
    expect(light.energyFloor, "the light hull's boost reserve is spendable").toBeLessThan(1);
    expect(heavy.energyFloor, "the heavy's shield reserve is spendable").toBeLessThan(1);
  });

  it("A SHIP CAN NEVER HURT ITSELF BY FIRING — the invariant the old bench could not see", () => {
    // The 2026-08-07 audit measured 58.8% of all hull damage as self-inflicted,
    // with 13 of 19 deaths self-inflicted, while this suite was
    // green. It was green because it restored hull every tick. It no longer
    // does, and this is the assertion that closes that hole for good.
    for (const ship of ["ship.interceptor", "ship.brawler", "ship.support"]) {
      const t = runEngagement(ship, SUSTAINED, ship === "ship.brawler" ? "ship.interceptor" : "ship.brawler");
      expect(t.hullLost, `${ship} self-inflicted hull loss`).toBe(0);
    }
  });

  it("PROVES THE HULL PROBE IS LIVE: the same bench records real damage when it is dealt", () => {
    // A positive control for the assertion above it. `hullLost === 0` is only
    // evidence if `hullLost` can be non-zero: restoring the subject's hull each
    // tick — the exact defect of the pre-overhaul bench — makes every
    // self-damage assertion in this suite vacuously true, and nothing else here
    // notices. So run the identical scenario against an ARMED partner and
    // require the number to move.
    const t = runEngagement("ship.interceptor", SUSTAINED, "ship.brawler", { returnFire: true });
    expect(t.hullLost, "hull probe is not wired to the subject's hull").toBeGreaterThan(0);
  });

  it("is bit-for-bit reproducible across runs", () => {
    const a = runEngagement("ship.interceptor", SUSTAINED);
    const b = runEngagement("ship.interceptor", SUSTAINED);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

// --------------------------------------------------------------------------
// TTK sanity bounds
// --------------------------------------------------------------------------

/**
 * Hard design floor: no default fitting may delete a hull faster than this.
 *
 * Rescaled 2026-08-14 with the ×1.5 weapon-DPS pass (`fire.damage` × 1.5 on
 * every weapon module, nothing else touched). The old `8` was recorded against
 * pre-pass damage, so the SAME design intent — "a hull may not evaporate" — is
 * now `8 / 1.5 ≈ 5.33`. Raising the floor back would fail on the intended
 * change rather than on a regression.
 *
 * Rescaled AGAIN the same day by the ×2 damage pass: `8 / 3 ≈ 2.67`, the
 * original intent carried through the cumulative ×3 the catalogue has taken.
 * The floor is doing real work now rather than sitting decorative — the fastest
 * cell (heavy vs light) is 4.833 s, i.e. 1.8× the floor, where before the pass
 * it sat at 1.6× a floor of 5.33. See the balance note: this is the cell to
 * watch if damage goes up again.
 */
const TTK_FLOOR_S = 2.67;
/**
 * Hard design ceiling: a stock engagement must resolve well inside a match.
 * Left at 45 through both 2026-08-14 re-records; the ×2 damage pass bought back
 * the headroom the typed-damage pass had eaten — the slowest cell (light vs
 * heavy) is 24.4 s, 54% of the ceiling, with its ±25% band topping out at 30.5 s.
 */
const TTK_CEILING_S = 45;
/** Regression band around each recorded TTK, as a fraction of the recorded value. */
const TTK_BAND = 0.25;

/**
 * Ticks allowed for the sensor lock to complete before the TTK clock starts. The
 * slowest hull locks in 2.2 s; a pair that cannot lock at all (out of sensor
 * range) burns this window without firing and then reports `neither` as before.
 */
const LOCK_WARMUP_TICKS = 5 * TPS;

/**
 * The three ways a scripted duel can end. Making `attackerDied` its own outcome
 * is the whole fix: the old helper collapsed it into `Infinity`, i.e. reported a
 * pilot who had just killed himself as evidence the DEFENDER was unkillable.
 */
type KillResult =
  | { outcome: "killed"; seconds: number }
  | { outcome: "attackerDied"; seconds: number }
  | { outcome: "neither"; seconds: number };

/**
 * Advance until `shooter` holds a lock, or the warm-up window expires. Nothing
 * can fire before the lock completes (FLIGHT.md §2), so this window is dead time
 * for every measurement below.
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
 * `range` world units — and, distinctly, whether the ATTACKER died instead.
 */
function timeToKill(
  attackerShip: string,
  defenderShip: string,
  range: number,
  // `reverse` inverts the duel: the DEFENDER shoots and the attacker is unarmed.
  // Only the attacker-death control below uses it — see that test for why the
  // discriminator needs a scenario that actually reaches it.
  opts: { reverse?: boolean } = {},
): KillResult {
  const sim = new ArenaSimulation(configs, BENCH_ARENA, BENCH_MODE, 1);
  const attacker = sim.spawnPlayerAt(attackerShip, fittingOf(attackerShip), 0, { x: 0, z: 0 }, 0);
  const defender = sim.spawnPlayerAt(defenderShip, fittingOf(defenderShip), 1, { x: range, z: 0 }, Math.PI);
  const gunner = opts.reverse ? defender : attacker;
  for (const m of sim.world.modules.get(attacker)!.modules) {
    if (isWeapon(m.moduleId)) m.state = opts.reverse ? "retracted" : "active";
  }
  if (opts.reverse) {
    for (const m of sim.world.modules.get(defender)!.modules) {
      if (isWeapon(m.moduleId)) m.state = "active";
    }
  }
  warmUpLock(sim, gunner);
  sim.applyOrder(gunner, { kind: "flight", throttle: 0, turn: 0, boost: false, fire: true });

  const observationTicks = 120 * TPS;
  for (let tick = 1; tick <= observationTicks; tick++) {
    sim.tick(DT);
    sim.getEvents();
    // ATTACKER FIRST: a bench that only ever asks "is the defender dead?"
    // reports a self-kill as an unkillable defender, which is exactly how the
    // pre-overhaul catalogue was certified.
    if (!sim.hasShip(attacker)) return { outcome: "attackerDied", seconds: round(tick / TPS) };
    if (!sim.hasShip(defender)) return { outcome: "killed", seconds: round(tick / TPS) };
  }
  return { outcome: "neither", seconds: Infinity };
}

describe("TTK sanity bounds (default fittings, weapons hot)", () => {
  // Recorded 2026-08-07 against the heat/energy overhaul. EVERY stock matchup
  // resolves — that is the acceptance bar of the overhaul, and `Infinity` is no
  // longer a legal anchor anywhere in this matrix.
  //
  // RE-RECORDED 2026-08-14 with the ×1.5 weapon-DPS pass. Only `fire.damage`
  // moved (× 1.5 on all 15 weapon modules); cycleTime, range and
  // `globalDamageMult` are untouched, which is why every anchor lands within a
  // couple of ticks of `old / 1.5` and the ORDERING of the matrix is unchanged.
  //
  // RE-RECORDED AGAIN 2026-08-14 for typed damage + clip-fed autocannons. Every
  // cell got SLOWER (+10% to +39%), which is the correct reading of this bench
  // rather than a surprise: no defender in the matrix raises its shield, so
  // every cell is a BARE-HULL trade, and on a bare hull the only typed-damage
  // term that applies is `hullMult` — 0.5 for energy, 1.0 for kinetic. Every
  // stock fitting is laser (energy) + missile (kinetic, unchanged), so each
  // attacker simply lost half of its laser contribution. The heavy's clip-fed
  // autocannon claws only part of that back, because this bench runs with the
  // heat flag ON: at the tripled cadence the mk1 rack burns in ~0.45 s and then
  // sits locked for ~2.3 s, so its sustained DPS rises far less than 3x (heavy
  // vs light 6.533 → 8.367, the smallest regression in the matrix).
  //
  // The shield side of the triangle is measured by "an active shield measurably
  // extends survival" at the bottom of this describe, not here.
  //
  // RE-RECORDED A THIRD TIME 2026-08-14, for the combat retune: `fire.damage`
  // × 2 on all 15 weapon modules, autocannon `cycleTime` halved again (6× the
  // original cadence), missile `cycleTime` doubled, and missiles re-typed from
  // kinetic to the HYBRID warhead (half kinetic, half energy). Every cell got
  // faster, by 12% to 48%, and the spread between them widened — which is the
  // arithmetic of the pass rather than a surprise:
  //
  //  - LASER contribution doubles outright (×2 damage, unchanged cadence), and
  //    on this bare-hull bench it is the whole of the light hull's output
  //    alongside the missile.
  //  - MISSILE contribution FALLS. ×2 damage against ×2 cycleTime is a wash on
  //    nominal DPS, and the hybrid warhead then lands at 0.75 hull effect
  //    instead of kinetic's 1.0 — so on a bare hull a missile rack is worth
  //    ~78% of what it was. Missiles trade sustained damage for alpha here.
  //  - AUTOCANNON contribution roughly TRIPLES on sustained fire (×2 damage,
  //    ×2 cadence, against a fixed reload), and the heavy is the only stock hull
  //    that carries one — which is why its three columns move furthest and why
  //    the heavy-vs-light cell is now the fastest kill in the matrix at 4.833 s.
  // RE-RECORDED A FOURTH TIME 2026-08-16, for the owner's blanket pass: laser
  // `fire.damage` × 2 (all seven laser-family modules, beams included) and
  // missile `fire.damage` × 3 with `cycleTime` × 4. The matrix moved exactly as
  // that arithmetic predicts:
  //
  //  - LASER-led columns collapse fastest. Lasers are energy (0.5 hullMult), so
  //    on this bare-hull bench a ×2 base is a straight ×2 contribution — the
  //    support's two-laser fit nearly halves its kill times (12.067 → 6.433
  //    against the light hull).
  //  - MISSILE sustained output FALLS to 0.75× (×3 damage over ×4 cycle) while
  //    its alpha triples — a mk1 warhead now lands 43.56 raw. On a 60 s bench
  //    that trade reads as slower, in play it reads as burstier.
  //  - The AUTOCANNON was not touched, so the brawler's own column barely moves
  //    (10.1 → 9.467 in the mirror) while everyone shooting AT it speeds up.
  //
  // RE-RECORDED A FIFTH TIME 2026-08-18, for the autocannon/laser split pass:
  // kinetic `fire.damage` × 0.8 (all four autocannon modules) and laser
  // `fire.damage` × 1.3 (all seven laser-family modules, beams included).
  // Nothing else moved — no cycleTime, no heat, no damage type. Two opposite
  // moves on two families, and the matrix separates cleanly along which family
  // each attacker actually carries:
  //
  //  - The BRAWLER's three columns barely move (3.367 → 3.233, 9.467 → 9.333,
  //    4.833 → 4.833). It is the one stock hull carrying BOTH a laser and an
  //    autocannon, so the +30% on one and the −20% on the other very nearly
  //    cancel on its output — which is the pass working as intended rather than
  //    a coincidence, and the clearest evidence in the suite that the two
  //    changes were sized against each other.
  //  - The INTERCEPTOR and SUPPORT columns collapse (−21% to −42%). Neither
  //    carries an autocannon at all, so for them this pass is a straight laser
  //    buff. The support's two-laser fit and the interceptor's laser+missile fit
  //    both lose their slowest cells hardest.
  //  - The interceptor mirror falls furthest (8.333 → 4.833, −42%) because it is
  //    the cell most exposed to MISSILE LUMPINESS: at a 9.6 s missile cycle,
  //    +30% laser is enough to finish the target on the first warhead instead of
  //    waiting out most of a second cycle. The step is large because the clock
  //    is discrete, not because the DPS change was.
  //
  // The fastest cell is now brawler vs light at 3.233 s, 1.21× the 2.67 s
  // evaporation floor (it was 1.26× before this pass). It got closer even though
  // the autocannon was NERFED, because the brawler's laser gained slightly more
  // than its cannon lost. The floor's warning from the previous re-record stands
  // and tightens: this cell has ~0.56 s of headroom left.
  //
  // RE-RECORDED 2026-08-20 — HEAT DELETED. A weapon is now limited by its own
  // `fire.cycleTime` and nothing else, so every rack that used to spend part of
  // a fight locked out now fires continuously. The catalogue has NOT been
  // retuned for that yet (a deliberate, sequenced decision), and this matrix is
  // where the debt is visible:
  //
  //  - The INTERCEPTOR and SUPPORT rows barely move (−7% to −21%). Their racks
  //    were the least heat-gated: a 9.6 s missile is limited by its shot clock,
  //    and their lasers cycled cool enough to lock rarely.
  //  - The BRAWLER row COLLAPSES (−53% to −66%). It is the one stock hull
  //    carrying a clip-fed autocannon, which under the old model reached its
  //    capacity in ~0.19 s — ONE round — and then sat locked for ~2.3 s. That
  //    lockout was ~90% of the rack's duty cycle, and deleting it multiplied the
  //    heavy's real DPS accordingly.
  //
  // Three brawler cells now sit UNDER the 2.67 s evaporation floor. They are
  // recorded as debt in {@link BELOW_FLOOR} rather than by lowering the floor,
  // because the floor is the design intent and lowering it would delete the only
  // signal that the retune is still owed. The autocannon's `fire.cycleTime` (or
  // its clip) is the knob: it is the one weapon whose authored cadence was
  // written assuming a lockout would swallow most of it.
  //
  // RE-RECORDED 2026-08-22, for the owner's per-hull combat profiles
  // (`core.combat.damageOutput` / `core.combat.rateOfFire` multipliers on all
  // four hulls, shipped INTENTIONALLY overpowered for testing — this record is
  // deliberate, not an endorsement of the tuning as final). The interceptor's
  // energy rate ×2.4 collapses its whole row (−38% to −41%); the support's
  // milder profile moves its row −10% to −11% with its vs-light cell landing on
  // the same tick; the brawler's hybrid-heavy profile actually SLOWS its row
  // (+18% to +25%), pulling its two floor-debt cells upward — still under the
  // floor, so {@link BELOW_FLOOR} is unchanged. The interceptor mirror at
  // 2.833 s now sits only 1.06× above the floor, the thinnest legal margin the
  // matrix has ever recorded: if any hull's profile heats up further, that is
  // the first cell that will trip.
  const MATRIX: Array<[attacker: string, defender: string, range: number, recorded: number]> = [
    // laser ×2 / missile ×3@¼ rate → cannon ×0.8 / laser ×1.3 → heat deleted → hull combat profiles
    ["ship.interceptor", "ship.interceptor", 22, 2.833], //   8.333 → 4.833 → 4.833 → 2.833
    ["ship.interceptor", "ship.brawler", 22, 6.333], //      16.1   → 11     → 10.133 → 6.333
    ["ship.interceptor", "ship.support", 22, 4.7], //        10.133 →  9.933 →  8.033 → 4.7
    ["ship.brawler", "ship.interceptor", 22, 1.867], //       3.367 →  3.233 →  1.533 → 1.867  ⚠ under floor
    ["ship.brawler", "ship.brawler", 22, 3.5], //             9.467 →  9.333 →  3.167 → 3.5
    ["ship.brawler", "ship.support", 22, 2.5], //             4.833 →  4.833 →  2     → 2.5    ⚠ under floor
    ["ship.support", "ship.interceptor", 22, 4.833], //       6.433 →  4.833 →  4.833 → 4.833
    ["ship.support", "ship.brawler", 22, 9.1], //            14.2   → 11     → 10.133 → 9.1
    ["ship.support", "ship.support", 22, 7.133], //          10.133 →  8.033 →  8.033 → 7.133
  ];

  /**
   * Cells KNOWN to sit under {@link TTK_FLOOR_S}, as `attacker>defender`.
   *
   * This is a retune backlog, not a permission slip. A cell may only be added
   * here deliberately, in the same commit as the change that put it there and
   * with the reason written down; the per-cell assertion below asserts the set
   * EXACTLY, so a fourth cell dropping under the floor fails, and so does a
   * listed cell that quietly climbs back over it (delete the entry — the debt
   * is paid).
   */
  const BELOW_FLOOR = new Set([
    "ship.brawler>ship.interceptor",
    "ship.brawler>ship.support",
  ]);

  it.each(MATRIX)("%s vs %s at %i units", (attacker, defender, range, recorded) => {
    const result = timeToKill(attacker, defender, range);
    // An attacker that dies is a FAILURE with its own message, never a silent
    // "the defender survived".
    expect(result.outcome, `${attacker} vs ${defender}: ended "${result.outcome}" at ${result.seconds}s`).toBe(
      "killed",
    );
    expect(result.seconds).toBeLessThan(TTK_CEILING_S);
    // The evaporation floor, asserted in BOTH directions against the recorded
    // backlog — see {@link BELOW_FLOOR}.
    expect(
      result.seconds > TTK_FLOOR_S,
      `${attacker} vs ${defender}: TTK ${result.seconds}s vs the ${TTK_FLOOR_S}s floor — ` +
        (BELOW_FLOOR.has(`${attacker}>${defender}`)
          ? "this cell is recorded as retune debt but is now ABOVE the floor; delete its BELOW_FLOOR entry"
          : "this cell has dropped BELOW the floor; fix it or record it in BELOW_FLOOR with a reason"),
    ).toBe(!BELOW_FLOOR.has(`${attacker}>${defender}`));
    // The band catches a change that is still "legal" but reshapes play.
    expect(
      Math.abs(result.seconds - recorded) / recorded <= TTK_BAND,
      `${attacker} vs ${defender}: TTK ${result.seconds}s outside ${recorded}s ±${TTK_BAND * 100}%`,
    ).toBe(true);
  });

  it("every stock matchup resolves — no unkillable pairs, no self-kills", () => {
    for (const [attacker, defender] of MATRIX) {
      const result = timeToKill(attacker, defender, 22);
      expect(result.outcome, `${attacker} vs ${defender}`).toBe("killed");
      expect(Number.isFinite(result.seconds)).toBe(true);
    }
  });

  it("PROVES THE ATTACKER-DEATH DISCRIMINATOR IS LIVE: a pilot who dies is reported as one", () => {
    // Positive control for the outcome asserted above. On the shipped catalogue
    // no attacker ever dies, so the `attackerDied` branch — the entire point of
    // the 2026-08-07 rebuild — is never reached by the matrix, and deleting it
    // leaves the whole suite green. Inverting one duel exercises it on every run,
    // so the branch cannot rot back into the `Infinity` it replaced.
    const r = timeToKill("ship.interceptor", "ship.brawler", 22, { reverse: true });
    expect(r.outcome, `an unarmed pilot under fire must read as attackerDied, got "${r.outcome}"`).toBe(
      "attackerDied",
    );
    expect(Number.isFinite(r.seconds)).toBe(true);
  });

  it("keeps the class fantasy: the heavy out-trades the light and tanks longer", () => {
    const lightKillsHeavy = timeToKill("ship.interceptor", "ship.brawler", 22);
    const heavyKillsLight = timeToKill("ship.brawler", "ship.interceptor", 22);
    expect(lightKillsHeavy.outcome).toBe("killed");
    expect(heavyKillsLight.outcome).toBe("killed");
    expect(heavyKillsLight.seconds).toBeLessThan(lightKillsHeavy.seconds);
  });

  it("nobody dies out of range", () => {
    // Past every default weapon's reach (missile-mk1 is the longest at 137.5).
    const r = timeToKill("ship.interceptor", "ship.interceptor", 200);
    expect(r.outcome).toBe("neither");
  });

  it("an active shield measurably extends survival", () => {
    // The heavy is the hull under test here: since the internal bay landed
    // (2026-07-31) the light hull's two hardpoints carry no shield at all.
    // Re-measured 2026-08-14 after the combat retune: 24.4 s bare → 25.467 s
    // shielded, i.e. the mk1 shield still buys ~4%. It only ever soaks what its
    // own 40-point tank can pay for, and against doubled damage that tank is
    // spent sooner — the HYBRID missile now presents half its warhead as energy,
    // which the shield soaks at 0.5 instead of kinetic's 0.2, so the reserve
    // drains faster for the same protection. The direction is the contract; the
    // size of the gap is balance feedback, not something this test pins.
    const measure = (raiseShield: boolean): KillResult => {
      const sim = new ArenaSimulation(configs, BENCH_ARENA, BENCH_MODE, 1);
      const attacker = sim.spawnPlayerAt("ship.interceptor", fittingOf("ship.interceptor"), 0, { x: 0, z: 0 }, 0);
      const defender = sim.spawnPlayerAt("ship.brawler", fittingOf("ship.brawler"), 1, { x: 22, z: 0 }, Math.PI);
      for (const m of sim.world.modules.get(attacker)!.modules) {
        if (isWeapon(m.moduleId)) m.state = "active";
      }
      // Find the shield rather than hardcoding its slot: which hardpoint a hull
      // carries its bubble on is content, and the 2026-08-22 pass moved it (the
      // heavy's shield is on the spine now). A pinned 3 silently toggled the
      // engine bay instead and this test measured nothing.
      if (raiseShield) sim.applyOrder(defender, { kind: "moduleToggle", hardpointIndex: shieldSlotOf(sim, defender) });
      warmUpLock(sim, attacker);
      sim.applyOrder(attacker, { kind: "flight", throttle: 0, turn: 0, boost: false, fire: true });
      for (let tick = 1; tick <= 120 * TPS; tick++) {
        sim.tick(DT);
        sim.getEvents();
        if (!sim.hasShip(attacker)) return { outcome: "attackerDied", seconds: round(tick / TPS) };
        if (!sim.hasShip(defender)) return { outcome: "killed", seconds: round(tick / TPS) };
      }
      return { outcome: "neither", seconds: Infinity };
    };
    const bare = measure(false);
    const shielded = measure(true);
    expect(bare.outcome).toBe("killed");
    expect(shielded.outcome).toBe("killed");
    expect(shielded.seconds).toBeGreaterThan(bare.seconds);
  });
});

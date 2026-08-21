import { beforeAll, describe, expect, it } from "vitest";
import type { ConfigService } from "../core/ConfigService.js";
import type { TuningConfig } from "../schemas/index.js";
import { ArenaSimulation } from "./ArenaSimulation.js";
import { DEFAULT_MATCH_COUNTDOWN_SEC, matchCountdownSecOf } from "./tuningDefaults.js";
import { INTERCEPTOR_FITTING, loadTestConfigs, setTestCountdown } from "./testutil.js";

const DT = 1 / 30;
/** The shipped `tuning.matchCountdownSec`. */
const COUNTDOWN = 3;
const TICKS = Math.round(COUNTDOWN / DT);

let configs: ConfigService;
beforeAll(async () => {
  // Explicitly the SHIPPED countdown: `loadTestConfigs` zeroes it by default for
  // every other suite, and this one is about the countdown itself.
  configs = await loadTestConfigs({ matchCountdownSec: COUNTDOWN });
});

function newSim(seed = 1): ArenaSimulation {
  const sim = new ArenaSimulation(configs, "arena.ring-nebula", "gamemode.duel-1v1", seed);
  sim.spawnPlayer("ship.interceptor", INTERCEPTOR_FITTING, 0);
  sim.spawnPlayer("ship.interceptor", INTERCEPTOR_FITTING, 1);
  return sim;
}

describe("match-start countdown — phase transitions", () => {
  it("opens in countdown with the authored seconds on the clock", () => {
    const sim = newSim();
    expect(sim.matchPhase).toBe("countdown");
    const snap = sim.snapshot();
    expect(snap.phase).toBe("countdown");
    expect(snap.countdownRemaining).toBeCloseTo(COUNTDOWN, 6);
    expect(snap.elapsed).toBe(0);
  });

  it("goes live on exactly the tick the clock runs out, and stays live", () => {
    const sim = newSim();
    for (let i = 0; i < TICKS - 1; i++) sim.tick(DT);
    expect(sim.matchPhase).toBe("countdown");
    expect(sim.countdown).toBeGreaterThan(0);

    sim.tick(DT);
    expect(sim.matchPhase).toBe("live");
    expect(sim.snapshot().countdownRemaining).toBe(0);

    sim.tick(DT);
    expect(sim.matchPhase).toBe("live");
  });

  it("match time starts at GO, so a timeLimit is not eaten by the lead-in", () => {
    const sim = newSim();
    for (let i = 0; i < TICKS; i++) sim.tick(DT);
    expect(sim.snapshot().elapsed).toBe(0);
    sim.tick(DT);
    expect(sim.snapshot().elapsed).toBeCloseTo(DT, 6);
    // Countdown ticks are still PROCESSED ticks, so the tick counter counts them.
    expect(sim.snapshot().tick).toBe(TICKS + 1);
  });

  it("is skipped entirely when a pack authors 0 (the legal test/e2e value)", () => {
    setTestCountdown(configs, 0);
    try {
      const sim = newSim();
      expect(sim.matchPhase).toBe("live");
      expect(sim.snapshot().countdownRemaining).toBe(0);
      sim.tick(DT);
      expect(sim.snapshot().elapsed).toBeCloseTo(DT, 6);
    } finally {
      setTestCountdown(configs, COUNTDOWN);
    }
  });

  it("emits one tick event per whole second, then matchStarted at GO", () => {
    const sim = newSim();
    const beats: number[] = [];
    let started = 0;
    for (let i = 0; i < TICKS + 5; i++) {
      sim.tick(DT);
      for (const ev of sim.getEvents()) {
        if (ev.type === "countdownTick") beats.push(ev.remaining);
        if (ev.type === "matchStarted") started++;
      }
    }
    expect(beats).toEqual([3, 2, 1]);
    expect(started).toBe(1);
  });

  it("defaults to 3 s and degrades a nonsense authored value to no countdown", () => {
    expect(matchCountdownSecOf({} as TuningConfig)).toBe(DEFAULT_MATCH_COUNTDOWN_SEC);
    expect(matchCountdownSecOf({ matchCountdownSec: 0 } as TuningConfig)).toBe(0);
    expect(matchCountdownSecOf({ matchCountdownSec: -4 } as TuningConfig)).toBe(0);
    expect(matchCountdownSecOf({ matchCountdownSec: Number.NaN } as TuningConfig)).toBe(0);
  });
});

describe("match-start countdown — order suspension", () => {
  it("stores a held flight order without moving the ship, then flies it at GO", () => {
    const sim = newSim();
    const [id] = sim.world.shipIds();
    const tf = sim.world.transforms.get(id!)!;
    const start = { x: tf.pos.x, y: tf.pos.y, z: tf.pos.z, heading: tf.heading, pitch: tf.pitch };

    // Full throttle, hard over, nose up — held through the whole countdown.
    sim.applyOrder(id!, { kind: "flight", throttle: 1, turn: 1, pitchStick: 1, boost: true, fire: true });
    for (let i = 0; i < TICKS - 1; i++) sim.tick(DT);

    // Nothing integrated: not position, not attitude, not velocity.
    expect(tf.pos.x).toBe(start.x);
    expect(tf.pos.y).toBe(start.y);
    expect(tf.pos.z).toBe(start.z);
    expect(tf.heading).toBe(start.heading);
    expect(tf.pitch).toBe(start.pitch);
    const vel = sim.world.velocities.get(id!)!;
    expect(Math.hypot(vel.x, vel.y, vel.z)).toBe(0);

    // ...but the order WAS accepted and stored, so the snapshot reports the held
    // throttle and the ship accelerates on the very first live tick.
    const held = sim.world.flightStates.get(id!);
    expect(held?.throttle).toBe(1);
    expect(sim.snapshot().ships.find((s) => s.id === id)?.throttle).toBe(1);

    sim.tick(DT); // the GO tick — still frozen, it is the last countdown tick
    sim.tick(DT); // first live tick
    expect(Math.hypot(vel.x, vel.y, vel.z)).toBeGreaterThan(0);
    expect(tf.heading).not.toBe(start.heading);
  });

  it("cannot fire, warm a lock, or take collision damage before GO", () => {
    const sim = newSim();
    const [a, b] = sim.world.shipIds();
    // Park the two ships nose-to-nose well inside lock range and gun range.
    const ta = sim.world.transforms.get(a!)!;
    const tb = sim.world.transforms.get(b!)!;
    ta.pos.x = 0; ta.pos.y = 0; ta.pos.z = 0; ta.heading = 0;
    tb.pos.x = 20; tb.pos.y = 0; tb.pos.z = 0; tb.heading = Math.PI;
    const hullBefore = sim.world.shipCores.get(b!)!.hull;

    // Deploy every weapon and run the whole countdown out.
    for (const m of sim.world.modules.get(a!)!.modules) {
      sim.applyOrder(a!, { kind: "moduleToggle", hardpointIndex: m.hardpointIndex });
    }
    for (let i = 0; i < TICKS - 1; i++) sim.tick(DT);

    expect(sim.matchPhase).toBe("countdown");
    expect(sim.world.targets.get(a!)?.locked ?? false).toBe(false);
    expect(sim.world.targets.get(a!)?.lockProgress ?? 0).toBe(0);
    expect(sim.world.projectileIds()).toHaveLength(0);
    expect(sim.world.shipCores.get(b!)!.hull).toBe(hullBefore);
  });

  it("applies a mashed module button once per press, not N times at GO", () => {
    const sim = newSim();
    const [id] = sim.world.shipIds();
    // A SHIELD, swapped onto the second hardpoint: weapons stopped taking
    // toggles on 2026-08-21, and the subject needs real deploy/retract times
    // for a mashed button to leave it mid-transition at all.
    const mod = sim.world.modules.get(id!)!.modules[1]!;
    mod.moduleId = "module.shield-mk1";
    mod.state = "retracted";

    // One toggle per countdown tick would, if orders merely QUEUED, all land on
    // the first live tick and cancel each other out.
    for (let i = 0; i < 10; i++) {
      sim.applyOrder(id!, { kind: "moduleToggle", hardpointIndex: mod.hardpointIndex });
      sim.tick(DT);
    }
    // 10 presses from `retracted`: deploying → retracting → deploying → … Timers
    // are frozen, so nothing completes; the point is that the count is 10, not
    // that it settles anywhere in particular.
    expect(["deploying", "retracting"]).toContain(mod.state);
    // Frozen timers: the deploy never completed during the countdown.
    expect(mod.state).not.toBe("active");
  });
});

describe("match-start countdown — simultaneous start", () => {
  it("two sims on the same seed reach live on the same tick", () => {
    const a = newSim(7);
    const b = newSim(7);
    let liveA = -1;
    let liveB = -1;
    for (let i = 1; i <= TICKS + 10; i++) {
      a.tick(DT);
      b.tick(DT);
      if (liveA < 0 && a.matchPhase === "live") liveA = i;
      if (liveB < 0 && b.matchPhase === "live") liveB = i;
      // The clocks agree every single tick, not just at the end.
      expect(b.snapshot().countdownRemaining).toBe(a.snapshot().countdownRemaining);
    }
    expect(liveA).toBe(TICKS);
    expect(liveB).toBe(liveA);
  });

  it("holds simultaneity even when only ONE side is issuing orders", () => {
    // The asymmetric case is the one that matters online: one player mashes the
    // throttle through the countdown, the other sits still. If accepting orders
    // advanced anything, the two sims would go live a different number of ticks
    // apart and one ship would start with a head start.
    const a = newSim(3);
    const b = newSim(3);
    const [shipA] = a.world.shipIds();
    for (let i = 1; i <= TICKS; i++) {
      a.applyOrder(shipA!, { kind: "flight", throttle: 1, turn: -1, boost: true, fire: true });
      a.tick(DT);
      b.tick(DT);
      expect(a.matchPhase).toBe(b.matchPhase);
      expect(a.snapshot().countdownRemaining).toBe(b.snapshot().countdownRemaining);
    }
    expect(a.matchPhase).toBe("live");
    // Both ships are still exactly on their spawn point at GO.
    for (const sim of [a, b]) {
      for (const id of sim.world.shipIds()) {
        const vel = sim.world.velocities.get(id)!;
        expect(Math.hypot(vel.x, vel.y, vel.z)).toBe(0);
      }
    }
  });
});

import { describe, expect, it } from "vitest";

import { ConfigService } from "../core/ConfigService.js";
import { botprofileSchema, type BotprofileConfig } from "../schemas/botprofile.js";
import { orderSchema } from "../net/protocol.js";
import type { AsteroidSnapshot, ProjectileSnapshot, ShipSnapshot, Snapshot } from "../sim/ArenaSimulation.js";
import { angleDelta, wrapAngle } from "../sim/math.js";
import type { Order } from "../sim/orders.js";
import { loadTestConfigs } from "../sim/testutil.js";
import type { BotBehavior } from "./behaviors.js";
import { BotDriver } from "./BotDriver.js";

// ---------------------------------------------------------------------------
// Snapshot fixtures — bots only ever see this shape.
// ---------------------------------------------------------------------------

function ship(id: number, team: number, x: number, z: number, over: Partial<ShipSnapshot> = {}): ShipSnapshot {
  return {
    id,
    team,
    pos: { x, z },
    heading: 0,
    hull: 100,
    hullMax: 100,
    energy: { cur: 100, max: 100 },
    heat: { cur: 0, capacity: 100 },
    targetId: null,
    throttle: 0,
    lockProgress: 0,
    locked: false,
    modules: [],
    ...over,
  };
}

function snap(
  ships: ShipSnapshot[],
  asteroids: AsteroidSnapshot[] = [],
  projectiles: ProjectileSnapshot[] = [],
  elapsed = 1,
): Snapshot {
  return { tick: 1, elapsed, phase: "live", winnerTeam: null, ships, asteroids, projectiles };
}

function rock(id: number, x: number, z: number, radius = 8): AsteroidSnapshot {
  return { id, configId: "asteroid.large-hazard", pos: { x, z }, radius, state: "intact" };
}

function profile(over: Record<string, unknown>): BotprofileConfig {
  return botprofileSchema.parse({
    id: "bot.test",
    type: "botprofile",
    version: 1,
    decisionIntervalMs: 400,
    orderJitterMs: 0,
    preferredRange: [20, 35],
    behaviors: { engage: { baseWeight: 1 } },
    moduleDiscipline: {
      heatShutdownAt: 0.85,
      reactivateBelow: 0.5,
      energyReserve: 0.15,
      shieldOnlyWhenEngaged: true,
    },
    ...over,
  });
}

/** RNG that always returns 0 — deterministic, and makes chance rolls fire. */
const zeroRng = (): number => 0;

/** Run a driver to its first decision (the first update only seeds the cadence). */
function decide(driver: BotDriver, snapshot: Snapshot): void {
  driver.update(snapshot, 0);
  driver.update(snapshot, 10_000);
}

function makeDriver(p: BotprofileConfig, configs: ConfigService, entityId = 1): BotDriver {
  return new BotDriver({ entityId, profile: p, configs, rng: zeroRng, orbitSign: 1 });
}

/** The `flight` order in an emitted batch, if any. */
function flightOrder(orders: readonly Order[]): Extract<Order, { kind: "flight" }> | undefined {
  return orders.find((o): o is Extract<Order, { kind: "flight" }> => o.kind === "flight");
}

const emptyConfigs = new ConfigService(async () => ({}));

describe("BotDriver utility scoring", () => {
  it("engages when the enemy sits at the preferred range", () => {
    const p = profile({ behaviors: { engage: { baseWeight: 1 }, kite: { baseWeight: 1 }, retreat: { baseWeight: 1, triggerHullBelow: 0.3 } } });
    const driver = makeDriver(p, emptyConfigs);
    const s = snap([ship(1, 0, 0, 0), ship(2, 1, 27, 0)]);
    decide(driver, s);
    expect(driver.lastDecision?.behavior).toBe("engage");
    expect(driver.lastDecision?.scores["retreat"]).toBe(0); // trigger not met
  });

  it("kites when the enemy is inside the break range", () => {
    const p = profile({ behaviors: { engage: { baseWeight: 1 }, kite: { baseWeight: 1 } } });
    const driver = makeDriver(p, emptyConfigs);
    decide(driver, snap([ship(1, 0, 0, 0), ship(2, 1, 5, 0)]));
    const d = driver.lastDecision!;
    expect(d.behavior).toBe("kite");
    expect(d.scores["kite"]!).toBeGreaterThan(d.scores["engage"]!);
    // The extend leg aims away from the enemy, out past the standoff range.
    expect(Math.hypot(d.plannedMove!.x - 5, d.plannedMove!.z)).toBeGreaterThan(20);
    expect(d.flight!.throttle).toBe(1);
  });

  it("breaks line of sight behind an asteroid once hull drops below the trigger", () => {
    const p = profile({
      behaviors: { engage: { baseWeight: 1 }, breakLoS: { baseWeight: 1.5, triggerHullBelow: 0.4 } },
    });
    const driver = makeDriver(p, emptyConfigs);
    // Rock off the direct line, so LoS to the enemy is currently clear but
    // cover exists just behind it.
    const rocks = [rock(9, 15, 10, 6)];

    // Healthy: no trigger, engage wins.
    const healthy = makeDriver(p, emptyConfigs);
    decide(healthy, snap([ship(1, 0, 0, 0), ship(2, 1, 60, 0)], rocks));
    expect(healthy.lastDecision?.behavior).toBe("engage");

    // Hurt: breakLoS wins and picks a point that actually blocks LoS.
    decide(driver, snap([ship(1, 0, 0, 0, { hull: 20 }), ship(2, 1, 60, 0)], rocks));
    const d = driver.lastDecision!;
    expect(d.behavior).toBe("breakLoS");
    // The chosen point sits on the far side of the rock from the enemy.
    expect(d.plannedMove!.x).toBeLessThan(15);
  });

  it("never retreats when the profile omits the behaviour", () => {
    const p = profile({ behaviors: { engage: { baseWeight: 1 } } });
    const driver = makeDriver(p, emptyConfigs);
    decide(driver, snap([ship(1, 0, 0, 0, { hull: 1 }), ship(2, 1, 25, 0)]));
    const d = driver.lastDecision!;
    expect(d.behavior).toBe("engage");
    expect(d.scores["retreat"]).toBeUndefined();
  });

  it("retreats on the configured shield-down trigger", () => {
    const p = profile({
      behaviors: { engage: { baseWeight: 1 }, retreat: { baseWeight: 1.4, triggerShieldDown: true } },
    });
    const driver = makeDriver(p, emptyConfigs);
    decide(driver, snap([ship(1, 0, 0, 0, { hull: 40 }), ship(2, 1, 25, 0)]));
    const d = driver.lastDecision!;
    expect(d.behavior).toBe("retreat");
    // Retreat runs away from the enemy, throttle open.
    expect(d.plannedMove!.x).toBeLessThan(0);
    expect(d.flight!.throttle).toBe(1);
  });

  it("dodges an inbound missile (5.2 missile-dodge repositioning)", () => {
    const p = profile({
      behaviors: { engage: { baseWeight: 1 }, dodge: { baseWeight: 1.5, dodgeRadius: 20, dodgeDistance: 12 } },
    });
    const driver = makeDriver(p, emptyConfigs);
    const missile: ProjectileSnapshot = { id: 50, kind: "missile", pos: { x: 10, z: 0 }, heading: Math.PI };
    decide(driver, snap([ship(1, 0, 0, 0), ship(2, 1, 30, 0)], [], [missile]));
    const d = driver.lastDecision!;
    expect(d.behavior).toBe("dodge");
    // Sidesteps perpendicular to the missile track (which runs along -x).
    expect(Math.abs(d.plannedMove!.z)).toBeGreaterThan(5);
  });

  it("layers a losing-but-live behaviour's overlay onto the winner's stick", () => {
    // dodge cannot win (baseWeight 0) but is situationally live, so its jink
    // rides on top of the pursuit — the flight-model version of "layered dodging".
    const missile: ProjectileSnapshot = { id: 50, kind: "missile", pos: { x: 6, z: 0 }, heading: Math.PI };
    const s = snap([ship(1, 0, 0, 0), ship(2, 1, 27, 0)], [], [missile], 0.9);

    const plain = makeDriver(profile({ behaviors: { engage: { baseWeight: 1 } } }), emptyConfigs);
    decide(plain, s);

    const jinking = makeDriver(
      profile({
        behaviors: { engage: { baseWeight: 1 }, dodge: { baseWeight: 0, dodgeRadius: 20, jinkAmp: 0.5 } },
      }),
      emptyConfigs,
    );
    decide(jinking, s);

    expect(jinking.lastDecision?.behavior).toBe("engage"); // overlay never wins
    expect(jinking.lastDecision!.flight!.turn).not.toBe(plain.lastDecision!.flight!.turn);
    expect(jinking.lastDecision!.plannedMove).toEqual(plain.lastDecision!.plannedMove);
  });
});

describe("BotDriver flight orders", () => {
  it("emits only schema-valid orders, and never a targeting one", () => {
    const p = profile({ behaviors: { engage: { baseWeight: 1 } } });
    const driver = new BotDriver({ entityId: 1, profile: p, configs: emptyConfigs, rng: zeroRng });
    const s = snap([ship(1, 0, 0, 0), ship(2, 1, 25, 0), ship(3, 1, 80, 0)]);
    driver.update(s, 0);
    const orders = driver.update(s, 10_000);
    for (const o of orders) expect(orderSchema.safeParse(o).success).toBe(true);
    // Targeting is the sim's (FLIGHT.md §2): the bot picks a MANOEUVRE focus and
    // flies at it, but it has no order that could pin the sensors.
    expect(orders.every((o) => o.kind === "flight" || o.kind === "moduleToggle")).toBe(true);
    expect(driver.lastDecision?.targetId).toBe(2); // nearest enemy, local plan only
    const flight = flightOrder(orders);
    expect(flight).toBeDefined();
    expect(flight!.throttle).toBeGreaterThanOrEqual(0);
    expect(flight!.throttle).toBeLessThanOrEqual(1);
    expect(Math.abs(flight!.turn)).toBeLessThanOrEqual(1);
  });

  it("keeps the standing flight state when the stick barely moved (level-triggered)", () => {
    const p = profile({ decisionIntervalMs: 100, orderJitterMs: 0, behaviors: { engage: { baseWeight: 1 } } });
    const driver = makeDriver(p, emptyConfigs);
    const s = snap([ship(1, 0, 0, 0), ship(2, 1, 27, 0)]);
    driver.update(s, 0);
    expect(flightOrder(driver.update(s, 1_000))).toBeDefined(); // first stick always ships
    for (let i = 1; i <= 10; i++) {
      expect(flightOrder(driver.update(s, 1_000 + i * 200))).toBeUndefined();
    }
    // ...but a real change (the enemy is now behind us) does ship.
    const behind = snap([ship(1, 0, 0, 0), ship(2, 1, -27, 0)]);
    expect(flightOrder(driver.update(behind, 5_000))).toBeDefined();
  });

  it("re-sends on a boost edge even when the stick is unchanged", () => {
    // Far away ⇒ engage closes with boost; inside the band it drops the burner.
    const p = profile({ decisionIntervalMs: 100, behaviors: { engage: { baseWeight: 1, boostChance: 1 } } });
    const driver = makeDriver(p, emptyConfigs);
    driver.update(snap([ship(1, 0, 0, 0), ship(2, 1, 80, 0)]), 0);
    expect(flightOrder(driver.update(snap([ship(1, 0, 0, 0), ship(2, 1, 80, 0)]), 1_000))!.boost).toBe(true);
    const closed = flightOrder(driver.update(snap([ship(1, 0, 0, 0), ship(2, 1, 27, 0)]), 2_000));
    expect(closed).toBeDefined();
    expect(closed!.boost).toBe(false);
  });

  it("measures the hull turn rate from its own stick and then aims proportionally", () => {
    const turnRate = 2.4;
    const dt = 1 / 30;
    const p = profile({
      decisionIntervalMs: 200,
      orderJitterMs: 0,
      behaviors: { engage: { baseWeight: 1 } },
      flight: { turnHorizonMult: 1, aimToleranceRad: 0.02 },
    });
    const driver = makeDriver(p, emptyConfigs);

    let heading = 0;
    let turn = 0;
    let elapsed = 0;
    const sticks: number[] = [];
    for (let i = 0; i < 200; i++) {
      const s = snap([ship(1, 0, 0, 0, { heading }), ship(2, 1, 0, 40)], [], [], elapsed);
      const flight = flightOrder(driver.update(s, elapsed * 1000));
      if (flight) {
        turn = flight.turn;
        sticks.push(turn);
      }
      // The sim's heading integration, verbatim — nothing else rotates a ship.
      heading = wrapAngle(heading + turn * turnRate * dt);
      elapsed += dt;
    }

    expect(driver.measuredTurnRate).toBeCloseTo(turnRate, 6);
    // First command is the documented uncalibrated fallback: full deflection.
    expect(Math.abs(sticks[0]!)).toBe(1);
    // Later commands are proportional, and the nose ends up on the enemy
    // (bearing from the origin to (0, 40) is +PI/2).
    expect(sticks.some((t) => Math.abs(t) > 0 && Math.abs(t) < 1)).toBe(true);
    expect(Math.abs(angleDelta(heading, Math.PI / 2))).toBeLessThan(0.05);
  });

  it("does not re-target while sensor lock progress is on the books", () => {
    // Switching candidate resets lockProgress in TargetingSystem, so a bot that
    // re-ranks mid-warm-up would throw its own lock away and never fire.
    const p = profile({ behaviors: { engage: { baseWeight: 1 } } });
    const held = makeDriver(p, emptyConfigs);
    const warming = [
      ship(1, 0, 0, 0, { targetId: 3, lockProgress: 0.5 }),
      ship(2, 1, 10, 0), // now the nearest
      ship(3, 1, 60, 0),
    ];
    decide(held, snap(warming));
    expect(held.lastDecision?.targetId).toBe(3);

    // With the discipline disabled it takes the nearest and eats the reset.
    const greedy = makeDriver(profile({ behaviors: { engage: { baseWeight: 1, holdLockTarget: false } } }), emptyConfigs);
    decide(greedy, snap(warming));
    expect(greedy.lastDecision?.targetId).toBe(2);

    // With no progress banked, even the disciplined bot re-ranks freely.
    const cold = makeDriver(p, emptyConfigs);
    decide(cold, snap([ship(1, 0, 0, 0, { targetId: 3 }), ship(2, 1, 10, 0), ship(3, 1, 60, 0)]));
    expect(cold.lastDecision?.targetId).toBe(2);
  });

  it("never emits a non-finite axis, whatever a behaviour returns", () => {
    // Level-triggered orders make a poisoned axis permanent — the ship would keep
    // integrating NaN forever — so the driver neutralises it at the boundary
    // rather than relying on the sim's drop. (`numParam` already screens content;
    // this covers a registered behaviour computing its way to a bad number.)
    const broken: BotBehavior = {
      score: () => 1,
      plan: () => ({ aim: { x: Number.NaN, z: 0 }, throttle: Number.NaN, boost: false, engaged: true }),
    };
    const driver = new BotDriver({
      entityId: 1,
      profile: profile({ behaviors: { broken: { baseWeight: 1 } } }),
      configs: emptyConfigs,
      rng: zeroRng,
      behaviors: new Map([["broken", broken]]),
    });
    decide(driver, snap([ship(1, 0, 0, 0), ship(2, 1, 27, 0)]));
    const flight = flightOrder(driver.lastDecision!.orders)!;
    expect(flight.throttle).toBe(0);
    expect(Number.isFinite(flight.turn)).toBe(true);
    expect(orderSchema.safeParse(flight).success).toBe(true);
  });

  it("respects the configured decision cadence", () => {
    const p = profile({ decisionIntervalMs: 500, orderJitterMs: 0, behaviors: { engage: { baseWeight: 1 } } });
    const driver = makeDriver(p, emptyConfigs);
    const s = snap([ship(1, 0, 0, 0), ship(2, 1, 25, 0)]);
    driver.update(s, 0); // seeds the cadence only (rng = 0 ⇒ first decision due at 0)
    driver.update(s, 0);
    expect(driver.lastDecision).not.toBeNull();
    const at = driver.lastDecision!.atMs;
    driver.update(s, at + 100);
    expect(driver.lastDecision!.atMs).toBe(at); // no new decision yet
    driver.update(s, at + 501);
    expect(driver.lastDecision!.atMs).toBe(at + 501);
    // The second decision re-planned the same stick, so nothing was re-ordered —
    // but the debug snapshot still reports where the bot is headed.
    expect(driver.lastDecision!.movePoint).toBeNull();
    expect(driver.lastDecision!.plannedMove).not.toBeNull();
  });

  it("re-reads its profile from the registry, so a Behavior Editor tweak reaches a flying bot", () => {
    const configs = new ConfigService(async () => ({}));
    const p = profile({
      behaviors: { engage: { baseWeight: 1 }, retreat: { baseWeight: 0, triggerShieldDown: true } },
    });
    expect(configs.replace(p).ok).toBe(true);
    const driver = makeDriver(p, configs);
    const s = snap([ship(1, 0, 0, 0), ship(2, 1, 27, 0)]);
    decide(driver, s);
    expect(driver.lastDecision?.behavior).toBe("engage");

    // Same edit the editor makes: replace the config under the same id.
    expect(configs.replace({ ...p, behaviors: { ...p.behaviors, retreat: { baseWeight: 5, triggerShieldDown: true } } }).ok).toBe(true);
    driver.update(s, 30_000);
    expect(driver.lastDecision?.behavior).toBe("retreat");
    expect(driver.profile.behaviors["retreat"]!.baseWeight).toBe(5);
  });

  it("is deterministic for a given injected RNG", () => {
    const p = profile({
      orderJitterMs: 150,
      behaviors: { engage: { baseWeight: 1, boostChance: 0.5 }, kite: { baseWeight: 1 } },
    });
    const mulberry = (seed: number) => {
      let a = seed;
      return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    };
    const run = (seed: number): string => {
      const driver = new BotDriver({ entityId: 1, profile: p, configs: emptyConfigs, rng: mulberry(seed) });
      const out: unknown[] = [];
      for (let i = 0; i < 40; i++) {
        const s = snap([ship(1, 0, i, 0, { heading: i * 0.05 }), ship(2, 1, 30 + i * 0.5, 4)], [], [], i * 0.12);
        out.push(driver.update(s, i * 120));
      }
      return JSON.stringify(out);
    };
    expect(run(7)).toBe(run(7));
    // ...and a different seed diverges (proving the RNG is actually in play).
    expect(run(99)).not.toBe(run(7));
  });
});

describe("BotDriver content profiles", () => {
  it("loads the three shipped profiles and drives them without error", async () => {
    const configs = await loadTestConfigs();
    for (const id of ["bot.rookie", "bot.aggressive", "bot.cautious"]) {
      const p = configs.get<BotprofileConfig>("botprofile", id);
      expect(p, id).toBeDefined();
      const driver = makeDriver(p!, configs);
      decide(driver, snap([ship(1, 0, 0, 0), ship(2, 1, 25, 0)], [rock(9, 12, 6)]));
      expect(driver.lastDecision?.behavior).not.toBeNull();
      const flight = flightOrder(driver.lastDecision!.orders);
      expect(flight, id).toBeDefined();
      expect(orderSchema.safeParse(flight).success).toBe(true);
    }
  });
});

import { describe, expect, it } from "vitest";

import { ConfigService } from "../core/ConfigService.js";
import { botprofileSchema, type BotprofileConfig } from "../schemas/botprofile.js";
import { orderSchema } from "../net/protocol.js";
import type { AsteroidSnapshot, ProjectileSnapshot, ShipSnapshot, Snapshot } from "../sim/ArenaSimulation.js";
import { loadTestConfigs } from "../sim/testutil.js";
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
): Snapshot {
  return { tick: 1, elapsed: 1, phase: "live", winnerTeam: null, ships, asteroids, projectiles };
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

  it("kites when the enemy is inside the preferred minimum", () => {
    const p = profile({ behaviors: { engage: { baseWeight: 1 }, kite: { baseWeight: 1 } } });
    const driver = makeDriver(p, emptyConfigs);
    decide(driver, snap([ship(1, 0, 0, 0), ship(2, 1, 5, 0)]));
    const d = driver.lastDecision!;
    expect(d.behavior).toBe("kite");
    expect(d.scores["kite"]!).toBeGreaterThan(d.scores["engage"]!);
    // Kite moves away from the enemy, out to the preferred band.
    expect(Math.hypot(d.movePoint!.x - 5, d.movePoint!.z)).toBeGreaterThan(20);
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
    expect(d.movePoint!.x).toBeLessThan(15);
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
    // Retreat runs away from the enemy.
    expect(d.movePoint!.x).toBeLessThan(0);
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
    expect(Math.abs(d.movePoint!.z)).toBeGreaterThan(5);
  });

  it("emits only schema-valid orders and a target order for the chosen enemy", () => {
    const p = profile({ behaviors: { engage: { baseWeight: 1 } } });
    const driver = new BotDriver({ entityId: 1, profile: p, configs: emptyConfigs, rng: zeroRng });
    const s = snap([ship(1, 0, 0, 0), ship(2, 1, 25, 0), ship(3, 1, 80, 0)]);
    driver.update(s, 0);
    const orders = driver.update(s, 10_000);
    for (const o of orders) expect(orderSchema.safeParse(o).success).toBe(true);
    expect(orders).toContainEqual({ kind: "target", targetId: 2 }); // nearest enemy
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
    // The second decision re-planned the same point, so nothing was re-ordered —
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
      behaviors: { engage: { baseWeight: 1, doubleTapBoostChance: 0.5 }, kite: { baseWeight: 1 } },
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
    const run = (): string => {
      const driver = new BotDriver({ entityId: 1, profile: p, configs: emptyConfigs, rng: mulberry(7) });
      const out: unknown[] = [];
      for (let i = 0; i < 40; i++) {
        const s = snap([ship(1, 0, i, 0), ship(2, 1, 30 + i * 0.5, 4)]);
        out.push(driver.update(s, i * 120));
      }
      return JSON.stringify(out);
    };
    expect(run()).toBe(run());
    // ...and a different seed diverges (proving the RNG is actually in play).
    const other = new BotDriver({ entityId: 1, profile: p, configs: emptyConfigs, rng: mulberry(99) });
    const otherOut: unknown[] = [];
    for (let i = 0; i < 40; i++) {
      otherOut.push(other.update(snap([ship(1, 0, i, 0), ship(2, 1, 30 + i * 0.5, 4)]), i * 120));
    }
    expect(JSON.stringify(otherOut)).not.toBe(run());
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
    }
  });
});

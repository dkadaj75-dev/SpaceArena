import { describe, expect, it } from "vitest";
import type { ConfigType, ModuleConfig, ShipConfig } from "@space-arena/shared";
import { defaultFitOf, fitMetrics, simulateEngagement, timeToKill, type ConfigLookup } from "./balanceMath.js";

/** Build a ModuleConfig fixture (only the fields the balance math reads). */
function mod(id: string, family: ModuleConfig["family"], patch: Partial<ModuleConfig> = {}): ModuleConfig {
  return {
    id,
    type: "module",
    version: 1,
    family,
    level: 1,
    activation: { deployTime: 0, retractTime: 0 },
    heat: { capacity: 100, coolingPerSec: 8, perShot: 6 },
    ui: { icon: "x", label: "x" },
    price: 0,
    requiresLevel: 1,
    ...patch,
  } as ModuleConfig;
}

/** Fake config lookup backed by a module map (upgrades unused at level 0). */
function lookup(modules: ModuleConfig[]): ConfigLookup {
  const byId = new Map(modules.map((m) => [m.id, m]));
  return {
    get: (<T>(type: ConfigType, id: string) => (type === "module" ? (byId.get(id) as T | undefined) : undefined)) as ConfigLookup["get"],
    getAll: (<T>() => [] as T[]) as ConfigLookup["getAll"],
  };
}

function makeShip(patch: Partial<ShipConfig["core"]> = {}): ShipConfig {
  return {
    id: "ship.test",
    type: "ship",
    version: 1,
    class: "light",
    core: {
      hull: { base: 100, resists: { kinetic: 0.2, energy: 0.0 } },
      engine: { nominalSpeed: 30, accel: 20, turnRate: 3 },
      sensors: { lockRange: 60, lockTimeSec: 1.5, coneDeg: 70 },
      ...patch,
    },
    upgradeTracks: { hull: "upgrade.h", engine: "upgrade.e", energy: "upgrade.en", heat: "upgrade.ht" },
    sockets: [
      { id: "hp-0", kind: "hardpoint", transform: { pos: [0, 0, 0] }, accepts: ["laser"] },
      { id: "hp-1", kind: "hardpoint", transform: { pos: [0, 0, 0] }, accepts: ["kinetic"] },
    ],
    defaultFitting: ["module.laser", "module.kinetic"],
    render: { recipe: "procedural.arrowhead" },
    collider: { shape: "circle", radius: 1 },
  } as ShipConfig;
}

describe("balanceMath", () => {
  it("computes sustained DPS from weapon damage / cycleTime", () => {
    const modules = [
      mod("module.laser", "laser", { fire: { mode: "held", range: 30, cycleTime: 0.4, damage: 7, damageType: "energy", requiresLineOfSight: true, projectile: null } }),
      mod("module.kinetic", "kinetic", { fire: { mode: "held", range: 30, cycleTime: 0.5, damage: 10, damageType: "kinetic", requiresLineOfSight: true, projectile: null } }),
    ];
    const m = fitMetrics(makeShip(), lookup(modules), ["module.laser", "module.kinetic"]);
    expect(m.sustainedDps).toBeCloseTo(37.5, 5); // 7/0.4 + 10/0.5
    expect(m.hull).toBe(100);
    expect(m.ehp).toBeCloseTo(110, 5); // 100 * (1 + 0.1 avg resist)
  });

  it("EHP + shield reserve drive a first-order TTK", () => {
    const modules = [
      // Cooling that keeps pace with generation ⇒ duty cycle 1, so this weapon's
      // sustained DPS is its nominal one and the arithmetic stays readable.
      mod("module.laser", "laser", {
        heat: { capacity: 100, coolingPerSec: 10, perShot: 10, perSecondActive: 0, rearmBelow: 0.25 },
        fire: { mode: "held", range: 30, cycleTime: 1, damage: 10, damageType: "energy", requiresLineOfSight: true, projectile: null },
      }),
      mod("module.shield", "shield", {
        heat: undefined,
        energy: { capacity: 20, rechargePerSec: 4, drawPerSec: 4, rearmAbove: 0.25 },
        mitigation: { damageReduction: 0.5 },
      }),
    ];
    const cfg = lookup(modules);
    const attacker = fitMetrics(makeShip(), cfg, ["module.laser"]); // 10 dps
    const defender = fitMetrics(makeShip(), cfg, ["module.shield"]); // ehp 110 + reserve 20
    expect(timeToKill(attacker, defender)).toBeCloseTo((110 + 20) / 10, 5);
    // Zero-DPS attacker never kills.
    expect(timeToKill(defender, defender)).toBe(Infinity);
  });

  it("engagement sim keeps both stores in bounds and never locks a heat-stable rack", () => {
    // Cooling out-paces generation ⇒ the rack never trips and uptime is 1.
    const modules = [
      mod("module.laser", "laser", {
        heat: { capacity: 100, coolingPerSec: 50, perShot: 1, perSecondActive: 0, rearmBelow: 0.25 },
        fire: { mode: "held", range: 30, cycleTime: 1, damage: 5, damageType: "energy", requiresLineOfSight: true, projectile: null },
      }),
    ];
    const result = simulateEngagement(makeShip(), lookup(modules), ["module.laser"], { duration: 20, dt: 0.1 });
    for (const s of result.samples) {
      expect(s.heat).toBeGreaterThanOrEqual(0);
      expect(s.energy).toBeGreaterThanOrEqual(0);
      expect(s.energy).toBeLessThanOrEqual(1 + 1e-9);
    }
    expect(result.lockouts).toBe(0);
    expect(result.uptime).toBeCloseTo(1, 5);
  });

  it("engagement sim locks out a rack that cooks itself, then re-arms it", () => {
    const modules = [
      mod("module.hog", "laser", {
        heat: { capacity: 40, coolingPerSec: 5, perSecondActive: 60, perShot: 0, rearmBelow: 0.25 },
        fire: { mode: "continuous", range: 30, cycleTime: 0.1, damage: 5, damageType: "energy", requiresLineOfSight: true, projectile: null },
      }),
    ];
    const result = simulateEngagement(makeShip(), lookup(modules), ["module.hog"], { duration: 20, dt: 0.1 });
    expect(result.lockouts).toBeGreaterThan(1);
    expect(result.uptime).toBeLessThan(1);
    for (const s of result.samples) expect(s.heat).toBeGreaterThanOrEqual(0);
  });

  it("defaultFitOf pads to the hardpoint count", () => {
    const ship = makeShip();
    expect(defaultFitOf(ship)).toEqual(["module.laser", "module.kinetic"]);
  });
});

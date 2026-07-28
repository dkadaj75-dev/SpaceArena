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
    energy: { drawIdle: 1, drawActive: 5 },
    heat: { perSecondActive: 0, overheatThreshold: 100, overheatCooldown: 3, overheatSelfDamage: 0 },
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
      energy: { capacitor: 120, regen: 14 },
      heat: { capacity: 100, dissipation: 9, criticalDamagePerSec: 4 },
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

  it("EHP + shield pool drive a first-order TTK", () => {
    const modules = [
      mod("module.laser", "laser", { fire: { mode: "held", range: 30, cycleTime: 1, damage: 10, damageType: "energy", requiresLineOfSight: true, projectile: null } }),
      mod("module.shield", "shield", { mitigation: { damageReduction: 0.5, absorbPerSecond: 20 } }),
    ];
    const cfg = lookup(modules);
    const attacker = fitMetrics(makeShip(), cfg, ["module.laser"]); // 10 dps
    const defender = fitMetrics(makeShip(), cfg, ["module.shield"]); // ehp 110 + shield 20
    expect(timeToKill(attacker, defender)).toBeCloseTo((110 + 20) / 10, 5);
    // Zero-DPS attacker never kills.
    expect(timeToKill(defender, defender)).toBe(Infinity);
  });

  it("engagement sim keeps energy in [0, max] and reports full uptime for a stable fit", () => {
    const modules = [mod("module.laser", "laser", { energy: { drawIdle: 1, drawActive: 5 }, heat: { perSecondActive: 0, overheatThreshold: 100, overheatCooldown: 3, overheatSelfDamage: 0 } })];
    const ship = makeShip({ energy: { capacitor: 200, regen: 40 } });
    const result = simulateEngagement(ship, lookup(modules), ["module.laser"], { duration: 20, dt: 0.1 });
    for (const s of result.samples) {
      expect(s.energy).toBeGreaterThanOrEqual(0);
      expect(s.energy).toBeLessThanOrEqual(result.capacitorMax + 1e-9);
    }
    expect(result.brownedOut).toBe(false);
    expect(result.uptime).toBeCloseTo(1, 5);
  });

  it("engagement sim never lets energy go negative under a power-starved fit", () => {
    const modules = [mod("module.hog", "laser", { energy: { drawIdle: 5, drawActive: 500 } })];
    const ship = makeShip({ energy: { capacitor: 30, regen: 5 } });
    const result = simulateEngagement(ship, lookup(modules), ["module.hog"], { duration: 10, dt: 0.1 });
    expect(result.brownedOut).toBe(true);
    for (const s of result.samples) expect(s.energy).toBeGreaterThanOrEqual(0);
  });

  it("defaultFitOf pads to the hardpoint count", () => {
    const ship = makeShip();
    expect(defaultFitOf(ship)).toEqual(["module.laser", "module.kinetic"]);
  });
});

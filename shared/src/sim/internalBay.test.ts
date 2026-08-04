import { beforeAll, describe, expect, it } from "vitest";
import type { ConfigService } from "../core/ConfigService.js";
import {
  hardpointsOf,
  internalsOf,
  weaponHardpointsOf,
  type ModuleConfig,
  type ShipConfig,
} from "../schemas/index.js";
import { resolveShipStats } from "./resolveStats.js";
import { INTERCEPTOR_FITTING, loadTestConfigs } from "./testutil.js";

let configs: ConfigService;
let interceptor: ShipConfig;

beforeAll(async () => {
  configs = await loadTestConfigs();
  interceptor = configs.get<ShipConfig>("ship", "ship.interceptor")!;
});

const shipOf = (id: string): ShipConfig => configs.get<ShipConfig>("ship", id)!;

/** Resolve the light hull's core with one internal swapped into its bay. */
function withInternal(moduleId: string) {
  const fitting = [...INTERCEPTOR_FITTING];
  const family = configs.get<ModuleConfig>("module", moduleId)!.family;
  const bay = internalsOf(interceptor).findIndex((s) => s.accepts.includes(family));
  fitting[weaponHardpointsOf(interceptor).length + bay] = moduleId;
  return resolveShipStats(interceptor, configs, { fittedModuleIds: fitting });
}

describe("hull slot layout (owner 2026-07-31)", () => {
  it("gives each class its expanded hardpoint count and authored internal bay", () => {
    const expected: Array<[string, number, number]> = [
      ["ship.interceptor", 3, 5], // light: one small external option
      ["ship.support", 4, 6], // medium: support hardpoint + auxiliary bay
      ["ship.brawler", 6, 6], // heavy: weapon + utility hardpoints + auxiliary bay
    ];
    for (const [shipId, hardpoints, internals] of expected) {
      const ship = shipOf(shipId);
      expect(weaponHardpointsOf(ship), `${shipId} hardpoints`).toHaveLength(hardpoints);
      expect(internalsOf(ship).slice(0, 5).map((s) => s.accepts[0]), `${shipId} core internals`).toEqual([
        "engine",
        "generator",
        "transformer",
        "heatsink",
        "sensors",
      ]);
      // Both kinds share ONE index space, and the default fitting covers it.
      expect(hardpointsOf(ship)).toHaveLength(hardpoints + internals);
      // Starter defaults fit only free level-1 modules; priced auxiliary
      // sockets ship empty, so the default may be shorter than the socket list.
      expect(ship.defaultFitting.length).toBeLessThanOrEqual(hardpoints + internals);
      expect(ship.defaultFitting.length).toBeGreaterThanOrEqual(7);
    }
  });

  it("keeps weapons and shields off the internal bay, and systems off the hardpoints", () => {
    for (const shipId of ["ship.interceptor", "ship.support", "ship.brawler"]) {
      const ship = shipOf(shipId);
      for (const socket of weaponHardpointsOf(ship)) {
        expect(socket.accepts.every((f) => ["laser", "kinetic", "missile", "shield", "utility"].includes(f))).toBe(true);
      }
      for (const socket of internalsOf(ship)) {
        expect(socket.accepts.every((f) => ["engine", "generator", "transformer", "heatsink", "sensors"].includes(f))).toBe(true);
      }
    }
  });
});

describe("internals shape the hull", () => {
  const base = () => resolveShipStats(interceptor, configs, { fittedModuleIds: INTERCEPTOR_FITTING });

  it("ENGINE: the stock drive has no boost at all; the sporting one trades turn rate for speed", () => {
    expect(configs.get<ModuleConfig>("module", "module.engine-civ")!.boost).toBeUndefined();
    const sport = configs.get<ModuleConfig>("module", "module.engine-sport")!;
    expect(sport.boost!.speedMult).toBeGreaterThan(1);

    const stock = base();
    const fast = withInternal("module.engine-sport");
    expect(fast.engine.nominalSpeed).toBeGreaterThan(stock.engine.nominalSpeed);
    expect(fast.engine.turnRate).toBeLessThan(stock.engine.turnRate);

    // …and the agile drive is the mirror image of that trade.
    const agile = withInternal("module.engine-agile");
    expect(agile.engine.turnRate).toBeGreaterThan(stock.engine.turnRate);
    expect(agile.engine.nominalSpeed).toBeLessThan(stock.engine.nominalSpeed);
  });

  it("GENERATOR: a bigger plant buys energy and costs top speed", () => {
    const stock = base();
    const heavy = withInternal("module.generator-heavy");
    expect(heavy.capacitor.max).toBeGreaterThan(stock.capacitor.max);
    expect(heavy.capacitor.regen).toBeGreaterThan(stock.capacitor.regen);
    expect(heavy.engine.nominalSpeed).toBeLessThan(stock.engine.nominalSpeed);

    // The siege plant takes that trade further on both axes.
    const siege = withInternal("module.generator-siege");
    expect(siege.capacitor.max).toBeGreaterThan(heavy.capacitor.max);
    expect(siege.engine.nominalSpeed).toBeLessThan(heavy.engine.nominalSpeed);
  });

  it("TRANSFORMER: trades energy efficiency against heat, in both directions", () => {
    const stock = base();
    expect(stock.efficiency).toEqual({ energyDraw: 1, heatGen: 1 });

    const efficient = withInternal("module.transformer-efficient");
    expect(efficient.efficiency.energyDraw).toBeLessThan(1); // cheaper to run…
    expect(efficient.efficiency.heatGen).toBeGreaterThan(1); // …and hotter

    const cryo = withInternal("module.transformer-cryo");
    expect(cryo.efficiency.heatGen).toBeLessThan(1); // cooler…
    expect(cryo.efficiency.energyDraw).toBeGreaterThan(1); // …and thirstier
  });

  it("HEATSINK: better sinks dissipate more, and only the good ones can be jettisoned", () => {
    const stock = base();
    const cryo = withInternal("module.heatsink-cryo");
    expect(cryo.heat.dissipation).toBeGreaterThan(stock.heat.dissipation);
    expect(cryo.heat.capacity).toBeGreaterThan(stock.heat.capacity);

    expect(configs.get<ModuleConfig>("module", "module.heatsink-basic")!.jettison).toBeUndefined();
    expect(configs.get<ModuleConfig>("module", "module.heatsink-ablative")!.jettison).toBeDefined();
    expect(configs.get<ModuleConfig>("module", "module.heatsink-cryo")!.jettison).toBeDefined();
  });

  it("SENSORS: long-range reaches further but locks slower; snap-lock is the reverse", () => {
    const stock = base();
    const long = withInternal("module.sensors-longrange");
    expect(long.sensors.lockRange).toBeGreaterThan(stock.sensors.lockRange);
    expect(long.sensors.lockTimeSec).toBeGreaterThan(stock.sensors.lockTimeSec);

    const snap = withInternal("module.sensors-snap");
    expect(snap.sensors.lockTimeSec).toBeLessThan(stock.sensors.lockTimeSec);
    expect(snap.sensors.lockRange).toBeLessThan(stock.sensors.lockRange);
  });
});

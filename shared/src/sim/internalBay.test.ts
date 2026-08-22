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
    // Counts set by the owner on 2026-08-22: a hardpoint is now a real
    // decision, so there are few of them and every one of them is a weapon, a
    // shield or a support module.
    const expected: Array<[string, number, number]> = [
      ["ship.interceptor", 2, 5], // light: a symmetric wing pair
      ["ship.talon", 2, 5], // light: the same pair on the same airframe
      ["ship.support", 3, 6], // medium: nose + wing pair, auxiliary bay
      ["ship.brawler", 3, 6], // heavy: nose pair + spine, auxiliary bay
    ];
    for (const [shipId, hardpoints, internals] of expected) {
      const ship = shipOf(shipId);
      expect(weaponHardpointsOf(ship), `${shipId} hardpoints`).toHaveLength(hardpoints);
      expect(internalsOf(ship).slice(0, 5).map((s) => s.accepts[0]), `${shipId} core internals`).toEqual([
        "engine",
        "generator",
        "transformer",
        "countermeasure",
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

  it("keeps systems off the hardpoints, and dead weight off them too (2026-08-22)", () => {
    // "Every hardpoint can receive a weapon or a shield, but no heatsink here"
    // — the owner's rule, checked as written: the PASSIVE stat modules
    // (`utility`) are the thing a hardpoint may no longer carry, and they moved
    // to the auxiliary internal bay of the hulls that have one.
    const HARDPOINT_FAMILIES = ["laser", "kinetic", "missile", "shield", "disruptor", "repair"];
    for (const shipId of ["ship.interceptor", "ship.talon", "ship.support", "ship.brawler"]) {
      const ship = shipOf(shipId);
      for (const socket of weaponHardpointsOf(ship)) {
        expect(socket.accepts, `${shipId} ${socket.id}`).toEqual(HARDPOINT_FAMILIES);
      }
      for (const socket of internalsOf(ship)) {
        expect(
          socket.accepts.every((f) =>
            ["engine", "generator", "transformer", "countermeasure", "sensors", "utility"].includes(f),
          ),
          `${shipId} ${socket.id}`,
        ).toBe(true);
      }
    }
  });

  it("leaves the passive utilities somewhere to live on the hulls that carry them", () => {
    // The other half of the rule above. Taking `utility` off every hardpoint
    // would have orphaned six shipped modules outright, so the two hulls with
    // an auxiliary bay take them there — and the two light hulls, which have no
    // spare internal volume, genuinely cannot fit them any more.
    for (const shipId of ["ship.support", "ship.brawler"]) {
      const aux = internalsOf(shipOf(shipId)).find((s) => s.id === "in-auxiliary");
      expect(aux?.accepts, `${shipId} auxiliary bay`).toContain("utility");
    }
    for (const shipId of ["ship.interceptor", "ship.talon"]) {
      const ship = shipOf(shipId);
      expect(hardpointsOf(ship).some((s) => s.accepts.includes("utility")), `${shipId}`).toBe(false);
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

  it("GENERATOR: a bigger plant refills the module tanks faster and costs top speed", () => {
    const stock = base();
    const heavy = withInternal("module.generator-heavy");
    expect(heavy.recharge.multiplier).toBeGreaterThan(stock.recharge.multiplier);
    expect(heavy.energyStore.multiplier).toBeGreaterThan(stock.energyStore.multiplier);
    expect(heavy.engine.nominalSpeed).toBeLessThan(stock.engine.nominalSpeed);

    // The siege plant takes that trade further on both axes.
    const siege = withInternal("module.generator-siege");
    expect(siege.recharge.multiplier).toBeGreaterThan(heavy.recharge.multiplier);
    expect(siege.engine.nominalSpeed).toBeLessThan(heavy.engine.nominalSpeed);
  });

  it("TRANSFORMER: trades rail capacity against how thirstily every module runs", () => {
    const stock = base();
    expect(stock.efficiency).toEqual({ energyDraw: 1 });

    const efficient = withInternal("module.transformer-efficient");
    expect(efficient.efficiency.energyDraw).toBeLessThan(1); // cheaper to run…
    expect(efficient.power.capacity).toBeGreaterThan(stock.power.capacity);

    const cryo = withInternal("module.transformer-cryo");
    expect(cryo.efficiency.energyDraw).toBeGreaterThan(1); // …the cryo is thirstier
  });

  it("COUNTERMEASURE: every pod in the bay can be launched, and the ladder buys lure time", () => {
    // The family's whole job since heat was deleted (2026-08-20): a jettisonable
    // decoy. A pod that could not be launched would do nothing at all.
    const flare = configs.get<ModuleConfig>("module", "module.countermeasure-flare")!.jettison!;
    const chaff = configs.get<ModuleConfig>("module", "module.countermeasure-chaff")!.jettison!;
    const spoofer = configs.get<ModuleConfig>("module", "module.countermeasure-spoofer")!.jettison!;

    expect(chaff.decoyLifetimeSec).toBeGreaterThan(flare.decoyLifetimeSec);
    expect(spoofer.decoyLifetimeSec).toBeGreaterThan(chaff.decoyLifetimeSec);
    // …and the better pods come back sooner, too.
    expect(chaff.cooldownSec).toBeLessThan(flare.cooldownSec);
    expect(spoofer.cooldownSec).toBeLessThan(chaff.cooldownSec);
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

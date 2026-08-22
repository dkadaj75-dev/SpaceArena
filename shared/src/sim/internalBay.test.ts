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
import { INTERCEPTOR_FITTING, INTERCEPTOR_SLOTS, loadTestConfigs } from "./testutil.js";

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
        // The ALLOY bay (owner 2026-08-22), on the socket the retired
        // transformer family used to hold — same index, so a stored fitting's
        // slot 4 still addresses an internal rather than shifting everything
        // after it.
        "hull",
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
            ["engine", "generator", "hull", "countermeasure", "sensors", "utility"].includes(f),
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

/**
 * THE 2026-08-22 INTERNAL REWORK, stat hook by stat hook.
 *
 * Every value in the owner's tables is a PERCENT MODIFIER on the hull's base
 * stat, expressed as a `mul` passive through the one stat resolver. These tests
 * assert the exact arithmetic rather than a direction, because "bigger than
 * stock" would pass just as happily if a +50% engine were wired to +5%.
 *
 * The BASE the percentages are read against is the hull as authored, which is
 * what makes the baseline modules (Earth Engine Engineered I, Earth Generator
 * Engineered I, Earth Alloy Purity I, Common Sensors Mark I) meaningful: they
 * author no passives at all, so a ship on its default fitting flies on exactly
 * its authored numbers. `base()` below fits precisely those, so every
 * expectation reads as "hull stat × the table's percent".
 */
describe("internals shape the hull (owner 2026-08-22)", () => {
  const base = () => resolveShipStats(interceptor, configs, { fittedModuleIds: INTERCEPTOR_FITTING });
  /** The hull's AUTHORED core — what every percentage in the tables is read against. */
  const authored = () => interceptor.core;

  it("BASELINE: the four default internals move nothing at all", () => {
    const stock = base();
    const c = authored();
    expect(stock.engine.nominalSpeed).toBe(c.engine.nominalSpeed);
    expect(stock.hull).toBe(c.hull.base);
    expect(stock.efficiency.energyDraw).toBe(1);
    expect(stock.energyStore.multiplier).toBe(1);
    expect(stock.sensors.lockRange).toBe(c.sensors.lockRange);
    expect(stock.sensors.lockTimeSec).toBe(c.sensors.lockTimeSec);
    expect(stock.resists).toEqual({ kinetic: c.hull.resists.kinetic, energy: c.hull.resists.energy });
    for (const id of [
      "module.engine-earth-eng1",
      "module.generator-earth-eng1",
      "module.alloy-earth-p1",
      "module.sensors-common-mk1",
    ]) {
      expect(configs.get<ModuleConfig>("module", id)!.passives, id).toEqual([]);
    }
  });

  it("ENGINE: buys top speed and pays for it in ship-wide energy draw", () => {
    const c = authored();
    // Owner's table: II +15%/+10%, III +30%/+20%, IV +50%/+30%.
    for (const [id, speed, draw] of [
      ["module.engine-earth-eng2", 1.15, 1.1],
      ["module.engine-earth-eng3", 1.3, 1.2],
      ["module.engine-earth-eng4", 1.5, 1.3],
    ] as const) {
      const core = withInternal(id);
      expect(core.engine.nominalSpeed, id).toBeCloseTo(c.engine.nominalSpeed * speed, 9);
      // `efficiency.energyDraw` is the DOWNSIDE, and it is the hook the retired
      // transformer family owned — EnergySystem still bills exactly this one
      // multiplier per drain, so a faster hull empties every tank sooner.
      expect(core.efficiency.energyDraw, id).toBeCloseTo(draw, 9);
    }
  });

  it("ENGINE: every mark carries the same afterburner, so boost is not a mark reward", () => {
    // Boost has ridden the engine internal since 2026-07-31 and the owner's
    // table lists two stats, neither of them boost. Making the afterburner
    // better up the line would be inventing progression the sheet does not
    // have; taking it away entirely would delete the BOOST button from the
    // shipped pack. So all four marks carry one identical block.
    const blocks = ["eng1", "eng2", "eng3", "eng4"].map(
      (m) => configs.get<ModuleConfig>("module", `module.engine-earth-${m}`)!,
    );
    for (const mod of blocks) {
      expect(mod.boost, mod.id).toEqual(blocks[0]!.boost);
      expect(mod.energy, mod.id).toEqual(blocks[0]!.energy);
      expect(mod.boost!.speedMult).toBeGreaterThan(1);
    }
  });

  it("GENERATOR: sizes the module tanks, and touches nothing else", () => {
    const c = authored();
    // Owner's single column is Power capacity — `energyStore.multiplier`, the
    // size of every tank the hull carries. The old line's recharge-rate and
    // top-speed trades are gone with it.
    for (const [id, cap] of [
      ["module.generator-earth-eng2", 1.1],
      ["module.generator-earth-eng3", 1.25],
      ["module.generator-earth-eng4", 1.5],
    ] as const) {
      const core = withInternal(id);
      expect(core.energyStore.multiplier, id).toBeCloseTo(cap, 9);
      expect(core.recharge.multiplier, id).toBe(1);
      expect(core.engine.nominalSpeed, id).toBe(c.engine.nominalSpeed);
    }
  });

  it("HULL: the Martian plate is structure and kinetic hardening bought with speed and energy resist", () => {
    const c = authored();
    const core = withInternal("module.alloy-martian-p4");
    expect(core.hull).toBeCloseTo(c.hull.base * 1.5, 9);
    expect(core.engine.nominalSpeed).toBeCloseTo(c.engine.nominalSpeed * 0.9, 9);
    expect(core.resists.kinetic).toBeCloseTo(c.hull.resists.kinetic * 1.3, 9);
    expect(core.resists.energy).toBeCloseTo(c.hull.resists.energy * 0.85, 9);
  });

  it("HULL: the Lunar plate is the mirror image — thin, fast and energy-hardened", () => {
    const c = authored();
    const core = withInternal("module.alloy-lunar-p4");
    expect(core.hull).toBeCloseTo(c.hull.base * 0.8, 9);
    expect(core.engine.nominalSpeed).toBeCloseTo(c.engine.nominalSpeed * 1.25, 9);
    expect(core.resists.kinetic).toBeCloseTo(c.hull.resists.kinetic * 0.85, 9);
    expect(core.resists.energy).toBeCloseTo(c.hull.resists.energy * 1.3, 9);
  });

  it("HULL: the Earth plate is the only line that touches the shield reserve", () => {
    const c = authored();
    const stock = base();
    const core = withInternal("module.alloy-earth-p4");
    expect(core.hull).toBeCloseTo(c.hull.base * 1.2, 9);
    // "Shields ±X%" is the hull's SHIELD RESERVE multiplier: a shield's tank IS
    // its strength in this engine (`moduleTankCapacity` sizes it, EnergySystem
    // refills it at the same scale), so this is the honest reading of the word.
    expect(core.combat.shieldEfficiency).toBeCloseTo(stock.combat.shieldEfficiency * 1.2, 9);
    expect(core.engine.nominalSpeed).toBeCloseTo(c.engine.nominalSpeed * 0.925, 9);
    // …and it leaves both resist columns exactly where the hull authored them.
    expect(core.resists).toEqual(stock.resists);
  });

  it("HULL: a resist can never be pushed outside its band by a stack of alloys", () => {
    // The Talon authors 0.2755 energy resist — the highest shipped — and the
    // resolver holds every resist to the same 0..0.95 the schema holds an
    // author to. Nothing legal makes a hull immune to a damage channel.
    for (const ship of configs.getAll<ShipConfig>("ship")) {
      for (const alloy of ["module.alloy-martian-p4", "module.alloy-lunar-p4", "module.alloy-earth-p4"]) {
        const bay = internalsOf(ship).findIndex((s) => s.accepts.includes("hull"));
        const fitting = [...ship.defaultFitting];
        fitting[weaponHardpointsOf(ship).length + bay] = alloy;
        const core = resolveShipStats(ship, configs, { fittedModuleIds: fitting });
        for (const key of ["kinetic", "energy"] as const) {
          expect(core.resists[key], `${ship.id} ${alloy} ${key}`).toBeGreaterThanOrEqual(0);
          expect(core.resists[key], `${ship.id} ${alloy} ${key}`).toBeLessThanOrEqual(0.95);
        }
      }
    }
  });

  it("COMPOSE: an engine bonus and an alloy penalty on the same stat MULTIPLY", () => {
    // The resolver's rule, stated where a designer will look for it: per stat
    // path every `add` is summed and every `mul` is multiplied, then
    // `(base + Σadd) × Πmul`. So the two speed passives compound (×1.5 × ×0.9)
    // rather than being averaged or added as percentage points (which would
    // give ×1.40, a visibly different hull).
    const c = authored();
    const fitting = [...INTERCEPTOR_FITTING];
    fitting[INTERCEPTOR_SLOTS.engine] = "module.engine-earth-eng4";
    fitting[INTERCEPTOR_SLOTS.hull] = "module.alloy-martian-p4";
    const core = resolveShipStats(interceptor, configs, { fittedModuleIds: fitting });
    expect(core.engine.nominalSpeed).toBeCloseTo(c.engine.nominalSpeed * 1.5 * 0.9, 9);

    // …and the order the bays are read in cannot matter, because multiplication
    // does not care. Same two modules, swapped ends of the fitting array.
    const reversed = [...fitting].reverse();
    expect(
      resolveShipStats(interceptor, configs, { fittedModuleIds: reversed }).engine.nominalSpeed,
    ).toBeCloseTo(core.engine.nominalSpeed, 9);
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

  it("SENSORS: the Sharpshooter line buys lock distance AND a faster lock", () => {
    const c = authored();
    // Owner's columns are (Lock distance, Lock time), and a NEGATIVE lock time
    // is a bonus — a faster lock — so it is authored as a multiplier below 1.
    for (const [id, range, time] of [
      ["module.sensors-sharpshooter-mk1", 1.05, 0.95],
      ["module.sensors-sharpshooter-mk2", 1.1, 0.95],
      ["module.sensors-sharpshooter-mk3", 1.15, 0.9],
      ["module.sensors-sharpshooter-mk4", 1.25, 0.9],
    ] as const) {
      const core = withInternal(id);
      expect(core.sensors.lockRange, id).toBeCloseTo(c.sensors.lockRange * range, 9);
      expect(core.sensors.lockTimeSec, id).toBeCloseTo(c.sensors.lockTimeSec * time, 9);
      expect(core.sensors.lockTimeSec, id).toBeLessThan(c.sensors.lockTimeSec);
    }
  });

  it("SENSORS: the Common line only reaches further, and never locks faster", () => {
    const c = authored();
    for (const [id, range] of [
      ["module.sensors-common-mk2", 1.05],
      ["module.sensors-common-mk3", 1.1],
      ["module.sensors-common-mk4", 1.15],
    ] as const) {
      const core = withInternal(id);
      expect(core.sensors.lockRange, id).toBeCloseTo(c.sensors.lockRange * range, 9);
      expect(core.sensors.lockTimeSec, id).toBe(c.sensors.lockTimeSec);
    }
  });
});

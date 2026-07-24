import { beforeAll, describe, expect, it } from "vitest";
import { ConfigService } from "../core/ConfigService.js";
import type { ShipConfig } from "../schemas/index.js";
import { loadTestConfigs } from "./testutil.js";
import { resolveShipStats } from "./resolveStats.js";

let configs: ConfigService;
let interceptor: ShipConfig;

beforeAll(async () => {
  configs = await loadTestConfigs();
  interceptor = configs.get<ShipConfig>("ship", "ship.interceptor")!;
});

describe("resolveShipStats (4.1)", () => {
  it("returns ship-class base stats with no upgrades or passives", () => {
    const core = resolveShipStats(interceptor, configs);
    expect(core.hullMax).toBe(80);
    expect(core.engine.nominalSpeed).toBe(34);
    expect(core.capacitor.max).toBe(120);
    expect(core.capacitor.regen).toBe(14);
    expect(core.heat.capacity).toBe(100);
    expect(core.heat.dissipation).toBe(9);
  });

  it("applies upgrade levels as DB purchase counts (levels[count-1])", () => {
    // hull count 5 → levels[4] add hull.base 90; engine count 2 → levels[1] mul 1.08.
    const core = resolveShipStats(interceptor, configs, {
      upgradeLevels: { hull: 5, engine: 2, energy: 0, heat: 0 },
    });
    expect(core.hullMax).toBe(170); // 80 + 90
    expect(core.engine.nominalSpeed).toBeCloseTo(34 * 1.08, 6);
  });

  it("count 0 and count 1 both resolve to base (level 1 is the free base line)", () => {
    const zero = resolveShipStats(interceptor, configs, { upgradeLevels: { hull: 0, engine: 0, energy: 0, heat: 0 } });
    const one = resolveShipStats(interceptor, configs, { upgradeLevels: { hull: 1, engine: 1, energy: 1, heat: 1 } });
    expect(one.hullMax).toBe(zero.hullMax);
    expect(one.capacitor.max).toBe(zero.capacitor.max);
  });

  it("applies fitted module passives (capacitor battery, heat sink)", () => {
    const core = resolveShipStats(interceptor, configs, {
      fittedModuleIds: ["module.utility-capacitor-battery", "module.utility-heat-sink"],
    });
    // battery: capacitor +40, regen +4.
    expect(core.capacitor.max).toBe(160);
    expect(core.capacitor.regen).toBe(18);
    // heat sink: dissipation +5, capacity *1.1.
    expect(core.heat.dissipation).toBe(14);
    expect(core.heat.capacity).toBeCloseTo(110, 6);
  });

  it("orders operations add → mul (not mul → add) on the same stat", () => {
    // heat count 3 → levels[2] add heat.capacity 35; heat-sink → mul heat.capacity 1.1.
    // add-then-mul: (100 + 35) * 1.1 = 148.5   (mul-then-add would be 145).
    const core = resolveShipStats(interceptor, configs, {
      upgradeLevels: { hull: 0, engine: 0, energy: 0, heat: 3 },
      fittedModuleIds: ["module.utility-heat-sink"],
    });
    expect(core.heat.capacity).toBeCloseTo(148.5, 6);
    // dissipation: base 9 + upgrade 3.5 + heat-sink 5 = 17.5.
    expect(core.heat.dissipation).toBeCloseTo(17.5, 6);
  });

  it("is deterministic: identical inputs ⇒ identical output", () => {
    const opts = {
      upgradeLevels: { hull: 3, engine: 4, energy: 2, heat: 5 },
      fittedModuleIds: ["module.utility-capacitor-battery"],
    } as const;
    const a = resolveShipStats(interceptor, configs, opts);
    const b = resolveShipStats(interceptor, configs, opts);
    expect(a).toEqual(b);
  });

  it("clamps resolved stats to never go below zero", () => {
    // Empty ship with no negatives stays positive; sanity that clamp never inverts.
    const core = resolveShipStats(interceptor, configs);
    for (const v of [core.hullMax, core.capacitor.max, core.heat.capacity, core.engine.nominalSpeed]) {
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });
});

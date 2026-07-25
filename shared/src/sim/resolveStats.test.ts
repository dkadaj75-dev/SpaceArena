import { beforeAll, describe, expect, it } from "vitest";
import { ConfigService } from "../core/ConfigService.js";
import { shipSchema, type ShipConfig } from "../schemas/index.js";
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

/**
 * ROADMAP §11 6.1 — the rest of the "stat resolver" stack: the pipeline's edges
 * (clamping, missing configs, path normalisation, op stacking) rather than the
 * happy path already covered above.
 */
describe("resolveShipStats — pipeline edges", () => {
  it("clamps an upgrade purchase count to the last defined level", () => {
    // hull-std has 5 levels; buying "99" cannot exceed levels[4] (+90).
    const max = resolveShipStats(interceptor, configs, { upgradeLevels: { hull: 5, engine: 0, energy: 0, heat: 0 } });
    const overflow = resolveShipStats(interceptor, configs, { upgradeLevels: { hull: 99, engine: 0, energy: 0, heat: 0 } });
    expect(overflow.hullMax).toBe(max.hullMax);
    expect(overflow.hullMax).toBe(170);
  });

  it("applies all four tracks together without cross-talk", () => {
    const core = resolveShipStats(interceptor, configs, { upgradeLevels: { hull: 5, engine: 5, energy: 5, heat: 5 } });
    expect(core.hullMax).toBe(170); // 80 + 90
    expect(core.engine.nominalSpeed).toBeCloseTo(34 * 1.45, 6);
    expect(core.engine.accel).toBeCloseTo(22 * 1.3, 6);
    expect(core.capacitor.max).toBe(230); // 120 + 110
    expect(core.capacitor.regen).toBe(26); // 14 + 12
    expect(core.heat.capacity).toBe(190); // 100 + 90
    expect(core.heat.dissipation).toBe(18); // 9 + 9
    expect(core.heat.criticalDamagePerSec).toBe(4); // untouched by every track
  });

  it("ignores a track whose upgrade config does not exist (content gap ⇒ base stats, not a crash)", () => {
    const ghostTracks = shipSchema.parse({
      ...structuredClone(interceptor),
      id: "ship.ghosttracks",
      upgradeTracks: { hull: "upgrade.ghost", engine: "upgrade.ghost", energy: "upgrade.ghost", heat: "upgrade.ghost" },
    });
    const core = resolveShipStats(ghostTracks, configs, { upgradeLevels: { hull: 5, engine: 5, energy: 5, heat: 5 } });
    expect(core.hullMax).toBe(80);
    expect(core.capacitor.max).toBe(120);
  });

  it("skips empty hardpoints and unknown module ids in the fitting", () => {
    const base = resolveShipStats(interceptor, configs);
    const sparse = resolveShipStats(interceptor, configs, {
      fittedModuleIds: [null, undefined, "", "module.does-not-exist"],
    });
    expect(sparse).toEqual(base);
  });

  it("leaves hull resists to the ship config — no upgrade or passive touches them", () => {
    const core = resolveShipStats(interceptor, configs, {
      upgradeLevels: { hull: 5, engine: 5, energy: 5, heat: 5 },
      fittedModuleIds: ["module.utility-capacitor-battery", "module.utility-heat-sink"],
    });
    expect(core.resists).toEqual(interceptor.core.hull.resists);
  });

  it("returns a fresh, full core: hull = hullMax, capacitor full, heat cold, no shield", () => {
    const core = resolveShipStats(interceptor, configs, { upgradeLevels: { hull: 3, engine: 0, energy: 2, heat: 0 } });
    expect(core.hull).toBe(core.hullMax);
    expect(core.capacitor.cur).toBe(core.capacitor.max);
    expect(core.heat.cur).toBe(0);
    expect(core.shield).toBe(0);
    expect(core.shieldMax).toBe(0);
  });
});

describe("resolveShipStats — module passive ops", () => {
  let ops: ConfigService;

  /** Add a synthetic utility module carrying `passives` to the private service. */
  const addModule = (id: string, passives: unknown): void => {
    const res = ops.replace({
      id,
      type: "module",
      version: 1,
      family: "utility",
      level: 1,
      activation: { deployTime: 0, retractTime: 0 },
      energy: { drawIdle: 0, drawActive: 0 },
      heat: { perSecondActive: 0, overheatThreshold: 1, overheatCooldown: 0, overheatSelfDamage: 0 },
      passives,
      ui: { icon: "i", label: id },
      price: 0,
      requiresLevel: 1,
    });
    if (!res.ok) throw new Error(`fixture module ${id} rejected: ${JSON.stringify(res.errors)}`);
  };

  beforeAll(async () => {
    // Private ConfigService so the synthetic fixtures never leak into other tests.
    ops = await loadTestConfigs();
    addModule("module.test-coreprefix", [{ target: "core.energy.capacitor", op: "add", value: 10 }]);
    addModule("module.test-bighit", [{ target: "hull.base", op: "add", value: -1000 }]);
    addModule("module.test-unknownpath", [{ target: "shields.mega", op: "add", value: 99 }]);
    addModule("module.test-halfcap", [{ target: "energy.capacitor", op: "mul", value: 0.5 }]);
    addModule("module.test-plus30cap", [{ target: "energy.capacitor", op: "add", value: 30 }]);
  });

  it("accepts an optional leading `core.` on a passive target path", () => {
    const core = resolveShipStats(interceptor, ops, { fittedModuleIds: ["module.test-coreprefix"] });
    expect(core.capacitor.max).toBe(130);
  });

  it("clamps a stat driven negative to exactly 0 rather than inverting it", () => {
    const core = resolveShipStats(interceptor, ops, { fittedModuleIds: ["module.test-bighit"] });
    expect(core.hullMax).toBe(0);
    expect(core.hull).toBe(0);
  });

  it("ignores a passive targeting a stat path that is not part of the core", () => {
    const base = resolveShipStats(interceptor, ops);
    const core = resolveShipStats(interceptor, ops, { fittedModuleIds: ["module.test-unknownpath"] });
    expect(core).toEqual(base);
  });

  it("sums adds and multiplies muls across several fitted modules, add before mul", () => {
    // (120 + 30 + 40) * 0.5 = 95. Fitting order must not change the result.
    const forward = resolveShipStats(interceptor, ops, {
      fittedModuleIds: ["module.test-plus30cap", "module.utility-capacitor-battery", "module.test-halfcap"],
    });
    const reversed = resolveShipStats(interceptor, ops, {
      fittedModuleIds: ["module.test-halfcap", "module.utility-capacitor-battery", "module.test-plus30cap"],
    });
    expect(forward.capacitor.max).toBeCloseTo(95, 6);
    expect(reversed.capacitor.max).toBeCloseTo(95, 6);
  });

  it("stacks upgrade ops and passive ops on the same stat in one add→mul pass", () => {
    // energy count 5 → +110; battery → +40; half-cap → ×0.5 ⇒ (120+110+40)*0.5 = 135.
    const core = resolveShipStats(interceptor, ops, {
      upgradeLevels: { hull: 0, engine: 0, energy: 5, heat: 0 },
      fittedModuleIds: ["module.utility-capacitor-battery", "module.test-halfcap"],
    });
    expect(core.capacitor.max).toBeCloseTo(135, 6);
    expect(core.capacitor.cur).toBe(core.capacitor.max);
  });
});

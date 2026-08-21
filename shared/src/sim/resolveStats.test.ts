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
    expect(core.hullMax).toBe(120);
    expect(core.engine.nominalSpeed).toBe(27);
    // Hull-wide energy levers (2026-08-07): the light hull has no opinion, so
    // every multiplier is 1 and the modules' own numbers stand as authored.
    expect(core.recharge.multiplier).toBe(1);
    expect(core.energyStore.multiplier).toBe(1);
    // Sensor suite comes through the same pipeline as the engine (FLIGHT.md §2).
    expect(core.sensors).toEqual(interceptor.core.sensors);
  });

  it("applies upgrade levels as DB purchase counts (levels[count-1])", () => {
    // hull count 5 → levels[4] add hull.base 90; engine count 2 → levels[1] mul 1.08.
    const core = resolveShipStats(interceptor, configs, {
      upgradeLevels: { hull: 5, engine: 2, energy: 0 },
    });
    expect(core.hullMax).toBe(210); // 120 + 90
    expect(core.engine.nominalSpeed).toBeCloseTo(27 * 1.08, 6);
  });

  it("count 0 and count 1 both resolve to base (level 1 is the free base line)", () => {
    const zero = resolveShipStats(interceptor, configs, { upgradeLevels: { hull: 0, engine: 0, energy: 0 } });
    const one = resolveShipStats(interceptor, configs, { upgradeLevels: { hull: 1, engine: 1, energy: 1 } });
    expect(one.hullMax).toBe(zero.hullMax);
    expect(one.energyStore.multiplier).toBe(zero.energyStore.multiplier);
  });

  it("applies fitted module passives (capacitor battery)", () => {
    const core = resolveShipStats(interceptor, configs, {
      fittedModuleIds: ["module.utility-capacitor-battery"],
    });
    // battery: tanks x1.3.
    expect(core.energyStore.multiplier).toBeCloseTo(1.3, 6);
  });

  it("stacks multiplicative ops from a track and a passive on the same stat", () => {
    // energy count 3 -> levels[2] mul tanks 1.16; battery -> mul 1.3.
    const core = resolveShipStats(interceptor, configs, {
      upgradeLevels: { hull: 0, engine: 0, energy: 3 },
      fittedModuleIds: ["module.utility-capacitor-battery"],
    });
    expect(core.energyStore.multiplier).toBeCloseTo(1.16 * 1.3, 6);
  });

  it("is deterministic: identical inputs ⇒ identical output", () => {
    const opts = {
      upgradeLevels: { hull: 3, engine: 4, energy: 2 },
      fittedModuleIds: ["module.utility-capacitor-battery"],
    } as const;
    const a = resolveShipStats(interceptor, configs, opts);
    const b = resolveShipStats(interceptor, configs, opts);
    expect(a).toEqual(b);
  });

  it("clamps resolved stats to never go below zero", () => {
    // Empty ship with no negatives stays positive; sanity that clamp never inverts.
    const core = resolveShipStats(interceptor, configs);
    for (const v of [core.hullMax, core.energyStore.multiplier, core.recharge.multiplier, core.engine.nominalSpeed]) {
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
    const max = resolveShipStats(interceptor, configs, { upgradeLevels: { hull: 5, engine: 0, energy: 0 } });
    const overflow = resolveShipStats(interceptor, configs, { upgradeLevels: { hull: 99, engine: 0, energy: 0 } });
    expect(overflow.hullMax).toBe(max.hullMax);
    expect(overflow.hullMax).toBe(210);
  });

  it("applies all three tracks together without cross-talk", () => {
    const core = resolveShipStats(interceptor, configs, { upgradeLevels: { hull: 5, engine: 5, energy: 5 } });
    expect(core.hullMax).toBe(210); // 120 + 90
    expect(core.engine.nominalSpeed).toBeCloseTo(27 * 1.45, 6);
    expect(core.engine.accel).toBeCloseTo(18 * 1.3, 6);
    expect(core.energyStore.multiplier).toBeCloseTo(1.35, 6);
    expect(core.recharge.multiplier).toBeCloseTo(1.3, 6);
  });

  it("ignores a track whose upgrade config does not exist (content gap ⇒ base stats, not a crash)", () => {
    const ghostTracks = shipSchema.parse({
      ...structuredClone(interceptor),
      id: "ship.ghosttracks",
      upgradeTracks: { hull: "upgrade.ghost", engine: "upgrade.ghost", energy: "upgrade.ghost" },
    });
    const core = resolveShipStats(ghostTracks, configs, { upgradeLevels: { hull: 5, engine: 5, energy: 5 } });
    expect(core.hullMax).toBe(120);
    expect(core.energyStore.multiplier).toBe(1);
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
      upgradeLevels: { hull: 5, engine: 5, energy: 5 },
      fittedModuleIds: ["module.utility-capacitor-battery"],
    });
    expect(core.resists).toEqual(interceptor.core.hull.resists);
  });

  it("returns a fresh, full core: hull = hullMax and no innate shield", () => {
    const core = resolveShipStats(interceptor, configs, { upgradeLevels: { hull: 3, engine: 0, energy: 2 } });
    expect(core.hull).toBe(core.hullMax);
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
      name: id,
      activation: { deployTime: 0, retractTime: 0 },
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
    addModule("module.test-coreprefix", [{ target: "core.energyStore.multiplier", op: "add", value: 0.1 }]);
    addModule("module.test-bighit", [{ target: "hull.base", op: "add", value: -1000 }]);
    addModule("module.test-unknownpath", [{ target: "shields.mega", op: "add", value: 99 }]);
    addModule("module.test-halfcap", [{ target: "energyStore.multiplier", op: "mul", value: 0.5 }]);
    addModule("module.test-plus30cap", [{ target: "energyStore.multiplier", op: "add", value: 0.3 }]);
    addModule("module.test-sensorbooster", [
      { target: "sensors.lockRange", op: "add", value: 15 },
      { target: "core.sensors.lockTimeSec", op: "mul", value: 0.5 },
      { target: "sensors.coneDeg", op: "add", value: 10 },
    ]);
  });

  it("accepts an optional leading `core.` on a passive target path", () => {
    const core = resolveShipStats(interceptor, ops, { fittedModuleIds: ["module.test-coreprefix"] });
    expect(core.energyStore.multiplier).toBeCloseTo(1.1, 6);
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
    // (1 + 0.3) * 1.3 * 0.5 = 0.845. Fitting order must not change the result.
    const forward = resolveShipStats(interceptor, ops, {
      fittedModuleIds: ["module.test-plus30cap", "module.utility-capacitor-battery", "module.test-halfcap"],
    });
    const reversed = resolveShipStats(interceptor, ops, {
      fittedModuleIds: ["module.test-halfcap", "module.utility-capacitor-battery", "module.test-plus30cap"],
    });
    expect(forward.energyStore.multiplier).toBeCloseTo(0.845, 6);
    expect(reversed.energyStore.multiplier).toBeCloseTo(0.845, 6);
  });

  it("moves the resolved sensor stats from a module statOp (all three registration sites wired)", () => {
    // A stat only responds to statOps if it is in STAT_PATHS *and* the base bag
    // *and* the ShipCore mapping — miss one and the op silently no-ops, which is
    // exactly the failure this test exists to catch (FLIGHT.md §2).
    const base = resolveShipStats(interceptor, ops);
    const boosted = resolveShipStats(interceptor, ops, { fittedModuleIds: ["module.test-sensorbooster"] });
    expect(boosted.sensors.lockRange).toBeCloseTo(base.sensors.lockRange + 15, 6);
    expect(boosted.sensors.lockTimeSec).toBeCloseTo(base.sensors.lockTimeSec * 0.5, 6);
    expect(boosted.sensors.coneDeg).toBeCloseTo(base.sensors.coneDeg + 10, 6);
    // …and nothing else moved with them.
    expect(boosted.engine).toEqual(base.engine);
    expect(boosted.hullMax).toBe(base.hullMax);
  });

  it("stacks upgrade ops and passive ops on the same stat in one add→mul pass", () => {
    // energy count 5 → ×1.35; battery → ×1.3; half-cap → ×0.5.
    const core = resolveShipStats(interceptor, ops, {
      upgradeLevels: { hull: 0, engine: 0, energy: 5 },
      fittedModuleIds: ["module.utility-capacitor-battery", "module.test-halfcap"],
    });
    expect(core.energyStore.multiplier).toBeCloseTo(1.35 * 1.3 * 0.5, 6);
  });
});

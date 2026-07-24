import { describe, expect, it } from "vitest";
import type { ConfigService, ModuleConfig } from "@space-arena/shared";
import { boostMult, decodeModules } from "./NetGameSession.js";

/**
 * Sol review Finding 2 (HIGH) regression coverage: the replicated
 * `PlayerState.modules` array is sparse-safe (see `shared/src/sim/spawn.ts`),
 * so a fitting like `{0: laser, 2: shield}` only replicates 2 array entries
 * whose own `hardpointIndex` fields are 0 and 2 — `decodeModules` must never
 * synthesize `hardpointIndex` from array position, and must read `moduleId`/
 * `cycleTimer`/`shieldPool` verbatim off the wire (never from
 * `ship.defaultFitting`, which a saved Hangar fitting can differ from).
 */
describe("decodeModules (Finding 2 + 5)", () => {
  it("preserves true hardpointIndex for a sparse fitting instead of reindexing by array position", () => {
    const raw = [
      { hardpointIndex: 0, moduleId: "module.laser-mk1", state: 2, heat: 12, stateTimer: 0, cycleTimer: 0.1, shieldPool: 0 },
      { hardpointIndex: 2, moduleId: "module.shield-mk1", state: 2, heat: 3, stateTimer: 0, cycleTimer: 0, shieldPool: 8 },
    ];
    const modules = decodeModules(raw);
    expect(modules).toHaveLength(2);
    // hardpointIndex 0 and 2 survive — NOT reindexed to array positions 0 and 1.
    expect(modules.map((m) => m.hardpointIndex)).toEqual([0, 2]);
    expect(modules[1]!.hardpointIndex).toBe(2);
  });

  it("reads moduleId verbatim off the wire, never from a ship config's defaultFitting", () => {
    const raw = [{ hardpointIndex: 3, moduleId: "module.boost-mk2", state: 0, heat: 0, stateTimer: 0, cycleTimer: 0, shieldPool: 0 }];
    const modules = decodeModules(raw);
    // The old buggy path would have produced whatever id sat at array index 0
    // in some ship's defaultFitting — assert the actual replicated id instead.
    expect(modules[0]!.moduleId).toBe("module.boost-mk2");
  });

  it("wires replicated cycleTimer and shieldPool through per-module (Finding 5 — firing/shieldActive signals)", () => {
    const raw = [{ hardpointIndex: 0, moduleId: "module.laser-mk1", state: 2, heat: 0, stateTimer: 0, cycleTimer: 0.35, shieldPool: 0 }];
    const modules = decodeModules(raw);
    expect(modules[0]!.cycleTimer).toBe(0.35);
  });

  it("decodes the module state code (2 = active) via decodeModuleState", () => {
    const raw = [{ hardpointIndex: 0, moduleId: "module.laser-mk1", state: 2, heat: 0, stateTimer: 0, cycleTimer: 0, shieldPool: 0 }];
    expect(decodeModules(raw)[0]!.state).toBe("active");
  });

  it("defaults a missing shieldPool to 0 without dropping the module", () => {
    const raw = [{ hardpointIndex: 1, moduleId: "module.kinetic-mk1", state: 0, heat: 0, stateTimer: 0, cycleTimer: 0 }];
    expect(decodeModules(raw)[0]!.shieldPool).toBe(0);
  });

  it("accepts a Colyseus-style ArraySchema (a values()-bearing collection), not just a plain array", () => {
    const backing = [{ hardpointIndex: 0, moduleId: "module.laser-mk1", state: 2, heat: 0, stateTimer: 0, cycleTimer: 0, shieldPool: 0 }];
    const arraySchemaLike = { values: () => backing.values() };
    expect(decodeModules(arraySchemaLike)).toHaveLength(1);
    expect(decodeModules(arraySchemaLike)[0]!.hardpointIndex).toBe(0);
  });
});

/** Sol review Finding 4 (MED): boost multiplier must come from the fitted modules, not the ship's defaultFitting. */
describe("boostMult (Finding 4)", () => {
  function fakeConfigs(modules: Record<string, Partial<ModuleConfig>>): ConfigService {
    return {
      get: (_type: string, id: string) => modules[id] as ModuleConfig | undefined,
    } as unknown as ConfigService;
  }

  it("returns the boost module's speedMult when a boost module is among the FITTED ids", () => {
    const configs = fakeConfigs({
      "module.laser-mk1": {},
      "module.boost-mk1": { boost: { speedMult: 1.8, heatPerSec: 5 } },
    });
    expect(boostMult(configs, ["module.laser-mk1", "module.boost-mk1"])).toBe(1.8);
  });

  it("returns 1 when no fitted module has a boost block, even if other modules exist", () => {
    const configs = fakeConfigs({ "module.laser-mk1": {}, "module.shield-mk1": {} });
    expect(boostMult(configs, ["module.laser-mk1", "module.shield-mk1"])).toBe(1);
  });

  it("ignores a boost module that exists in the config registry but is NOT in the fitted id list", () => {
    // Regression: the old implementation read `ship.defaultFitting`, which
    // could include a boost module the player has since unfitted — a
    // Hangar-saved fit without a boost module must not get its speed bonus.
    const configs = fakeConfigs({ "module.boost-mk1": { boost: { speedMult: 1.8, heatPerSec: 5 } } });
    expect(boostMult(configs, ["module.laser-mk1"])).toBe(1);
  });
});

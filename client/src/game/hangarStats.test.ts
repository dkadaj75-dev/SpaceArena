import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { ConfigService, type ModuleConfig, type ShipConfig } from "@space-arena/shared";
import { computeStatPanel } from "./hangarStats.js";

// Mirrors shared/src/sim/testutil.ts's fsLoader (that file lives inside the
// `shared` package and isn't part of its public `@space-arena/shared` export
// surface, so client tests load the real content pack the same way rather
// than reaching across package boundaries). Locates `content/` by walking up
// from `process.cwd()` instead of resolving against `import.meta.url`:
// vitest's `happy-dom` environment (this project's test env) rewrites
// `new URL(relative, import.meta.url)` through Vite's dev-server `/@fs/`
// asset-URL shim, so it never resolves back to a real `file:` URL there
// (the same pattern works fine in `shared`'s plain-"node" test environment).
function findContentDir(start: string): string {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    if (existsSync(path.join(dir, "content", "manifest.json"))) return path.join(dir, "content");
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`content/manifest.json not found by walking up from ${start}`);
}
const CONTENT_DIR = findContentDir(process.cwd());
async function fsLoader(relPath: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(CONTENT_DIR, relPath), "utf8"));
}

let configs: ConfigService;
let interceptor: ShipConfig;

beforeAll(async () => {
  configs = new ConfigService(fsLoader);
  const result = await configs.load("manifest.json");
  if (!result.ok) throw new Error("test content failed to load: " + JSON.stringify(result.errors));
  interceptor = configs.get<ShipConfig>("ship", "ship.interceptor")!;
});

describe("computeStatPanel (Hangar stat panel)", () => {
  it("resolves base stats with an empty fit (no tanks, no dps)", () => {
    const panel = computeStatPanel(interceptor, configs, { fittedModuleIds: [] });
    expect(panel.hullMax).toBe(120);
    // Nothing fitted ⇒ nothing to store, nothing to cool, nothing to shoot.
    expect(panel.energyReserve).toBe(0);
    expect(panel.coolingMult).toBe(1);
    expect(panel.rechargeMult).toBe(1);
    expect(panel.burnSec).toBe(Infinity);
    expect(panel.dps).toBe(0);
  });

  it("rolls the per-module stores up across the default fitting", () => {
    const panel = computeStatPanel(interceptor, configs, { fittedModuleIds: interceptor.defaultFitting });
    const laser = configs.get<ModuleConfig>("module", "module.laser-mk1")!;
    const missile = configs.get<ModuleConfig>("module", "module.missile-mk1")!;
    // The light hull's stock fit: laser + missile on its two hardpoints, plus
    // the five stock internals. No fitted module carries an energy tank, and
    // the free radiator sets the hull's cooling multiplier.
    expect(panel.energyReserve).toBe(0);
    expect(panel.coolingMult).toBeCloseTo(1.6, 6);
    expect(panel.dps).toBeCloseTo(
      laser.fire!.damage / laser.fire!.cycleTime + missile.fire!.damage / missile.fire!.cycleTime,
      6,
    );
    // Sustained DPS is the same figure across a whole heat cycle, so it is
    // strictly smaller for any weapon that can cook itself.
    expect(panel.sustainedDps).toBeGreaterThan(0);
    expect(panel.sustainedDps).toBeLessThan(panel.dps);
    // …and both racks come back inside a few seconds.
    expect(panel.burnSec).toBeGreaterThan(2);
    expect(panel.recoverSec).toBeCloseTo(laser.heat!.capacity / (laser.heat!.coolingPerSec * 1.6), 6);
  });

  it("sums the tanks of a fit made entirely of shields", () => {
    // (computeStatPanel sums whatever it is handed; socket legality is the
    // Hangar's job, not the stat panel's.)
    const heavy = interceptor.defaultFitting.map(() => "module.shield-mk1");
    const shield = configs.get<ModuleConfig>("module", "module.shield-mk1")!;
    const panel = computeStatPanel(interceptor, configs, { fittedModuleIds: heavy });
    expect(panel.energyReserve).toBeCloseTo(shield.energy!.capacity * heavy.length, 6);
    expect(panel.burnSec).toBe(Infinity); // shields carry no heat at all
  });

  it("reflects fitted module passives (a battery deepens every module tank)", () => {
    const withBattery = computeStatPanel(interceptor, configs, {
      fittedModuleIds: ["module.shield-mk1", "module.utility-capacitor-battery"],
    });
    const bare = computeStatPanel(interceptor, configs, { fittedModuleIds: ["module.shield-mk1"] });
    expect(withBattery.energyReserve).toBeGreaterThan(bare.energyReserve);
  });

  it("applies upgrade levels through the same resolveShipStats pipeline", () => {
    const upgraded = computeStatPanel(interceptor, configs, {
      fittedModuleIds: [],
      upgradeLevels: { hull: 5, engine: 0, energy: 0, heat: 0 },
    });
    expect(upgraded.hullMax).toBe(210); // 120 + upgrade.hull-std levels[4] add 90
  });

  it("reports the power rail, and calls the stock fit comfortable (2026-07-31)", () => {
    const panel = computeStatPanel(interceptor, configs, { fittedModuleIds: interceptor.defaultFitting });
    expect(panel.powerCapacity).toBeGreaterThan(0);
    expect(panel.powerDrawTotal).toBeLessThanOrEqual(panel.powerCapacity);
    expect(panel.powerOverSubscribed).toBe(false);
  });

  it("flags an over-subscribed fit without pretending it is illegal", () => {
    // A heavy gun and two heavy shields on a light hull: buildable, saveable,
    // and simply cannot run whole — which is exactly what the warning says.
    const fit = [...interceptor.defaultFitting];
    fit[0] = "module.laser-mk2";
    fit[1] = "module.shield-mk2";
    fit[2] = "module.shield-mk2";
    const panel = computeStatPanel(interceptor, configs, { fittedModuleIds: fit });
    expect(panel.powerDrawTotal).toBeGreaterThan(panel.powerCapacity);
    expect(panel.powerOverSubscribed).toBe(true);
  });

  it("counts the transformer as the thing that widens the rail", () => {
    const swap = (t: string) =>
      interceptor.defaultFitting.map((m) => (m?.startsWith("module.transformer") ? t : m));
    const stock = computeStatPanel(interceptor, configs, { fittedModuleIds: swap("module.transformer-stock") });
    const better = computeStatPanel(interceptor, configs, { fittedModuleIds: swap("module.transformer-efficient") });
    expect(better.powerCapacity).toBeGreaterThan(stock.powerCapacity);
    expect(better.powerDrawTotal).toBe(stock.powerDrawTotal);
  });

  it("is deterministic for identical inputs", () => {
    const a = computeStatPanel(interceptor, configs, { fittedModuleIds: interceptor.defaultFitting });
    const b = computeStatPanel(interceptor, configs, { fittedModuleIds: interceptor.defaultFitting });
    expect(a).toEqual(b);
  });
});

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { ConfigService, type ShipConfig } from "@space-arena/shared";
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
  it("resolves base stats with an empty fit (no idle draw, no dps)", () => {
    const panel = computeStatPanel(interceptor, configs, { fittedModuleIds: [] });
    expect(panel.hullMax).toBe(80);
    expect(panel.capacitorMax).toBe(120);
    expect(panel.idleDrawTotal).toBe(0);
    expect(panel.energyBudget).toBe(panel.capacitorRegen);
    expect(panel.dps).toBe(0);
  });

  it("sums idle draw and dps across the default fitting", () => {
    const panel = computeStatPanel(interceptor, configs, { fittedModuleIds: interceptor.defaultFitting });
    // The light hull's stock fit: laser + missile on its two hardpoints, plus
    // the five stock internals. Weapons idle free (heat is their budget) and the
    // stock internals draw nothing at idle either, so the whole fit is free to
    // simply carry — you pay when you pull the trigger.
    expect(panel.idleDrawTotal).toBe(0);
    expect(panel.energyBudget).toBe(panel.capacitorRegen);
    // laser 7/0.4 + missile 22/2.5 = 17.5 + 8.8 = 26.3 (internals do not fire).
    expect(panel.dps).toBeCloseTo(7 / 0.4 + 22 / 2.5, 6);
  });

  it("flags a negative energy budget when idle draw exceeds regen", () => {
    // Shields carry the heaviest idle draw, so a rack of them forces a deficit.
    // (computeStatPanel sums whatever it is handed; socket legality is the
    // Hangar's job, not the stat panel's.)
    const heavy = interceptor.defaultFitting.map(() => "module.shield-mk1");
    const panel = computeStatPanel(interceptor, configs, { fittedModuleIds: heavy });
    expect(panel.idleDrawTotal).toBe(12 * heavy.length);
    expect(panel.energyBudget).toBeLessThan(0);
  });

  it("reflects fitted module passives (capacitor battery raises capacitor + regen)", () => {
    const withBattery = computeStatPanel(interceptor, configs, {
      fittedModuleIds: ["module.utility-capacitor-battery"],
    });
    const empty = computeStatPanel(interceptor, configs, { fittedModuleIds: [] });
    expect(withBattery.capacitorMax).toBe(empty.capacitorMax + 40);
    expect(withBattery.capacitorRegen).toBe(empty.capacitorRegen + 4);
  });

  it("applies upgrade levels through the same resolveShipStats pipeline", () => {
    const upgraded = computeStatPanel(interceptor, configs, {
      fittedModuleIds: [],
      upgradeLevels: { hull: 5, engine: 0, energy: 0, heat: 0 },
    });
    expect(upgraded.hullMax).toBe(170); // 80 + upgrade.hull-std levels[4] add 90
  });

  it("reports the power rail, and calls the stock fit comfortable (2026-07-31)", () => {
    const panel = computeStatPanel(interceptor, configs, { fittedModuleIds: interceptor.defaultFitting });
    expect(panel.powerCapacity).toBeGreaterThan(0);
    expect(panel.powerDrawTotal).toBeLessThanOrEqual(panel.powerCapacity);
    expect(panel.powerOverSubscribed).toBe(false);
  });

  it("flags an over-subscribed fit without pretending it is illegal", () => {
    // A heavy gun AND a heavy shield on a light hull: buildable, saveable, and
    // simply cannot run whole — which is exactly what the warning says.
    const fit = [...interceptor.defaultFitting];
    fit[0] = "module.laser-mk2";
    fit[1] = "module.shield-mk2";
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

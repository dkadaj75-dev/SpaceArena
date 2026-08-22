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
  // These cases assert that the panel ROLLS UP the fitted modules' authored
  // numbers. A hull's `core.combat` role profile scales exactly those (outgoing
  // damage, rate of fire, shield reserve) and is designer-tuned content the F10
  // tool writes, so a tuning pass must not turn this suite red. Strip it in
  // memory — `replace` never touches disk. (Mirrors `clearCombatProfiles` in
  // shared/src/sim/testutil.ts, which this package cannot import.)
  for (const ship of configs.getAll<ShipConfig>("ship")) {
    if (!ship.core.combat) continue;
    const core = { ...ship.core };
    delete (core as Record<string, unknown>)["combat"];
    const stripped = configs.replace({ ...ship, core });
    if (!stripped.ok) throw new Error("strip combat: " + JSON.stringify(stripped.errors));
  }
  interceptor = configs.get<ShipConfig>("ship", "ship.interceptor")!;
});

describe("computeStatPanel (Hangar stat panel)", () => {
  it("resolves base stats with an empty fit (no tanks, no dps)", () => {
    const panel = computeStatPanel(interceptor, configs, { fittedModuleIds: [] });
    expect(panel.hullMax).toBe(120);
    // Nothing fitted ⇒ nothing to store, nothing to shoot.
    expect(panel.energyReserve).toBe(0);
    expect(panel.rechargeMult).toBe(1);
    expect(panel.dps).toBe(0);
    expect(panel.sustainedDps).toBe(0);
  });

  it("rolls the per-module stores up across the default fitting", () => {
    const panel = computeStatPanel(interceptor, configs, { fittedModuleIds: interceptor.defaultFitting });
    const laser = configs.get<ModuleConfig>("module", "module.laser-mk1")!;
    const missile = configs.get<ModuleConfig>("module", "module.missile-mk1")!;
    // The light hull's stock fit: laser + missile on its two hardpoints, plus
    // the five stock internals. Weapons carry no tank at all, so the whole
    // reserve is the ENGINE's boost bottle — every mark of the Earth Engine
    // line carries the same afterburner (owner 2026-08-22), the baseline mark
    // included, so the stock hull now leaves the pad with a charged bottle.
    const engine = configs.get<ModuleConfig>("module", "module.engine-earth-eng1")!;
    expect(panel.energyReserve).toBe(engine.energy!.capacity);
    expect(panel.dps).toBeCloseTo(
      laser.fire!.damage / laser.fire!.cycleTime + missile.fire!.damage / missile.fire!.cycleTime,
      6,
    );
    // Neither stock weapon carries a clip, and since heat was deleted
    // (2026-08-20) a clipless weapon's held trigger delivers its nominal rate
    // forever — so the two figures are the same number.
    expect(panel.sustainedDps).toBeCloseTo(panel.dps, 6);
  });

  it("accounts for kinetic reload downtime while retaining burst DPS", () => {
    const gun = configs.get<ModuleConfig>("module", "module.kinetic-mk1")!;
    const panel = computeStatPanel(interceptor, configs, { fittedModuleIds: [gun.id] });
    const burst = gun.fire!.damage / gun.fire!.cycleTime;
    const clipLimited = gun.fire!.damage * gun.fire!.clip!.size /
      ((gun.fire!.clip!.size - 1) * gun.fire!.cycleTime + gun.fire!.clip!.reloadSec);
    expect(panel.dps).toBeCloseTo(burst, 6);
    expect(panel.sustainedDps).toBeLessThanOrEqual(clipLimited + 1e-9);
  });

  it("sums the tanks of a fit made entirely of shields", () => {
    // (computeStatPanel sums whatever it is handed; socket legality is the
    // Hangar's job, not the stat panel's.)
    const heavy = interceptor.defaultFitting.map(() => "module.shield-mk1");
    const shield = configs.get<ModuleConfig>("module", "module.shield-mk1")!;
    const panel = computeStatPanel(interceptor, configs, { fittedModuleIds: heavy });
    expect(panel.energyReserve).toBeCloseTo(shield.energy!.capacity * heavy.length, 6);
    expect(panel.dps).toBe(0); // a shield does not shoot
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
      upgradeLevels: { hull: 5, engine: 0, energy: 0 },
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

  it("quotes the rail as a HULL property no alloy can widen (2026-08-22)", () => {
    const swap = (t: string) =>
      interceptor.defaultFitting.map((m) => (m?.startsWith("module.alloy-") ? t : m));
    const stock = computeStatPanel(interceptor, configs, { fittedModuleIds: swap("module.alloy-earth-p1") });
    const heavy = computeStatPanel(interceptor, configs, { fittedModuleIds: swap("module.alloy-martian-p4") });
    // The transformer used to feed the rail and this test used to prove it.
    // With that family retired the rail is authored on the airframe, so the
    // strongest alloy in the game moves the hull, the speed and the resists —
    // and leaves the power budget exactly where it found it.
    expect(heavy.powerCapacity).toBe(stock.powerCapacity);
    expect(heavy.powerDrawTotal).toBe(stock.powerDrawTotal);
    expect(heavy.hullMax).toBeGreaterThan(stock.hullMax);
  });

  it("shows the resolved resists, which the alloy bay is the first thing to move", () => {
    const swap = (t: string) =>
      interceptor.defaultFitting.map((m) => (m?.startsWith("module.alloy-") ? t : m));
    const stock = computeStatPanel(interceptor, configs, { fittedModuleIds: swap("module.alloy-earth-p1") });
    const martian = computeStatPanel(interceptor, configs, { fittedModuleIds: swap("module.alloy-martian-p4") });
    const lunar = computeStatPanel(interceptor, configs, { fittedModuleIds: swap("module.alloy-lunar-p4") });
    // Martian hardens against kinetic; Lunar softens against it. The panel must
    // quote the RESOLVED column, not the hull's authored one, or the effective
    // HP beside it would describe a ship nobody is flying.
    expect(martian.resistKinetic).toBeGreaterThan(stock.resistKinetic);
    expect(lunar.resistKinetic).toBeLessThan(stock.resistKinetic);
    expect(martian.ehpApprox).toBeGreaterThan(stock.ehpApprox);
  });

  it("reads the Earth alloy's 'Shields' column as the hull's shield reserve", () => {
    const swap = (t: string) =>
      interceptor.defaultFitting.map((m) => (m?.startsWith("module.alloy-") ? t : m));
    const fit = (alloy: string) => {
      const ids = swap(alloy);
      ids[1] = "module.shield-mk1"; // the light hull's stock fit carries no shield
      return computeStatPanel(interceptor, configs, { fittedModuleIds: ids });
    };
    const stock = fit("module.alloy-earth-p1");
    const plated = fit("module.alloy-earth-p4");
    expect(plated.shieldEfficiency).toBeCloseTo(stock.shieldEfficiency * 1.2, 9);
    // …and because a shield's reserve IS its tank, the rolled-up tank total
    // moves with it. That is the whole reason "Shields %" maps here.
    expect(plated.energyReserve).toBeGreaterThan(stock.energyReserve);
  });

  it("is deterministic for identical inputs", () => {
    const a = computeStatPanel(interceptor, configs, { fittedModuleIds: interceptor.defaultFitting });
    const b = computeStatPanel(interceptor, configs, { fittedModuleIds: interceptor.defaultFitting });
    expect(a).toEqual(b);
  });
});

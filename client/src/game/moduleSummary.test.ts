import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { ConfigService, type ModuleConfig } from "@space-arena/shared";
import { moduleDps, moduleHeatPerSec, moduleStats, moduleSummaryLine } from "./moduleSummary.js";

/** Same content loader as `hangarStats.test.ts` — see the note there. */
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

let configs: ConfigService;
beforeAll(async () => {
  configs = new ConfigService(async (rel) => JSON.parse(await readFile(path.join(CONTENT_DIR, rel), "utf8")));
  const res = await configs.load("manifest.json");
  if (!res.ok) throw new Error("content failed to load: " + JSON.stringify(res.errors));
});

const mod = (id: string): ModuleConfig => configs.get<ModuleConfig>("module", id)!;
const labels = (id: string): string[] => moduleStats(mod(id)).map((s) => s.label);
const valueOf = (id: string, label: string): string | undefined =>
  moduleStats(mod(id)).find((s) => s.label === label)?.value;

describe("moduleDps", () => {
  it("is damage over the cycle for a discrete weapon", () => {
    const laser = mod("module.laser-mk1");
    expect(moduleDps(laser)).toBeCloseTo(laser.fire!.damage / laser.fire!.cycleTime, 9);
  });

  it("is the authored figure for a continuous weapon — its `damage` IS dps", () => {
    const beam = mod("module.beamlaser-mk1");
    expect(moduleDps(beam)).toBe(beam.fire!.damage);
  });

  it("is 0 for anything that does not shoot", () => {
    expect(moduleDps(mod("module.shield-mk1"))).toBe(0);
    expect(moduleDps(mod("module.generator-heavy"))).toBe(0);
  });
});

describe("moduleHeatPerSec", () => {
  it("folds a weapon's per-shot heat into its cadence", () => {
    const laser = mod("module.laser-mk1");
    const expected = laser.heat!.perSecondActive + laser.heat!.perShot / laser.fire!.cycleTime;
    expect(moduleHeatPerSec(laser)).toBeCloseTo(expected, 9);
    // A weapon firing flat out is hotter than its idle-active rate alone.
    expect(moduleHeatPerSec(laser)).toBeGreaterThan(laser.heat!.perSecondActive);
  });

  it("is 0 for a module with no heat store at all", () => {
    // Boost is priced in ENERGY since 2026-08-07 — a boosting engine authors no
    // heat block, and neither do shields, generators or sensors.
    expect(moduleHeatPerSec(mod("module.engine-sport"))).toBe(0);
    expect(moduleHeatPerSec(mod("module.shield-mk1"))).toBe(0);
  });
});

describe("moduleStats — the numbers each family is judged on", () => {
  it("shows a weapon's dps, range, power and its thermal rhythm", () => {
    expect(labels("module.laser-mk1")).toEqual(["DPS", "Range", "Power", "Burn", "Cool"]);
    // 7.2 → 14.5 on 2026-08-14: `fire.damage` × 2 across the catalogue, so the
    // chip quotes 7.24 per shot every 0.5 s.
    expect(valueOf("module.laser-mk1", "DPS")).toBe("14.5");
    // "Power" is the flat rail current the module holds while online; "Burn" and
    // "Cool" are the seconds a pilot actually feels (2026-08-07). A weapon has
    // no energy chip at all — it costs none.
    expect(valueOf("module.laser-mk1", "Power")).toBe("2.5");
    expect(labels("module.laser-mk1")).not.toContain("Tank");
  });

  it("shows a shield's mitigation and the tank that IS its reserve", () => {
    const shown = labels("module.shield-mk1");
    expect(shown).toContain("Absorb");
    expect(shown).toContain("Tank");
    expect(shown).toContain("Lasts");
    expect(shown).toContain("Refill");
    expect(valueOf("module.shield-mk1", "Absorb")).toBe("50%");
  });

  it("shows an engine's boost and the stats it moves, as percentages", () => {
    const shown = labels("module.engine-sport");
    expect(shown).toContain("Boost");
    expect(shown).toContain("Speed");
    expect(shown).toContain("Turn");
    expect(valueOf("module.engine-sport", "Speed")).toBe("+15%");
    expect(valueOf("module.engine-sport", "Turn")).toBe("−8%");
  });

  it("shows a generator's recharge gain AND the speed it costs", () => {
    expect(valueOf("module.generator-heavy", "Recharge")).toBe("+70%");
    expect(valueOf("module.generator-heavy", "Tanks")).toBe("+20%");
    expect(valueOf("module.generator-heavy", "Speed")).toBe("−12%");
  });

  it("shows a transformer's two-sided trade", () => {
    expect(valueOf("module.transformer-efficient", "Draw")).toBe("−22%");
    expect(valueOf("module.transformer-efficient", "Heat")).toBe("+25%");
    expect(valueOf("module.transformer-cryo", "Heat")).toBe("−30%");
    expect(valueOf("module.transformer-cryo", "Draw")).toBe("+20%");
  });

  it("advertises a heatsink's jettison cooldown, and says nothing about it when there is none", () => {
    expect(valueOf("module.heatsink-ablative", "Jettison")).toBe("25s");
    expect(labels("module.heatsink-basic")).not.toContain("Jettison");
    expect(valueOf("module.heatsink-cryo", "Cooling")).toBe("+110%");
  });

  it("shows sensor reach and lock time", () => {
    expect(valueOf("module.sensors-longrange", "Range")).toBe("+30%");
    expect(valueOf("module.sensors-longrange", "Lock time")).toBe("+25%");
    expect(valueOf("module.sensors-snap", "Lock time")).toBe("−40%");
  });

  it("never returns an empty summary for a shipped module", () => {
    for (const cfg of configs.getAll<ModuleConfig>("module")) {
      expect(moduleSummaryLine(cfg), cfg.id).not.toBe("");
    }
  });
});

describe("moduleSummaryLine", () => {
  // The chip line quotes the module's OWN numbers, with no hull multiplier and
  // no heatsink: 2.2 s of burn and 4 s to cool bare. On the free kit (radiator
  // ×1.6) the same rack burns ~5 s and cools in 2.5 s — see the feel bench.
  it("joins the chips into one readable line", () => {
    expect(moduleSummaryLine(mod("module.laser-mk1"))).toBe(
      "DPS 14.5 · Range 95 · Power 2.5 · Burn 2.2s · Cool 4s",
    );
  });

  it("falls back to a plain phrase for a module with nothing to show", () => {
    const inert = { ...mod("module.transformer-stock"), passives: [] } as ModuleConfig;
    expect(moduleSummaryLine(inert)).toBe("No active effect");
  });
});

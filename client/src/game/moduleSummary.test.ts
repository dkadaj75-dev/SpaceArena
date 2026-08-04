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
    const expected = laser.heat.perSecondActive + laser.fire!.heatPerShot! / laser.fire!.cycleTime;
    expect(moduleHeatPerSec(laser)).toBeCloseTo(expected, 9);
    // A weapon firing flat out is hotter than its idle-active rate alone.
    expect(moduleHeatPerSec(laser)).toBeGreaterThan(laser.heat.perSecondActive);
  });

  it("uses a boosting engine's own boost heat", () => {
    const sport = mod("module.engine-sport");
    expect(moduleHeatPerSec(sport)).toBe(sport.boost!.heatPerSec);
  });
});

describe("moduleStats — the numbers each family is judged on", () => {
  it("shows a weapon's dps, range, power, energy and heat", () => {
    expect(labels("module.laser-mk1")).toEqual(["DPS", "Range", "Power", "Energy", "Heat"]);
    expect(valueOf("module.laser-mk1", "DPS")).toBe("27.5");
    // The two energy axes read differently on purpose: "Power" is the flat rail
    // current the module holds while online, "Energy" the per-second capacitor
    // drain it costs to run.
    expect(valueOf("module.laser-mk1", "Power")).toBe("2.5");
    expect(valueOf("module.laser-mk1", "Energy")).toBe("11/s");
  });

  it("shows a shield's mitigation and its pool", () => {
    const shown = labels("module.shield-mk1");
    expect(shown).toContain("Absorb");
    expect(shown).toContain("Pool");
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

  it("shows a generator's energy gain AND the speed it costs", () => {
    expect(valueOf("module.generator-heavy", "Capacity")).toBe("+70");
    expect(valueOf("module.generator-heavy", "Regen")).toBe("+9");
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
    expect(valueOf("module.heatsink-cryo", "Cooling")).toBe("+9");
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
  it("joins the chips into one readable line", () => {
    expect(moduleSummaryLine(mod("module.laser-mk1"))).toBe(
      "DPS 27.5 · Range 95 · Power 2.5 · Energy 11/s · Heat 49.5/s",
    );
  });

  it("falls back to a plain phrase for a module with nothing to show", () => {
    const inert = { ...mod("module.transformer-stock"), passives: [] } as ModuleConfig;
    expect(moduleSummaryLine(inert)).toBe("No active effect");
  });
});

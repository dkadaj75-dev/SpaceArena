import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { ConfigService, type ModuleConfig } from "@space-arena/shared";
import { moduleDps, moduleStats, moduleSummaryLine } from "./moduleSummary.js";

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

describe("moduleStats — the numbers each family is judged on", () => {
  it("shows a weapon's dps, range, cycle time and power", () => {
    expect(labels("module.laser-mk1")).toEqual(["DPS", "Range", "Cycle", "Power"]);
    // 7.2 → 14.5 on 2026-08-14 (`fire.damage` × 2 across the catalogue), then
    // 14.5 → 29 on 2026-08-16 (the owner's blanket laser × 2), then 29 → 37.6 on
    // 2026-08-18 (laser × 1.3): the chip quotes 18.82 per shot every 0.5 s.
    // Purely derived — `moduleStats` reads the authored damage and cycleTime, so
    // this literal tracks content and pins nothing of its own.
    expect(valueOf("module.laser-mk1", "DPS")).toBe("37.6");
    // "Power" is the flat rail current the module holds while online; "Cycle"
    // is the weapon's ONLY limiter since heat was deleted (2026-08-20). A weapon
    // has no energy chip at all — it costs none.
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
    expect(valueOf("module.transformer-efficient", "Power")).toBe("+10");
    expect(valueOf("module.transformer-cryo", "Draw")).toBe("+20%");
    expect(valueOf("module.transformer-cryo", "Power")).toBe("+6");
  });

  it("advertises a countermeasure pod's jettison cooldown", () => {
    expect(valueOf("module.countermeasure-chaff", "Jettison")).toBe("25s");
    expect(valueOf("module.countermeasure-flare", "Jettison")).toBe("30s");
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

describe("the support pulses (owner 2026-08-22)", () => {
  it("quotes the slowing ray as how much, for how long, how far and the wait", () => {
    expect(labels("module.ray-slow-mk1")).toEqual(["Slow", "For", "Range", "Cooldown", "Power"]);
    expect(valueOf("module.ray-slow-mk1", "Slow")).toBe("−35%");
    expect(valueOf("module.ray-slow-mk1", "For")).toBe("4s");
    expect(valueOf("module.ray-slow-mk1", "Cooldown")).toBe("12s");
  });

  it("quotes the repair field as hull given, how wide, and the wait", () => {
    expect(labels("module.field-repair-mk1")).toEqual(["Repair", "Radius", "Cooldown", "Power"]);
    expect(valueOf("module.field-repair-mk1", "Repair")).toBe("+40");
    expect(valueOf("module.field-repair-mk1", "Radius")).toBe("45");
  });

  it("never reports a tank for either — a pulse is limited by its cooldown alone", () => {
    for (const id of ["module.ray-slow-mk1", "module.field-repair-mk1"]) {
      expect(labels(id)).not.toContain("Tank");
      expect(mod(id).energy).toBeUndefined();
    }
  });
});

describe("moduleSummaryLine", () => {
  // The chip line quotes the module's OWN numbers, with no hull multiplier
  // applied.
  it("joins the chips into one readable line", () => {
    expect(moduleSummaryLine(mod("module.laser-mk1"))).toBe(
      // DPS tracks the authored laser damage (× 1.3 on 2026-08-18); Cycle
      // replaced the old Burn/Cool pair when heat was deleted (2026-08-20).
      "DPS 37.6 · Range 95 · Cycle 0.50s · Power 2.5",
    );
  });

  it("falls back to a plain phrase for a module with nothing to show", () => {
    const inert = { ...mod("module.transformer-stock"), passives: [] } as ModuleConfig;
    expect(moduleSummaryLine(inert)).toBe("No active effect");
  });
});

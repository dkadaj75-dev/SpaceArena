import { beforeAll, describe, expect, it } from "vitest";
import type { ConfigService } from "../core/ConfigService.js";
import { botCosmeticFor, universalCosmetics } from "../content/cosmetics.js";
import { STANDARD_COSMETIC_ID } from "../schemas/cosmetic.js";
import { ArenaSimulation } from "./ArenaSimulation.js";
import { INTERCEPTOR_FITTING, loadTestConfigs } from "./testutil.js";

let configs: ConfigService;
beforeAll(async () => {
  configs = await loadTestConfigs();
});

function sim(): ArenaSimulation {
  return new ArenaSimulation(configs, "arena.ring-nebula", "gamemode.practice-bots-1v1", 7);
}

function paintOf(s: ArenaSimulation, id: number): string | undefined {
  return s.snapshot().ships.find((ship) => ship.id === id)?.cosmeticId;
}

describe("cosmetic replication — offline spawn seam", () => {
  it("carries an equipped paint onto the ship snapshot", () => {
    const s = sim();
    const id = s.spawnPlayer("ship.interceptor", INTERCEPTOR_FITTING, 0, undefined, "cosmetic.paint-crimson");
    expect(paintOf(s, id)).toBe("cosmetic.paint-crimson");
  });

  it("leaves the field ABSENT for the standard paint and for no selection at all", () => {
    const s = sim();
    const plain = s.spawnPlayer("ship.interceptor", INTERCEPTOR_FITTING, 0);
    const standard = s.spawnPlayer("ship.interceptor", INTERCEPTOR_FITTING, 0, undefined, STANDARD_COSMETIC_ID);
    expect(paintOf(s, plain)).toBeUndefined();
    expect(paintOf(s, standard)).toBeUndefined();
  });

  it("sanitizes an unknown id and a paint the hull may not wear back to standard", () => {
    const s = sim();
    const bogus = s.spawnPlayer("ship.interceptor", INTERCEPTOR_FITTING, 0, undefined, "cosmetic.paint-nonexistent");
    // paint-ironclad is authored `appliesTo: ["ship.brawler"]`.
    const wrongHull = s.spawnPlayer("ship.interceptor", INTERCEPTOR_FITTING, 0, undefined, "cosmetic.paint-ironclad");
    expect(paintOf(s, bogus)).toBeUndefined();
    expect(paintOf(s, wrongHull)).toBeUndefined();
  });

  it("keeps the paint across a respawn — the record, not the entity, wears it", () => {
    const s = sim();
    const id = s.spawnPlayer("ship.interceptor", INTERCEPTOR_FITTING, 0, undefined, "cosmetic.paint-void");
    expect(paintOf(s, id)).toBe("cosmetic.paint-void");
    s.removeShip(id);
    const again = s.spawnPlayer("ship.interceptor", INTERCEPTOR_FITTING, 0, undefined, "cosmetic.paint-void");
    expect(paintOf(s, again)).toBe("cosmetic.paint-void");
  });
});

describe("bot paints", () => {
  it("are deterministic for the same seed + slot and drawn only from universal paints", () => {
    const pool = new Set(universalCosmetics(configs).map((c) => c.id));
    expect(pool.size).toBeGreaterThanOrEqual(6);
    for (let slot = 0; slot < 8; slot++) {
      const first = botCosmeticFor(configs, 1234, slot);
      expect(botCosmeticFor(configs, 1234, slot)).toBe(first);
      expect(pool.has(first!)).toBe(true);
    }
  });

  it("varies across slots and across seeds, so a roster is not one colour", () => {
    const perSlot = new Set(Array.from({ length: 8 }, (_, i) => botCosmeticFor(configs, 1234, i)));
    expect(perSlot.size).toBeGreaterThan(1);
    const perSeed = new Set(Array.from({ length: 8 }, (_, i) => botCosmeticFor(configs, i * 977 + 1, 0)));
    expect(perSeed.size).toBeGreaterThan(1);
  });
});

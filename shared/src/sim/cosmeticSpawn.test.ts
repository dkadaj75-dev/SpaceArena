import { beforeAll, describe, expect, it } from "vitest";
import type { ConfigService } from "../core/ConfigService.js";
import { botCosmeticFor, cosmeticsForShip } from "../content/cosmetics.js";
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
    const id = s.spawnPlayer("ship.interceptor", INTERCEPTOR_FITTING, 0, undefined, "cosmetic.paint-interceptor-red");
    expect(paintOf(s, id)).toBe("cosmetic.paint-interceptor-red");
  });

  it("replicates the hull base paint for no selection", () => {
    const s = sim();
    const plain = s.spawnPlayer("ship.interceptor", INTERCEPTOR_FITTING, 0);
    expect(paintOf(s, plain)).toBe("cosmetic.paint-interceptor-standard");
  });

  it("sanitizes an unknown id and a paint the hull may not wear back to standard", () => {
    const s = sim();
    const bogus = s.spawnPlayer("ship.interceptor", INTERCEPTOR_FITTING, 0, undefined, "cosmetic.paint-nonexistent");
    // The Ironclad paint targets ship.brawler.
    const wrongHull = s.spawnPlayer("ship.interceptor", INTERCEPTOR_FITTING, 0, undefined, "cosmetic.paint-brawler-red");
    expect(paintOf(s, bogus)).toBe("cosmetic.paint-interceptor-standard");
    expect(paintOf(s, wrongHull)).toBe("cosmetic.paint-interceptor-standard");
  });

  it("keeps the paint across a respawn — the record, not the entity, wears it", () => {
    const s = sim();
    const id = s.spawnPlayer("ship.interceptor", INTERCEPTOR_FITTING, 0, undefined, "cosmetic.paint-interceptor-blue");
    expect(paintOf(s, id)).toBe("cosmetic.paint-interceptor-blue");
    s.removeShip(id);
    const again = s.spawnPlayer("ship.interceptor", INTERCEPTOR_FITTING, 0, undefined, "cosmetic.paint-interceptor-blue");
    expect(paintOf(s, again)).toBe("cosmetic.paint-interceptor-blue");
  });
});

describe("bot paints", () => {
  it("are deterministic for the same seed + slot and drawn only from the target ship", () => {
    const pool = new Set(cosmeticsForShip(configs, "ship.interceptor").map((c) => c.id));
    expect(pool.size).toBeGreaterThanOrEqual(5);
    for (let slot = 0; slot < 8; slot++) {
      const first = botCosmeticFor(configs, "ship.interceptor", 1234, slot);
      expect(botCosmeticFor(configs, "ship.interceptor", 1234, slot)).toBe(first);
      expect(pool.has(first!)).toBe(true);
    }
  });

  it("varies across slots and across seeds, so a roster is not one colour", () => {
    const perSlot = new Set(Array.from({ length: 8 }, (_, i) => botCosmeticFor(configs, "ship.interceptor", 1234, i)));
    expect(perSlot.size).toBeGreaterThan(1);
    const perSeed = new Set(Array.from({ length: 8 }, (_, i) => botCosmeticFor(configs, "ship.interceptor", i * 977 + 1, 0)));
    expect(perSeed.size).toBeGreaterThan(1);
  });
});

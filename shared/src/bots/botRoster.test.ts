import { beforeAll, describe, expect, it } from "vitest";
import type { ConfigService } from "../core/ConfigService.js";
import { hardpointsOf, isInternalFamily, type ModuleConfig, type ShipConfig } from "../schemas/index.js";
import { deriveRng } from "../sim/rng.js";
import { loadTestConfigs } from "../sim/testutil.js";
import { generateBotName, generateBotNames } from "./botNames.js";
import { MAX_BOT_MODULE_LEVEL, pickBotShip, randomBotFitting } from "./botLoadout.js";

let configs: ConfigService;
beforeAll(async () => {
  configs = await loadTestConfigs();
});

describe("generateBotName (owner 2026-07-31)", () => {
  it("is deterministic for a given stream", () => {
    expect(generateBotName(deriveRng(7, 1))).toBe(generateBotName(deriveRng(7, 1)));
  });

  it("produces plausible handles: non-empty, no whitespace, sane length", () => {
    const rng = deriveRng(42, 1);
    for (let i = 0; i < 200; i++) {
      const name = generateBotName(rng);
      expect(name.length).toBeGreaterThan(2);
      expect(name.length).toBeLessThanOrEqual(24);
      expect(name).not.toMatch(/\s/);
    }
  });

  it("varies — a roster is not twenty copies of one name", () => {
    const rng = deriveRng(11, 1);
    const names = new Set(Array.from({ length: 40 }, () => generateBotName(rng)));
    expect(names.size).toBeGreaterThan(20);
  });
});

describe("generateBotNames", () => {
  it("returns exactly `count` names, all distinct", () => {
    const names = generateBotNames(deriveRng(3, 1), 10);
    expect(names).toHaveLength(10);
    expect(new Set(names).size).toBe(10);
  });

  it("still returns distinct names when the pool would collide", () => {
    // A degenerate stream makes every raw roll identical; the disambiguator
    // must still hand back unique names rather than looping forever.
    const constantRng = () => 0;
    const names = generateBotNames(constantRng, 5);
    expect(names).toHaveLength(5);
    expect(new Set(names).size).toBe(5);
  });

  it("handles a zero-length roster", () => {
    expect(generateBotNames(deriveRng(1, 1), 0)).toEqual([]);
  });
});

describe("pickBotShip", () => {
  it("only ever returns a hull this pack actually has", () => {
    const rng = deriveRng(5, 1);
    const known = new Set(configs.getAll<ShipConfig>("ship").map((s) => s.id));
    for (let i = 0; i < 50; i++) {
      expect(known.has(pickBotShip(configs, rng, "ship.interceptor"))).toBe(true);
    }
  });

  it("honours an authored pool", () => {
    const rng = deriveRng(9, 1);
    for (let i = 0; i < 30; i++) {
      expect(pickBotShip(configs, rng, "ship.interceptor", ["ship.brawler"])).toBe("ship.brawler");
    }
  });

  it("falls back when the pool names nothing real", () => {
    expect(pickBotShip(configs, deriveRng(1, 1), "ship.support", ["ship.ghost"])).toBe("ship.support");
  });

  it("draws more than one hull across a roster — that is the point", () => {
    const rng = deriveRng(21, 1);
    const seen = new Set(Array.from({ length: 40 }, () => pickBotShip(configs, rng, "ship.interceptor")));
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe("randomBotFitting", () => {
  const fittingFor = (shipId: string, seed: number) => randomBotFitting(configs, shipId, deriveRng(seed, 1));

  it("returns one entry per slot, in slot order", () => {
    for (const shipId of ["ship.interceptor", "ship.support", "ship.brawler"]) {
      const ship = configs.get<ShipConfig>("ship", shipId)!;
      expect(fittingFor(shipId, 1)).toHaveLength(hardpointsOf(ship).length);
    }
  });

  it("never puts anything the socket refuses — the fitting is always spawnable", () => {
    for (const shipId of ["ship.interceptor", "ship.support", "ship.brawler"]) {
      const ship = configs.get<ShipConfig>("ship", shipId)!;
      const sockets = hardpointsOf(ship);
      for (let seed = 1; seed <= 25; seed++) {
        fittingFor(shipId, seed).forEach((moduleId, index) => {
          if (moduleId === null) return;
          const family = configs.get<ModuleConfig>("module", moduleId)!.family;
          expect(sockets[index]!.accepts, `${shipId}[${index}] ${moduleId}`).toContain(family);
        });
      }
    }
  });

  it("leaves the INTERNAL bay on the hull's stock systems — variety, not strength", () => {
    const ship = configs.get<ShipConfig>("ship", "ship.brawler")!;
    const sockets = hardpointsOf(ship);
    for (let seed = 1; seed <= 20; seed++) {
      fittingFor("ship.brawler", seed).forEach((moduleId, index) => {
        if (sockets[index]!.kind !== "internal") return;
        expect(moduleId).toBe(ship.defaultFitting[index]);
      });
    }
  });

  it("never fits above the entry tier", () => {
    for (let seed = 1; seed <= 25; seed++) {
      for (const moduleId of fittingFor("ship.brawler", seed)) {
        if (!moduleId) continue;
        const cfg = configs.get<ModuleConfig>("module", moduleId)!;
        if (isInternalFamily(cfg.family)) continue; // stock internals may be any tier
        expect(cfg.level).toBeLessThanOrEqual(MAX_BOT_MODULE_LEVEL);
      }
    }
  });

  it("actually varies the weapons across seeds", () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 20; seed++) seen.add(fittingFor("ship.brawler", seed).slice(0, 4).join(","));
    expect(seen.size).toBeGreaterThan(1);
  });

  it("is deterministic for a given stream, and empty for an unknown hull", () => {
    expect(fittingFor("ship.interceptor", 4)).toEqual(fittingFor("ship.interceptor", 4));
    expect(randomBotFitting(configs, "ship.nope", deriveRng(1, 1))).toEqual([]);
  });
});

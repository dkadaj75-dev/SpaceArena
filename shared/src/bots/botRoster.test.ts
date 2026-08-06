import { beforeAll, describe, expect, it } from "vitest";
import type { ConfigService } from "../core/ConfigService.js";
import { hardpointsOf, type ModuleConfig, type ShipConfig } from "../schemas/index.js";
import { deriveRng } from "../sim/rng.js";
import { loadTestConfigs } from "../sim/testutil.js";
import { generateBotName, generateBotNames } from "./botNames.js";
import type { BotprofileConfig } from "../schemas/botprofile.js";
import { fittingPowerScore, isBotFittingViable, pickBotShip, randomBotFitting } from "./botLoadout.js";

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
      expect(name.length).toBeLessThanOrEqual(16);
      expect(name).not.toMatch(/\s/);
    }
  });

  it("varies — a roster is not twenty copies of one name", () => {
    const rng = deriveRng(11, 1);
    const names = new Set(Array.from({ length: 40 }, () => generateBotName(rng)));
    expect(names.size).toBe(40);
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

  it("rolls viable fittings for every hull/profile across many seeds", () => {
    const profiles = configs.getAll<BotprofileConfig>("botprofile");
    for (const ship of configs.getAll<ShipConfig>("ship")) {
      for (const p of profiles) {
        for (let seed = 1; seed <= 40; seed++) {
          const fit = randomBotFitting(configs, ship.id, deriveRng(seed, 1), p);
          expect(isBotFittingViable(configs, ship, fit), `${ship.id}/${p.id}/${seed}`).toBe(true);
        }
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

  it("tracks low- and high-power player fittings while staying deterministic and viable", () => {
    const ship = configs.get<ShipConfig>("ship", "ship.interceptor")!;
    const modules = configs.getAll<ModuleConfig>("module");
    const fittingAt = (high: boolean) => hardpointsOf(ship).map((socket) => {
      const candidates = modules.filter((m) => socket.accepts.includes(m.family));
      return candidates.sort((a, b) => fittingPowerScore(configs, [a.id]) - fittingPowerScore(configs, [b.id]))[high ? candidates.length - 1 : 0]?.id ?? null;
    });
    const low = fittingAt(false);
    const high = fittingAt(true);
    const roll = (seed: number, reference: readonly (string | null)[]) =>
      randomBotFitting(configs, ship.id, deriveRng(seed, 9), undefined, reference);
    const lowRolls = Array.from({ length: 12 }, (_, i) => roll(i + 1, low));
    const highRolls = Array.from({ length: 12 }, (_, i) => roll(i + 1, high));
    expect(lowRolls.every((fit) => isBotFittingViable(configs, ship, fit))).toBe(true);
    expect(highRolls.every((fit) => isBotFittingViable(configs, ship, fit))).toBe(true);
    const average = (fits: readonly (readonly (string | null)[])[]) => fits.reduce((n, fit) => n + fittingPowerScore(configs, fit), 0) / fits.length;
    expect(average(highRolls)).toBeGreaterThan(average(lowRolls));
    expect(roll(7, high)).toEqual(roll(7, high));
  });
});

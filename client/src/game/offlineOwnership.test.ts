import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConfigService, type ShipConfig } from "@space-arena/shared";
import {
  buyCosmeticLocal,
  buyModuleLocal,
  buyShipLocal,
  clearOwnership,
  ownedCosmetics,
  ownedModules,
  ownedShips,
  ownsCosmetic,
  ownsModule,
  ownsShip,
  selectCosmeticLocal,
  selectedCosmetic,
  starterModules,
  STARTER_SHIP_ID,
} from "./offlineOwnership.js";

// Same content loader as `hangarStats.test.ts` — see the note there on why
// client tests locate `content/` by walking up from `process.cwd()`.
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
  const result = await configs.load("manifest.json");
  if (!result.ok) throw new Error("test content failed to load: " + JSON.stringify(result.errors));
});

beforeEach(() => {
  clearOwnership();
});

describe("offline ownership (owner 2026-07-31)", () => {
  it("starts with the light human hull and nothing else", () => {
    expect(ownsShip(STARTER_SHIP_ID)).toBe(true);
    expect(ownsShip("ship.brawler")).toBe(false);
    expect(ownsShip("ship.support")).toBe(false);
  });

  it("starts with exactly the starter hull's stock fitting, so it can fly", () => {
    const starter = configs.get<ShipConfig>("ship", STARTER_SHIP_ID)!;
    for (const id of starter.defaultFitting) {
      if (id) expect(ownsModule(configs, id), id).toBe(true);
    }
    expect(ownsModule(configs, "module.laser-mk2")).toBe(false);
  });

  it("derives the starter modules from content rather than a hardcoded list", () => {
    const starter = configs.get<ShipConfig>("ship", STARTER_SHIP_ID)!;
    expect([...starterModules(configs)].sort()).toEqual(
      [...new Set(starter.defaultFitting.filter((m): m is string => !!m))].sort(),
    );
  });

  it("records a hull purchase, and buying twice is not an error", () => {
    buyShipLocal("ship.brawler");
    buyShipLocal("ship.brawler");
    expect(ownsShip("ship.brawler")).toBe(true);
    expect([...ownedShips()].sort()).toEqual([STARTER_SHIP_ID, "ship.brawler"].sort());
  });

  it("records a module purchase without disturbing the starter set", () => {
    buyModuleLocal("module.laser-mk2");
    expect(ownsModule(configs, "module.laser-mk2")).toBe(true);
    expect(ownsModule(configs, "module.laser-mk1")).toBe(true);
  });

  it("survives a reload — the ledger is the storage, not the session", () => {
    buyShipLocal("ship.support");
    buyModuleLocal("module.shield-mk2");
    // A fresh read is all a reload amounts to here.
    expect(ownedShips().has("ship.support")).toBe(true);
    expect(ownedModules(configs).has("module.shield-mk2")).toBe(true);
  });

  it("falls back to the starter set on corrupt storage rather than crashing", () => {
    localStorage.setItem("hangar.owned", "{not json");
    expect(ownsShip(STARTER_SHIP_ID)).toBe(true);
    expect(ownsShip("ship.brawler")).toBe(false);
  });

  it("ignores non-string junk inside otherwise-valid storage", () => {
    localStorage.setItem("hangar.owned", JSON.stringify({ ships: [1, null, "ship.brawler"], modules: "nope" }));
    expect(ownsShip("ship.brawler")).toBe(true);
    expect(ownedModules(configs)).toEqual(starterModules(configs));
  });

  it("derives the starter hull's base paint as owned and selected", () => {
    expect(ownsCosmetic(configs, "cosmetic.paint-interceptor-standard")).toBe(true);
    expect(ownsCosmetic(configs, "cosmetic.paint-interceptor-red")).toBe(false);
    expect([...ownedCosmetics(configs)]).toEqual(["cosmetic.paint-interceptor-standard"]);
    expect(selectedCosmetic(configs, STARTER_SHIP_ID)).toBe("cosmetic.paint-interceptor-standard");
  });

  it("records a paint purchase and equips it per hull, surviving a reload", () => {
    buyCosmeticLocal("cosmetic.paint-interceptor-red");
    buyCosmeticLocal("cosmetic.paint-interceptor-red");
    selectCosmeticLocal(configs, STARTER_SHIP_ID, "cosmetic.paint-interceptor-red");
    expect(ownsCosmetic(configs, "cosmetic.paint-interceptor-red")).toBe(true);
    expect(selectedCosmetic(configs, STARTER_SHIP_ID)).toBe("cosmetic.paint-interceptor-red");
    // A fresh read is all a reload amounts to here.
    expect(selectedCosmetic(configs, "ship.brawler")).toBe("cosmetic.paint-brawler-standard");
  });

  it("refuses to equip a paint that was never bought", () => {
    selectCosmeticLocal(configs, STARTER_SHIP_ID, "cosmetic.paint-interceptor-blue");
    expect(selectedCosmetic(configs, STARTER_SHIP_ID)).toBe("cosmetic.paint-interceptor-standard");
  });

  it("sanitizes retired ids and null to the hull base paint", () => {
    localStorage.setItem("hangar.owned", JSON.stringify({ v: 2, cosmetics: ["cosmetic.paint-standard"], selections: { "ship.interceptor": "cosmetic.paint-standard" } }));
    expect(selectedCosmetic(configs, STARTER_SHIP_ID)).toBe("cosmetic.paint-interceptor-standard");
    selectCosmeticLocal(configs, STARTER_SHIP_ID, null);
    expect(selectedCosmetic(configs, STARTER_SHIP_ID)).toBe("cosmetic.paint-interceptor-standard");
  });

  it("migrates a v1 stored shape without stranding an existing tester's purchases", () => {
    // What a tester's storage looked like before cosmetics existed.
    localStorage.setItem("hangar.owned", JSON.stringify({ ships: ["ship.brawler"], modules: ["module.laser-mk2"] }));
    expect(ownsShip("ship.brawler")).toBe(true);
    expect(ownedModules(configs).has("module.laser-mk2")).toBe(true);
    expect([...ownedCosmetics(configs)].sort()).toEqual(["cosmetic.paint-brawler-standard", "cosmetic.paint-interceptor-standard"].sort());

    // The next write upgrades the record in place; nothing older is lost.
    buyCosmeticLocal("cosmetic.paint-brawler-yellow");
    const stored = JSON.parse(localStorage.getItem("hangar.owned")!) as Record<string, unknown>;
    expect(stored.v).toBe(2);
    expect(stored.ships).toEqual(["ship.brawler"]);
    expect(stored.modules).toEqual(["module.laser-mk2"]);
    expect(ownsCosmetic(configs, "cosmetic.paint-brawler-yellow")).toBe(true);
  });

  it("ignores junk selections rather than crashing", () => {
    localStorage.setItem(
      "hangar.owned",
      JSON.stringify({ v: 2, cosmetics: ["cosmetic.paint-interceptor-blue", 7], selections: { "ship.interceptor": 42 } }),
    );
    expect([...ownedCosmetics(configs)].sort()).toEqual(["cosmetic.paint-interceptor-standard", "cosmetic.paint-interceptor-blue"].sort());
    expect(selectedCosmetic(configs, "ship.interceptor")).toBe("cosmetic.paint-interceptor-standard");
  });

  it("clears back to the starter set", () => {
    buyShipLocal("ship.brawler");
    clearOwnership();
    expect(ownsShip("ship.brawler")).toBe(false);
    expect(ownsShip(STARTER_SHIP_ID)).toBe(true);
  });
});

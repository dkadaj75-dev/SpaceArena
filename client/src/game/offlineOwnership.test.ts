import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConfigService, type ShipConfig } from "@space-arena/shared";
import {
  buyModuleLocal,
  buyShipLocal,
  clearOwnership,
  ownedModules,
  ownedShips,
  ownsModule,
  ownsShip,
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

  it("clears back to the starter set", () => {
    buyShipLocal("ship.brawler");
    clearOwnership();
    expect(ownsShip("ship.brawler")).toBe(false);
    expect(ownsShip(STARTER_SHIP_ID)).toBe(true);
  });
});

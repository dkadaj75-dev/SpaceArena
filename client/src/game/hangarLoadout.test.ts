// @vitest-environment happy-dom
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConfigService, hardpointsOf, type ShipConfig } from "@space-arena/shared";
import { GameSession } from "./GameSession.js";
import { STARTER_SHIP_ID } from "./offlineOwnership.js";
import { loadHangarSelection } from "./screens/Hangar.js";

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
async function fsLoader(relPath: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(CONTENT_DIR, relPath), "utf8"));
}

let configs: ConfigService;
let interceptor: ShipConfig;
let brawler: ShipConfig;

beforeAll(async () => {
  configs = new ConfigService(fsLoader);
  const result = await configs.load("manifest.json");
  if (!result.ok) throw new Error("test content failed to load: " + JSON.stringify(result.errors));
  interceptor = configs.get<ShipConfig>("ship", "ship.interceptor")!;
  brawler = configs.get<ShipConfig>("ship", "ship.brawler")!;
});

/** The player's fitted module ids, in hardpoint order, from a live session. */
function playerFittingOf(session: GameSession): (string | null)[] {
  const ship = session.curSnapshot.ships.find((s) => s.id === session.playerId)!;
  const byIndex = new Map(ship.modules.map((m) => [m.hardpointIndex, m.moduleId]));
  const count = hardpointsOf(interceptor).length;
  return Array.from({ length: Math.max(count, byIndex.size) }, (_, i) => byIndex.get(i) ?? null);
}

function practice(options: ConstructorParameters<typeof GameSession>[4]): GameSession {
  return new GameSession(configs, "arena.ring-nebula", "gamemode.practice-bots-1v1", 1, options);
}

describe("the Hangar loadout reaches an offline match (owner 2026-07-31)", () => {
  it("flies the hull and the working fitting the player left the Hangar with", () => {
    const session = practice({
      playerShipId: "ship.brawler",
      // The original nine heavy slots retain their indices; expansion slots
      // append after them. Hardpoint 2 is deliberately left empty.
      playerFitting: [
        "module.laser-mk1",
        "module.kinetic-mk1",
        null,
        "module.shield-mk1",
        "module.engine-sport",
        "module.generator-heavy",
        "module.transformer-cryo",
        "module.countermeasure-chaff",
        "module.sensors-longrange",
      ],
    });
    const ship = session.curSnapshot.ships.find((s) => s.id === session.playerId)!;
    const fitted = ship.modules.map((m) => `${m.hardpointIndex}:${m.moduleId}`);
    // Slot 8 remains the heavy sensor bay, so this is also the
    // proof that the requested HULL was the one spawned.
    expect(hardpointsOf(brawler)).toHaveLength(12);
    expect(fitted).toEqual([
      "0:module.laser-mk1",
      "1:module.kinetic-mk1",
      "3:module.shield-mk1",
      "4:module.engine-sport",
      "5:module.generator-heavy",
      "6:module.transformer-cryo",
      "7:module.countermeasure-chaff",
      "8:module.sensors-longrange",
    ]);
  });

  it("falls back to the ship's default fitting when the Hangar has no opinion", () => {
    const session = practice({});
    expect(playerFittingOf(session)).toEqual([...interceptor.defaultFitting, null]);
  });

  it("empties a slot whose module the hardpoint refuses rather than failing the match", () => {
    // A shield on the nose hardpoint (laser/kinetic only) is not spawnable —
    // spawnShipFromConfig throws on it — so it must be dropped, not passed on.
    // Likewise a weapon dropped into the engine bay.
    const session = practice({
      playerShipId: "ship.interceptor",
      playerFitting: [
        "module.shield-mk1", // nose refuses a shield
        "module.missile-mk1",
        "module.laser-mk1", // engine bay refuses a weapon
        "module.generator-compact",
        "module.transformer-stock",
        "module.countermeasure-flare",
        "module.sensors-basic",
      ],
    });
    expect(playerFittingOf(session)).toEqual([
      null,
      "module.missile-mk1",
      null,
      "module.generator-compact",
      "module.transformer-stock",
      "module.countermeasure-flare",
      "module.sensors-basic",
      null,
    ]);
  });

  it("ignores an unknown hull and unknown module ids (stale storage never blocks a launch)", () => {
    const session = practice({
      playerShipId: "ship.does-not-exist",
      playerFitting: ["module.ghost", null, null, null],
    });
    // Unknown hull ⇒ stock interceptor; an all-empty fit ⇒ its default fitting.
    expect(playerFittingOf(session)).toEqual([...interceptor.defaultFitting, null]);
  });

  it("treats an all-empty fitting as 'no opinion' — a module-less ship is not playable", () => {
    const session = practice({ playerShipId: "ship.interceptor", playerFitting: [null, null, null, null] });
    expect(playerFittingOf(session)).toEqual([...interceptor.defaultFitting, null]);
  });
});

describe("loadHangarSelection working fitting", () => {
  beforeEach(() => localStorage.clear());

  it("returns the stored module list for the stored ship", () => {
    localStorage.setItem("hangar.shipId", "ship.brawler");
    localStorage.setItem(
      "hangar.moduleIds",
      JSON.stringify({ shipId: "ship.brawler", moduleIds: ["module.laser-mk1", null] }),
    );
    expect(loadHangarSelection().moduleIds).toEqual(["module.laser-mk1", null]);
  });

  it("refuses a fitting stored for a DIFFERENT hull — its sockets would not match", () => {
    localStorage.setItem("hangar.shipId", "ship.interceptor");
    localStorage.setItem(
      "hangar.moduleIds",
      JSON.stringify({ shipId: "ship.brawler", moduleIds: ["module.laser-mk1"] }),
    );
    expect(loadHangarSelection().moduleIds).toBeNull();
  });

  it("survives corrupt storage", () => {
    localStorage.setItem("hangar.shipId", "ship.interceptor");
    localStorage.setItem("hangar.moduleIds", "{not json");
    expect(loadHangarSelection().moduleIds).toBeNull();
    localStorage.setItem("hangar.moduleIds", JSON.stringify({ shipId: "ship.interceptor", moduleIds: "nope" }));
    expect(loadHangarSelection().moduleIds).toBeNull();
  });

  it("normalises junk entries to empty slots", () => {
    localStorage.setItem("hangar.shipId", "ship.interceptor");
    localStorage.setItem(
      "hangar.moduleIds",
      JSON.stringify({ shipId: "ship.interceptor", moduleIds: ["module.laser-mk1", 7, "", null] }),
    );
    expect(loadHangarSelection().moduleIds).toEqual(["module.laser-mk1", null, null, null]);
  });

  it("reports no fitting at all when no ship was ever chosen", () => {
    expect(loadHangarSelection().moduleIds).toBeNull();
  });

  it("falls back to the STARTER hull when no main was ever set (2026-07-31)", () => {
    expect(loadHangarSelection().shipId).toBe(STARTER_SHIP_ID);
  });

  it("reads the MAIN hull, not wherever the carousel was left", () => {
    localStorage.setItem("hangar.shipId", "ship.brawler");
    localStorage.setItem("hangar.browseShipId", "ship.support");
    expect(loadHangarSelection().shipId).toBe("ship.brawler");
  });
});

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

/** The same, in the HEAVY's slot order (it has more slots than the light). */
function brawlerFittingOf(session: GameSession): (string | null)[] {
  const ship = session.curSnapshot.ships.find((s) => s.id === session.playerId)!;
  const byIndex = new Map(ship.modules.map((m) => [m.hardpointIndex, m.moduleId]));
  return hardpointsOf(brawler).map((_, i) => byIndex.get(i) ?? null);
}

function practice(options: ConstructorParameters<typeof GameSession>[4]): GameSession {
  return new GameSession(configs, "arena.ring-nebula", "gamemode.practice-bots-1v1", 1, options);
}

describe("the Hangar loadout reaches an offline match (owner 2026-07-31)", () => {
  it("flies the hull and the working fitting the player left the Hangar with", () => {
    const session = practice({
      playerShipId: "ship.brawler",
      // The heavy's slots since the 2026-08-22 hardpoint pass: three hardpoints
      // first, then the systems bay. Hardpoint 2 (the spine) is deliberately
      // left empty.
      playerFitting: [
        "module.laser-mk1",
        "module.kinetic-mk1",
        null,
        "module.engine-earth-eng2",
        "module.generator-earth-eng2",
        "module.alloy-martian-p2",
        "module.countermeasure-chaff",
        "module.sensors-sharpshooter-mk2",
        "module.utility-armor-plating",
      ],
    });
    const ship = session.curSnapshot.ships.find((s) => s.id === session.playerId)!;
    const fitted = ship.modules.map((m) => `${m.hardpointIndex}:${m.moduleId}`);
    // Slot 8 is the heavy's AUXILIARY bay — the one that takes a passive
    // utility now that no hardpoint does — so this is also the proof that the
    // requested HULL was the one spawned.
    expect(hardpointsOf(brawler)).toHaveLength(9);
    expect(fitted).toEqual([
      "0:module.laser-mk1",
      "1:module.kinetic-mk1",
      "3:module.engine-earth-eng2",
      "4:module.generator-earth-eng2",
      "5:module.alloy-martian-p2",
      "6:module.countermeasure-chaff",
      "7:module.sensors-sharpshooter-mk2",
      "8:module.utility-armor-plating",
    ]);
  });

  it("falls back to the ship's default fitting when the Hangar has no opinion", () => {
    const session = practice({});
    expect(playerFittingOf(session)).toEqual([...interceptor.defaultFitting]);
  });

  it("empties a slot whose module the hardpoint refuses rather than failing the match", () => {
    // A passive utility on a hardpoint is not spawnable since the 2026-08-22
    // pass (a hardpoint takes a weapon, a shield or a support module and
    // nothing else) — spawnShipFromConfig throws on it — so it must be
    // dropped, not passed on. Likewise a weapon dropped into the engine bay.
    const session = practice({
      playerShipId: "ship.interceptor",
      playerFitting: [
        "module.utility-armor-plating", // a hardpoint refuses dead weight
        "module.missile-mk1",
        "module.laser-mk1", // engine bay refuses a weapon
        "module.generator-earth-eng1",
        "module.alloy-earth-p1",
        "module.countermeasure-flare",
        "module.sensors-common-mk1",
      ],
    });
    expect(playerFittingOf(session)).toEqual([
      null,
      "module.missile-mk1",
      null,
      "module.generator-earth-eng1",
      "module.alloy-earth-p1",
      "module.countermeasure-flare",
      "module.sensors-common-mk1",
    ]);
  });

  it("degrades a fitting saved against an OLDER socket layout instead of throwing", () => {
    // A pre-2026-08-22 BRAWLER fitting, verbatim: six hardpoints and six
    // internals in the old order, twelve slots for a hull that now has nine.
    // The three cut hardpoints shift every internal three places early, so from
    // slot 3 on nothing lands in a bay that accepts it — a shield in the engine
    // bay, an engine in the generator bay. spawnShipFromConfig throws on either,
    // so the whole point is that none of this reaches it.
    const session = practice({
      playerShipId: "ship.brawler",
      playerFitting: [
        "module.kinetic-mk1",
        "module.laser-mk1",
        "module.missile-mk1",
        "module.shield-mk1", // was hp-core, now the engine bay
        "module.engine-earth-eng1",
        "module.generator-earth-eng1",
        "module.alloy-earth-p1",
        "module.countermeasure-flare",
        "module.sensors-common-mk1",
        "module.generator-earth-eng1",
        "module.laser-mk2", // was hp-chin — a slot the hull no longer has
        "module.utility-armor-plating", // was hp-utility — likewise
      ],
    });
    // The three surviving hardpoints keep the guns that were already on them;
    // everything the shift misaligned becomes an empty slot the pilot can
    // re-fill in the Hangar, and the two slots past the end are simply gone.
    const fitted = brawlerFittingOf(session);
    expect(fitted).toHaveLength(9);
    expect(fitted).toEqual([
      "module.kinetic-mk1",
      "module.laser-mk1",
      "module.missile-mk1",
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it("keeps a stale INTERCEPTOR fitting almost whole — the cut happened to be index-neutral", () => {
    // Worth pinning rather than leaving to luck: the light hull lost its NOSE
    // mount and moved its starboard wing up from the end of the socket list, so
    // the two moves cancel and every systems-bay slot kept its index. A pilot
    // with a saved light loadout loses exactly the module that was on the third
    // hardpoint, and nothing else.
    const session = practice({
      playerShipId: "ship.interceptor",
      playerFitting: [
        "module.laser-mk1",
        "module.missile-mk1",
        "module.engine-earth-eng1",
        "module.generator-earth-eng1",
        "module.alloy-earth-p1",
        "module.countermeasure-flare",
        "module.sensors-common-mk1",
        "module.utility-armor-plating", // the retired third hardpoint
      ],
    });
    expect(playerFittingOf(session)).toEqual([
      "module.laser-mk1",
      "module.missile-mk1",
      "module.engine-earth-eng1",
      "module.generator-earth-eng1",
      "module.alloy-earth-p1",
      "module.countermeasure-flare",
      "module.sensors-common-mk1",
    ]);
  });

  it("ignores an unknown hull and unknown module ids (stale storage never blocks a launch)", () => {
    const session = practice({
      playerShipId: "ship.does-not-exist",
      playerFitting: ["module.ghost", null, null, null],
    });
    // Unknown hull ⇒ stock interceptor; an all-empty fit ⇒ its default fitting.
    expect(playerFittingOf(session)).toEqual([...interceptor.defaultFitting]);
  });

  it("treats an all-empty fitting as 'no opinion' — a module-less ship is not playable", () => {
    const session = practice({ playerShipId: "ship.interceptor", playerFitting: [null, null, null, null] });
    expect(playerFittingOf(session)).toEqual([...interceptor.defaultFitting]);
  });
});

describe("loadHangarSelection working fitting", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

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
    // Session-scoped since 2026-08-23, and never read here either way.
    sessionStorage.setItem("hangar.browseShipId", "ship.support");
    expect(loadHangarSelection().shipId).toBe("ship.brawler");
  });
});

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { ConfigService, setGlobalLogLevel, type CosmeticConfig } from "@space-arena/shared";
import { GameSession } from "./GameSession.js";

setGlobalLogLevel("error");

/**
 * The offline half of cosmetic replication: what the Shop equipped has to reach
 * the sim, and the bots have to be dressed the same way on every replay of a
 * seed. The online half lives in `server/src/rooms/ArenaRoom.test.ts`.
 */
function contentDir(): string {
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    if (existsSync(path.join(dir, "content", "manifest.json"))) return path.join(dir, "content");
    dir = path.dirname(dir);
  }
  throw new Error(`content/manifest.json not found above ${process.cwd()}`);
}

let configs: ConfigService;
beforeAll(async () => {
  const dir = contentDir();
  configs = new ConfigService((rel) => Promise.resolve(JSON.parse(readFileSync(path.join(dir, rel), "utf8"))));
  const result = await configs.load("manifest.json");
  expect(result.ok, JSON.stringify(result.errors)).toBe(true);
});

function session(playerCosmeticId?: string | null): GameSession {
  return new GameSession(configs, "arena.ring-nebula", "gamemode.practice-bots-1v1", 5, {
    playerShipId: "ship.interceptor",
    playerCosmeticId,
  });
}

function paintOf(s: GameSession, id: number): string | undefined {
  return s.curSnapshot.ships.find((ship) => ship.id === id)?.cosmeticId;
}

describe("offline cosmetics", () => {
  it("flies the equipped paint", () => {
    const s = session("cosmetic.paint-interceptor-red");
    expect(paintOf(s, s.playerId)).toBe("cosmetic.paint-interceptor-red");
  });

  it("flies the authored look with no selection", () => {
    const s = session();
    expect(paintOf(s, s.playerId)).toBe("cosmetic.paint-interceptor-standard");
  });

  it("drops a paint the hull may not wear rather than spawning it", () => {
    const s = session("cosmetic.paint-brawler-red");
    expect(paintOf(s, s.playerId)).toBe("cosmetic.paint-interceptor-standard");
  });

  it("dresses bots in target-ship paints, identically for the same seed", () => {
    const first = session();
    const second = session();
    const botIds = [...first.bots.keys()];
    expect(botIds.length).toBeGreaterThan(0);
    for (const id of botIds) {
      const paint = paintOf(first, id);
      expect(paint).toBeDefined();
      const cosmetic = configs.get<CosmeticConfig>("cosmetic", paint!)!;
      expect(cosmetic.target).toMatch(/^ship\./);
      expect(cosmetic.price).toBe(0);
      expect(paintOf(second, id)).toBe(paint);
    }
  });
});

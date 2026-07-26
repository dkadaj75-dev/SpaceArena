import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { ConfigService, setGlobalLogLevel, type SimEvent } from "@space-arena/shared";
import { GameSession } from "./GameSession.js";

setGlobalLogLevel("error");

/**
 * Review Finding 2 — offline half.
 *
 * `BotDriver` used to default its RNG to `Math.random`, and neither
 * `GameSession` nor `ArenaRoom` passed one, so two practice matches on the same
 * seed diverged from the first decision: different orbit signs, different
 * decision jitter, different boost rolls, different order streams, different
 * outcome. Each driver now draws from `deriveRng(seed, entityId)`, so the seed
 * that already governed the sim governs the bots too.
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

const DT = 1 / 30;
const TICKS = 20 / DT; // 20 sim seconds — long enough for the merge and the shooting

interface Run {
  events: string;
  positions: string;
  eventCount: number;
  botCount: number;
}

/** Run a bots-vs-player practice match and fingerprint everything it produced. */
function run(seed: number): Run {
  // `gamemode.practice-bots` declares a two-bot roster, so this exercises the
  // real roster → BotDriver construction path, not a hand-built driver.
  const session = new GameSession(configs, "arena.ring-nebula", "gamemode.practice-bots", seed);
  const events: SimEvent[] = [];
  for (let i = 0; i < TICKS && !session.isEnded; i++) {
    session.tick(DT);
    events.push(...session.drainFrameEvents());
    session.clearFrameEvents();
  }
  return {
    events: JSON.stringify(events),
    positions: JSON.stringify(session.curSnapshot.ships.map((s) => [s.id, s.pos.x, s.pos.z, s.heading])),
    eventCount: events.length,
    botCount: session.bots.size,
  };
}

describe("GameSession bot determinism (Finding 2)", () => {
  it("produces a byte-identical event stream for two runs on the same seed", () => {
    const a = run(4242);
    const b = run(4242);
    expect(a.botCount).toBeGreaterThan(0); // the roster really spawned drivers
    expect(a.eventCount).toBeGreaterThan(0); // ...and they really did something
    expect(a.events).toBe(b.events);
    expect(a.positions).toBe(b.positions);
  });

  it("actually varies with the seed — the bots are seeded, not merely frozen", () => {
    // The other half: a deterministic-but-seed-independent default would pass
    // the test above and still make every practice match identical.
    expect(run(4242).events).not.toBe(run(99).events);
  });
});

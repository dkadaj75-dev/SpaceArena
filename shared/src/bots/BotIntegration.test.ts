import { beforeAll, describe, expect, it } from "vitest";

import type { ConfigService } from "../core/ConfigService.js";
import { orderSchema } from "../net/protocol.js";
import type { BotprofileConfig } from "../schemas/botprofile.js";
import type { GamemodeConfig } from "../schemas/gamemode.js";
import type { ShipConfig } from "../schemas/ship.js";
import { ArenaSimulation } from "../sim/ArenaSimulation.js";
import type { EntityId } from "../sim/components.js";
import type { SimEvent } from "../sim/events.js";
import { loadTestConfigs } from "../sim/testutil.js";
import { BotDriver } from "./BotDriver.js";
import { resolveBotRoster } from "./roster.js";

const DT = 1 / 30;
const SECONDS = 30;

let configs: ConfigService;

beforeAll(async () => {
  configs = await loadTestConfigs();
});

/** Deterministic RNG so the whole integration run is reproducible. */
function mulberry(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface RunResult {
  events: SimEvent[];
  orders: number;
  start: Map<EntityId, { x: number; z: number }>;
  end: Map<EntityId, { x: number; z: number }>;
  botIds: EntityId[];
  /** Every module state a bot ship was ever seen in. */
  seenStates: Set<string>;
  /** Highest normalized lock progress any bot reached (FLIGHT.md §2). */
  peakLockProgress: number;
  /** True if any bot ever completed a lock. */
  anyLocked: boolean;
}

/**
 * Run a bot-vs-bot match through the real {@link ArenaSimulation}, feeding every
 * driver order through `applyOrder` — the same entry point the room and the
 * practice session use for human orders.
 */
function runMatch(profileIds: string[], seed: number): RunResult {
  const sim = new ArenaSimulation(configs, "arena.ring-nebula", "gamemode.practice-bots", seed);
  const drivers = new Map<EntityId, BotDriver>();
  const botIds: EntityId[] = [];

  profileIds.forEach((profileId, i) => {
    const profile = configs.get<BotprofileConfig>("botprofile", profileId)!;
    const shipId = "ship.interceptor";
    const ship = configs.get<ShipConfig>("ship", shipId)!;
    const id = sim.spawnPlayer(shipId, ship.defaultFitting, i);
    drivers.set(id, new BotDriver({ entityId: id, profile, configs, rng: mulberry(seed + i) }));
    botIds.push(id);
  });

  const start = new Map<EntityId, { x: number; z: number }>();
  for (const s of sim.snapshot().ships) start.set(s.id, { ...s.pos });

  const events: SimEvent[] = [];
  const seenStates = new Set<string>();
  let orders = 0;
  let nowMs = 0;
  let peakLockProgress = 0;
  let anyLocked = false;

  for (let i = 0; i < SECONDS / DT; i++) {
    if (sim.isEnded) break;
    nowMs += DT * 1000;
    const snapshot = sim.snapshot();
    for (const s of snapshot.ships) {
      if (!drivers.has(s.id)) continue;
      for (const m of s.modules) seenStates.add(m.state);
      peakLockProgress = Math.max(peakLockProgress, s.lockProgress);
      if (s.locked) anyLocked = true;
    }
    for (const [entityId, driver] of drivers) {
      if (!sim.hasShip(entityId)) {
        drivers.delete(entityId);
        continue;
      }
      for (const order of driver.update(snapshot, nowMs)) {
        // Orders must be valid on the wire, exactly like a client's.
        expect(orderSchema.safeParse(order).success).toBe(true);
        if (order.kind === "moduleToggle") {
          const mods = sim.world.modules.get(entityId)!;
          expect(mods.modules.some((m) => m.hardpointIndex === order.hardpointIndex)).toBe(true);
        }
        if (order.kind === "target" && order.targetId !== null) {
          expect(sim.teamOf(order.targetId)).not.toBe(sim.teamOf(entityId));
        }
        orders++;
        sim.applyOrder(entityId, order);
      }
    }
    sim.tick(DT);
    events.push(...sim.getEvents());
  }

  const end = new Map<EntityId, { x: number; z: number }>();
  for (const s of sim.snapshot().ships) end.set(s.id, { ...s.pos });

  return { events, orders, start, end, botIds, seenStates, peakLockProgress, anyLocked };
}

describe("bots in a live ArenaSimulation", () => {
  it("move, work their sensors and only issue legal orders over a 30 s match", () => {
    const result = runMatch(["bot.aggressive", "bot.cautious"], 7);

    expect(result.orders).toBeGreaterThan(0);

    // Every bot that survived long enough actually travelled.
    let moved = 0;
    for (const id of result.botIds) {
      const a = result.start.get(id);
      const b = result.end.get(id);
      if (!a || !b) {
        moved++; // destroyed ⇒ it definitely participated
        continue;
      }
      if (Math.hypot(b.x - a.x, b.z - a.z) > 5) moved++;
    }
    expect(moved).toBe(result.botIds.length);

    // They deployed modules and drove their sensors toward a lock.
    expect(result.seenStates.has("active")).toBe(true);
    // FLIGHT.md §2: weapons need a completed lock, and the gate is in the sim, so
    // it binds bots exactly as it binds a human. These bots still fly the RTS-era
    // orbit plan (move orders around a ring), which points the hull ACROSS the
    // enemy instead of at it — they accrue lock progress on every closing leg but
    // the orbit drains it before it fills, so a 30 s bot-vs-bot match currently
    // produces no shots. That is the honest state of the pipeline until stage 4
    // re-plans every behaviour in flight terms (hold the target in the cone);
    // `moduleDiscipline` and the order path are what this test still guards.
    // The gate itself, and that firing resumes once a lock completes, are covered
    // in Combat.test.ts / Targeting.test.ts.
    expect(result.peakLockProgress).toBeGreaterThan(0);
    // Invariant that survives the bot rewrite: shots only ever exist alongside a
    // completed lock — no bot gets a per-driver exemption from the gate.
    const fired = result.events.filter((e) => e.type === "projectileFired");
    expect(fired.length === 0 || result.anyLocked).toBe(true);
  });

  it("never lets a disciplined profile force-overheat a module", () => {
    // bot.cautious shuts down at 0.7 of threshold — it must never reach the
    // sim's forced `overheated` state, which is the whole point of 5.1's
    // moduleDiscipline (same skill axis as a human managing heat).
    const result = runMatch(["bot.cautious", "bot.cautious"], 11);
    expect(result.seenStates.has("overheated")).toBe(false);
  });

  it("is fully deterministic given the same seeds", () => {
    const a = runMatch(["bot.aggressive", "bot.cautious"], 3);
    const b = runMatch(["bot.aggressive", "bot.cautious"], 3);
    expect(JSON.stringify([...a.end])).toBe(JSON.stringify([...b.end]));
    expect(a.orders).toBe(b.orders);
  });

  it("resolves the practice-bots roster from content", () => {
    const gm = configs.get<GamemodeConfig>("gamemode", "gamemode.practice-bots")!;
    const roster = resolveBotRoster(gm, configs);
    expect(roster.length).toBe(2);
    expect(roster.every((r) => r.team === 1)).toBe(true);
    expect(roster.map((r) => r.profile.id)).toEqual(["bot.aggressive", "bot.cautious"]);
  });
});

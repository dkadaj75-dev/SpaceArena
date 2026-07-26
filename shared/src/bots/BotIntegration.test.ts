import { beforeAll, describe, expect, it } from "vitest";

import type { ConfigService } from "../core/ConfigService.js";
import { orderSchema } from "../net/protocol.js";
import type { BotprofileConfig } from "../schemas/botprofile.js";
import type { GamemodeConfig } from "../schemas/gamemode.js";
import type { ShipConfig } from "../schemas/ship.js";
import type { TuningConfig } from "../schemas/tuning.js";
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
  /** Order counts by kind, so "bots fly like humans" is checkable. */
  orderKinds: Record<string, number>;
  start: Map<EntityId, { x: number; z: number }>;
  end: Map<EntityId, { x: number; z: number }>;
  botIds: EntityId[];
  /** Every module state a bot ship was ever seen in. */
  seenStates: Set<string>;
  /** Highest normalized lock progress any bot reached (FLIGHT.md §2). */
  peakLockProgress: number;
  /** Sim seconds at which a bot first completed a lock (Infinity if never). */
  firstLockAt: number;
  /** Sim seconds at which a bot first took weapon damage from another ship. */
  firstWeaponHitAt: number;
  /** Total hull/shield damage dealt by ships to ships (impacts excluded). */
  weaponDamage: number;
  /** Total damage from asteroid impacts and the arena boundary. */
  impactDamage: number;
  /** Sim seconds elapsed when the run stopped (match end or the time cap). */
  duration: number;
  /** Highest orders-in-one-second any single bot reached (all kinds). */
  peakOrdersPerSec: number;
  /** Highest `flight` orders-in-one-second any single bot reached. */
  peakFlightPerSec: number;
}

/**
 * Run a bot-vs-bot match through the real {@link ArenaSimulation}, feeding every
 * driver order through `applyOrder` — the same entry point the room and the
 * practice session use for human orders.
 */
function runMatch(profileIds: string[], seed: number, arenaId = "arena.ring-nebula"): RunResult {
  const sim = new ArenaSimulation(configs, arenaId, "gamemode.practice-bots", seed);
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
  const orderKinds: Record<string, number> = {};
  let orders = 0;
  let nowMs = 0;
  let peakLockProgress = 0;
  let firstLockAt = Infinity;
  let firstWeaponHitAt = Infinity;
  let weaponDamage = 0;
  let impactDamage = 0;
  let duration = 0;
  // Orders per bot per whole sim second — the same shape as ArenaRoom's
  // `rateLimited()` window, so the peak is directly comparable to the cap.
  const perSecond = new Map<string, { all: number; flight: number }>();
  let peakOrdersPerSec = 0;
  let peakFlightPerSec = 0;

  for (let i = 0; i < SECONDS / DT; i++) {
    if (sim.isEnded) break;
    nowMs += DT * 1000;
    const snapshot = sim.snapshot();
    duration = snapshot.elapsed;
    for (const s of snapshot.ships) {
      if (!drivers.has(s.id)) continue;
      for (const m of s.modules) seenStates.add(m.state);
      peakLockProgress = Math.max(peakLockProgress, s.lockProgress);
      if (s.locked && firstLockAt === Infinity) firstLockAt = snapshot.elapsed;
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
        orders++;
        orderKinds[order.kind] = (orderKinds[order.kind] ?? 0) + 1;
        const bucketKey = `${entityId}:${Math.floor(duration)}`;
        const bucket = perSecond.get(bucketKey) ?? { all: 0, flight: 0 };
        bucket.all++;
        if (order.kind === "flight") bucket.flight++;
        perSecond.set(bucketKey, bucket);
        peakOrdersPerSec = Math.max(peakOrdersPerSec, bucket.all);
        peakFlightPerSec = Math.max(peakFlightPerSec, bucket.flight);
        sim.applyOrder(entityId, order);
      }
    }
    sim.tick(DT);
    for (const ev of sim.world.events) {
      if (ev.type !== "damage") continue;
      if (ev.sourceId === null) impactDamage += ev.amount;
      else {
        weaponDamage += ev.amount;
        if (firstWeaponHitAt === Infinity) firstWeaponHitAt = duration;
      }
    }
    events.push(...sim.getEvents());
  }

  const end = new Map<EntityId, { x: number; z: number }>();
  for (const s of sim.snapshot().ships) end.set(s.id, { ...s.pos });

  return {
    events,
    orders,
    orderKinds,
    start,
    end,
    botIds,
    seenStates,
    peakLockProgress,
    firstLockAt,
    firstWeaponHitAt,
    weaponDamage,
    impactDamage,
    duration,
    peakOrdersPerSec,
    peakFlightPerSec,
  };
}

describe("bots in a live ArenaSimulation", () => {
  it("flies, locks, fires and lands hull damage inside a bounded match", () => {
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

    // Bots fly the human order vocabulary: continuous `flight` state, no move
    // orders anywhere (FLIGHT.md §7 — same order path, no sim-side privilege).
    expect(result.orderKinds["flight"]).toBeGreaterThan(0);
    expect(result.orderKinds["move"]).toBeUndefined();

    // Modules deployed, and the sensors actually completed a lock.
    expect(result.seenStates.has("active")).toBe(true);
    expect(result.peakLockProgress).toBe(1);
    expect(result.events.some((e) => e.type === "lockAcquired")).toBe(true);
    // Nose-on discipline fills a 1.2 s lock early in the merge, not eventually.
    expect(result.firstLockAt).toBeLessThan(10);

    // ...and a completed lock is converted into shots and hull damage.
    const fired = result.events.filter((e) => e.type === "projectileFired");
    expect(fired.length).toBeGreaterThan(4);
    expect(result.firstWeaponHitAt).toBeLessThan(15);
    expect(result.weaponDamage).toBeGreaterThan(40);
    // Weapons, not scenery, decide the fight. Flight retired asteroid avoidance
    // and no shipped profile re-adds it (see `avoidRocks`), so bots do eat rocks —
    // that cost is bounded and stays below what their guns achieve.
    expect(result.impactDamage).toBeLessThan(result.weaponDamage);

    // The invariant behind the gate: shots only ever exist alongside a lock.
    expect(fired.length === 0 || result.peakLockProgress === 1).toBe(true);
  });

  it("finds, closes and fights across the radius-300 deep field", () => {
    // The deep field spawns teams ~198 units apart — well outside every hull's
    // lockRange (FLIGHT.md §6), so this asserts the thing the small arena cannot:
    // bots that have to FIND each other still merge, lock and trade inside a
    // 30 s match. Automatic sticky targeting is what makes that survivable —
    // there is no target order left for a bot to pin the sensors with.
    const result = runMatch(["bot.aggressive", "bot.cautious"], 7, "arena.deep-field");

    expect(result.orderKinds["flight"]).toBeGreaterThan(0);
    expect(result.peakLockProgress).toBe(1);
    expect(result.events.some((e) => e.type === "lockAcquired")).toBe(true);
    // Closing 198 units at nominal speed is a couple of seconds, not a hunt.
    expect(result.firstLockAt).toBeLessThan(15);
    expect(result.weaponDamage).toBeGreaterThan(20);
    expect(result.impactDamage).toBeLessThan(result.weaponDamage);
  });

  it("resolves bot-vs-bot matches across seeds and profile pairings", () => {
    for (const [a, b, seed] of [
      ["bot.aggressive", "bot.aggressive", 3],
      ["bot.cautious", "bot.cautious", 11],
      ["bot.aggressive", "bot.cautious", 21],
      ["bot.aggressive", "bot.cautious", 42],
    ] as const) {
      const label = `${a} vs ${b} @${seed}`;
      const r = runMatch([a, b], seed);
      expect(r.firstLockAt, label).toBeLessThan(12);
      expect(r.events.filter((e) => e.type === "projectileFired").length, label).toBeGreaterThan(0);
      expect(r.weaponDamage, label).toBeGreaterThan(20);
    }
  });

  it("never lets a disciplined profile force-overheat a module", () => {
    // bot.cautious shuts down at 0.7 of threshold — it must never reach the
    // sim's forced `overheated` state, which is the whole point of 5.1's
    // moduleDiscipline (same skill axis as a human managing heat).
    const result = runMatch(["bot.cautious", "bot.cautious"], 11);
    expect(result.seenStates.has("overheated")).toBe(false);
    // Discipline holds while the bots are genuinely fighting, not because they
    // never switched anything on.
    expect(result.seenStates.has("active")).toBe(true);
    expect(result.weaponDamage).toBeGreaterThan(0);
  });

  /**
   * FLIGHT.md §5 / stage-5 review item. Bot orders reach the sim through
   * `ArenaRoom.driveBots`, which calls `validateOrder` but deliberately NOT
   * `rateLimited()` (there is no `Client` to rate-limit, and a bot cannot be
   * kicked). The only thing keeping a bot inside the cap a human is held to is
   * therefore {@link BotDriver.shouldSendFlight}'s epsilon gate plus the
   * decision cadence — so assert the resulting rate directly, over a full 30 s
   * match, per bot, in the same one-second window `rateLimited()` uses.
   */
  it("keeps every bot's order rate inside tuning.maxOrdersPerSec without the rate limiter", () => {
    // Cap resolution mirrors ArenaRoom: tuning value, else its 20/s default.
    const cap = configs.getAll<TuningConfig>("tuning")[0]?.maxOrdersPerSec ?? 20;

    for (const [a, b, seed] of [
      ["bot.aggressive", "bot.aggressive", 3],
      ["bot.aggressive", "bot.cautious", 7],
      ["bot.cautious", "bot.cautious", 11],
    ] as const) {
      const label = `${a} vs ${b} @${seed}`;
      const r = runMatch([a, b], seed);
      // The gate is only meaningful if the bots were actually flying.
      expect(r.orderKinds["flight"], label).toBeGreaterThan(0);
      expect(r.duration, label).toBeGreaterThan(5);
      // Flight traffic alone, and total traffic including target/module orders,
      // both stay under the cap — a human client sending this would never be
      // rate-limited, let alone kicked.
      expect(r.peakFlightPerSec, label).toBeLessThan(cap);
      expect(r.peakOrdersPerSec, label).toBeLessThan(cap);
      // A decision every `decisionIntervalMs` could emit ~1 flight order each;
      // the epsilon gate is what keeps it far below even that. Cross-check the
      // sustained average, so a single quiet second cannot carry the assertion.
      expect(r.orderKinds["flight"]! / r.duration, label).toBeLessThan(cap);
    }
  });

  it("is fully deterministic given the same seeds", () => {
    const a = runMatch(["bot.aggressive", "bot.cautious"], 3);
    const b = runMatch(["bot.aggressive", "bot.cautious"], 3);
    expect(JSON.stringify([...a.end])).toBe(JSON.stringify([...b.end]));
    expect(a.orders).toBe(b.orders);
    expect(a.orderKinds).toEqual(b.orderKinds);
    // Same seed ⇒ byte-identical match, not merely the same finishing positions.
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
    expect(a.weaponDamage).toBe(b.weaponDamage);
    expect(a.firstLockAt).toBe(b.firstLockAt);
  });

  it("resolves the practice-bots roster from content", () => {
    const gm = configs.get<GamemodeConfig>("gamemode", "gamemode.practice-bots")!;
    const roster = resolveBotRoster(gm, configs);
    expect(roster.length).toBe(2);
    expect(roster.every((r) => r.team === 1)).toBe(true);
    expect(roster.map((r) => r.profile.id)).toEqual(["bot.aggressive", "bot.cautious"]);
  });
});

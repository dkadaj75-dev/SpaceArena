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
import { deriveRng } from "../sim/rng.js";
import { loadTestConfigs } from "../sim/testutil.js";
import { BotDriver } from "./BotDriver.js";
import { resolveBotRoster } from "./roster.js";

const DT = 1 / 30;
const SECONDS = 30;

let configs: ConfigService;

beforeAll(async () => {
  configs = await loadTestConfigs();
});

interface RunResult {
  events: SimEvent[];
  orders: number;
  /** Order counts by kind, so "bots fly like humans" is checkable. */
  orderKinds: Record<string, number>;
  start: Map<EntityId, { x: number; y: number; z: number }>;
  end: Map<EntityId, { x: number; y: number; z: number; pitch: number }>;
  botIds: EntityId[];
  /** Largest |pitch| any bot ever held — 0 would mean the vertical axis was dead. */
  peakPitch: number;
  /** Widest and tightest |Δy| between the two bots over the match. */
  peakVerticalGap: number;
  minVerticalGap: number;
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
function runMatch(
  profileIds: string[],
  seed: number,
  arenaId = "arena.ring-nebula",
  opts: {
    /**
     * Whether to hand each driver an explicit seeded stream, mirroring what
     * ArenaRoom and GameSession do (`deriveRng(matchSeed, entityId)`). Set false
     * to exercise the driver's OWN default, which must also be deterministic —
     * there is no `Math.random` fallback any more (review Finding 2).
     */
    seedDrivers?: boolean;
    /**
     * Altitude to place bot `i` at immediately after spawn (BUBBLE.md §D). Both
     * shipped arenas still author `y: 0` spawns — that is T5's job — so a test that
     * wants a genuinely vertical engagement has to displace the ships itself. It
     * writes the transform the same way a spawn point would, before the first tick.
     */
    spawnY?: number[];
  } = {},
): RunResult {
  const sim = new ArenaSimulation(configs, arenaId, "gamemode.practice-bots", seed);
  const drivers = new Map<EntityId, BotDriver>();
  const botIds: EntityId[] = [];

  profileIds.forEach((profileId, i) => {
    const profile = configs.get<BotprofileConfig>("botprofile", profileId)!;
    const shipId = "ship.interceptor";
    const ship = configs.get<ShipConfig>("ship", shipId)!;
    const id = sim.spawnPlayer(shipId, ship.defaultFitting, i);
    const y = opts.spawnY?.[i];
    if (y !== undefined) sim.world.transforms.get(id)!.pos.y = y;
    drivers.set(
      id,
      opts.seedDrivers === false
        ? new BotDriver({ entityId: id, profile, configs })
        : new BotDriver({ entityId: id, profile, configs, rng: deriveRng(seed, id) }),
    );
    botIds.push(id);
  });

  const start = new Map<EntityId, { x: number; y: number; z: number }>();
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
  let peakPitch = 0;
  let peakVerticalGap = 0;
  let minVerticalGap = Infinity;

  for (let i = 0; i < SECONDS / DT; i++) {
    if (sim.isEnded) break;
    nowMs += DT * 1000;
    const snapshot = sim.snapshot();
    duration = snapshot.elapsed;
    for (const s of snapshot.ships) {
      if (!drivers.has(s.id)) continue;
      for (const m of s.modules) seenStates.add(m.state);
      peakLockProgress = Math.max(peakLockProgress, s.lockProgress);
      peakPitch = Math.max(peakPitch, Math.abs(s.pitch));
      if (s.locked && firstLockAt === Infinity) firstLockAt = snapshot.elapsed;
    }
    if (snapshot.ships.length >= 2) {
      const gap = Math.abs(snapshot.ships[0]!.pos.y - snapshot.ships[1]!.pos.y);
      peakVerticalGap = Math.max(peakVerticalGap, gap);
      minVerticalGap = Math.min(minVerticalGap, gap);
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

  // `pitch` travels with the end state so the determinism assertions cover the
  // attitude the bots flew, not only where they ended up.
  const end = new Map<EntityId, { x: number; y: number; z: number; pitch: number }>();
  for (const s of sim.snapshot().ships) end.set(s.id, { ...s.pos, pitch: s.pitch });

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
    peakPitch,
    peakVerticalGap,
    minVerticalGap,
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

  /**
   * Sampled scenarios, not exhaustive ones — and one sample is deliberately not
   * `bot.aggressive` × `bot.aggressive` @3. Two IDENTICAL aggressive profiles on
   * ring-nebula can settle into a mirrored co-orbit of the central rock: both
   * hold a lock (which needs only cone + range) at ~13 units for the whole
   * match, and every one of those ticks is line-of-sight blocked by the rock
   * they are circling, so neither ever gets a shot. That is legitimate emergent
   * behaviour of a one-rock arena, not a regression — it is just not a sample
   * that can carry a "matches resolve into a fight" assertion. It is knife-edge:
   * of eight seeds tried for that pairing, five fight and three deadlock.
   */
  it("resolves bot-vs-bot matches across seeds and profile pairings", () => {
    for (const [a, b, seed] of [
      ["bot.aggressive", "bot.aggressive", 9],
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

  /**
   * The T4 acceptance test (BUBBLE.md §D). Both shipped arenas still spawn every
   * ship on `y: 0`, so a bots-vs-bots match can look entirely healthy while the
   * pitch axis is dead — a planar bot would pass every assertion above. This one
   * starts the two teams 80 units apart VERTICALLY: the sim's lock cone is a true
   * 3D cone and weapon range is a 3D distance, so nothing here is reachable unless
   * the bots genuinely nose up and down.
   */
  it("locks and lands damage on an enemy at a completely different altitude", () => {
    const result = runMatch(["bot.aggressive", "bot.cautious"], 7, "arena.ring-nebula", { spawnY: [40, -40] });

    // The engagement really did start vertical.
    expect(Math.abs(result.start.get(result.botIds[0]!)!.y - result.start.get(result.botIds[1]!)!.y)).toBeCloseTo(80, 6);
    // Bots flew the vertical axis to get there — a planar bot's pitch stays 0.
    expect(result.peakPitch).toBeGreaterThan(0.3);
    // ...and they actually CLOSED that 80-unit gap rather than circling under one
    // another in plan view. (The gap widens again late in the match: the loser's
    // `retreat` runs flat out and the practice-bots boundary rule is `warning`, so
    // nothing turns it around. That predates the bubble — a planar retreat ran off
    // the same way — and it is the gamemode's rule to change, not the bots'.)
    expect(result.minVerticalGap).toBeLessThan(15);

    // The payoff: a completed 3D lock converted into shots and real damage.
    expect(result.peakLockProgress).toBe(1);
    expect(result.events.some((e) => e.type === "lockAcquired")).toBe(true);
    expect(result.firstLockAt).toBeLessThan(15);
    expect(result.events.filter((e) => e.type === "projectileFired").length).toBeGreaterThan(0);
    expect(result.weaponDamage).toBeGreaterThan(20);
    // Still the human order vocabulary, still inside the order cap.
    expect(result.orderKinds["flight"]).toBeGreaterThan(0);
    expect(result.orderKinds["move"]).toBeUndefined();
    expect(result.peakOrdersPerSec).toBeLessThan(configs.getAll<TuningConfig>("tuning")[0]?.maxOrdersPerSec ?? 20);
  });

  it("is byte-for-byte deterministic with pitched flight in play", () => {
    // Determinism has to survive the new axis: the pitch calibration reads back
    // simulated state, the jink axis alternates off sim time, and `pointOnSphere`
    // is trigonometric. Same seed ⇒ identical event stream, positions AND pitches.
    const opts = { spawnY: [40, -40] };
    const a = runMatch(["bot.aggressive", "bot.cautious"], 3, "arena.ring-nebula", opts);
    const b = runMatch(["bot.aggressive", "bot.cautious"], 3, "arena.ring-nebula", opts);
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
    expect(JSON.stringify([...a.end])).toBe(JSON.stringify([...b.end]));
    expect(a.orderKinds).toEqual(b.orderKinds);
    expect(a.weaponDamage).toBe(b.weaponDamage);
    // Not determinism by inertia: the bots pitched, fought and re-converged.
    expect(a.peakPitch).toBeGreaterThan(0.3);
    expect(a.orderKinds["flight"]).toBeGreaterThan(0);
    // A different seed still diverges, so the seed reaches the 3D flying too.
    const other = runMatch(["bot.aggressive", "bot.cautious"], 9, "arena.ring-nebula", opts);
    expect(JSON.stringify(other.events)).not.toBe(JSON.stringify(a.events));
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

  /**
   * Review Finding 2. The determinism above used to be an artefact of the test
   * harness: `BotDriver` defaulted its RNG to `Math.random`, and only tests
   * injected a seeded one, so the shipped code paths (ArenaRoom backfill,
   * offline GameSession) rolled fresh orbit signs, decision jitter and boost
   * rolls on every run. Assert it with NOTHING injected.
   */
  it("is deterministic with no rng injected at all — the driver has no Math.random default", () => {
    const a = runMatch(["bot.aggressive", "bot.cautious"], 3, "arena.ring-nebula", { seedDrivers: false });
    const b = runMatch(["bot.aggressive", "bot.cautious"], 3, "arena.ring-nebula", { seedDrivers: false });
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
    expect(JSON.stringify([...a.end])).toBe(JSON.stringify([...b.end]));
    expect(a.orders).toBe(b.orders);
    // The bots genuinely flew and fought, so this is not determinism by inertia.
    expect(a.orderKinds["flight"]).toBeGreaterThan(0);
    expect(a.weaponDamage).toBeGreaterThan(0);
  });

  it("makes the MATCH SEED reach the bots: different seeds diverge", () => {
    // The other half of Finding 2 — a per-bot stream derived from the match seed
    // must actually depend on it, or every seeded room plays the same fight.
    const a = runMatch(["bot.aggressive", "bot.cautious"], 3);
    const b = runMatch(["bot.aggressive", "bot.cautious"], 9);
    expect(JSON.stringify(a.events)).not.toBe(JSON.stringify(b.events));
  });

  it("resolves the practice-bots roster from content", () => {
    const gm = configs.get<GamemodeConfig>("gamemode", "gamemode.practice-bots")!;
    const roster = resolveBotRoster(gm, configs);
    expect(roster.length).toBe(2);
    expect(roster.every((r) => r.team === 1)).toBe(true);
    expect(roster.map((r) => r.profile.id)).toEqual(["bot.aggressive", "bot.cautious"]);
  });
});

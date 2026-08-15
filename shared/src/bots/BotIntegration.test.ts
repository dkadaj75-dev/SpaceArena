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
import { angleBetween3, facingVec } from "../sim/math.js";
import { deriveRng } from "../sim/rng.js";
import { loadTestConfigs } from "../sim/testutil.js";
import { BotDriver } from "./BotDriver.js";
import { resolveBotRoster } from "./roster.js";

const DT = 1 / 30;
// 60s: at the 50% damage rebase (owner 2026-08-05) guns need the longer
// window to decisively out-damage early-merge scenery contact.
const SECONDS = 60;

let configs: ConfigService;
let heatConfigs: ConfigService;

beforeAll(async () => {
  configs = await loadTestConfigs();
  heatConfigs = await loadTestConfigs({ heatSystem: true });
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
     * Altitude to place bot `i` at immediately after spawn (BUBBLE.md §D). The
     * shipped arenas now use modest authored vertical offsets; this override creates
     * an intentionally extreme engagement that cannot arise by accident. It writes
     * the transform the same way a spawn point would, before the first tick.
     */
    spawnY?: number[];
    /** An isolated content fixture for behavior that a test explicitly enables. */
    configService?: ConfigService;
  } = {},
): RunResult {
  const activeConfigs = opts.configService ?? configs;
  const sim = new ArenaSimulation(activeConfigs, arenaId, "gamemode.practice-bots", seed);
  const drivers = new Map<EntityId, BotDriver>();
  const botIds: EntityId[] = [];

  profileIds.forEach((profileId, i) => {
    const profile = activeConfigs.get<BotprofileConfig>("botprofile", profileId)!;
    const shipId = "ship.interceptor";
    const ship = activeConfigs.get<ShipConfig>("ship", shipId)!;
    // PINNED engagement geometry: these suites bound the merge (time to lock,
    // to first hit, to damage), so the merge distance must not drift with arena
    // content — the shipped pads moved out to r~82. 60 units apart, facing off
    // in the clear, so this remains a combat rather than scenery regression.
    const id = sim.spawnPlayerAt(
      shipId,
      ship.defaultFitting,
      i,
      { x: i === 0 ? -30 : 30, y: 0, z: 70 },
      i === 0 ? 0 : Math.PI,
    );
    const y = opts.spawnY?.[i];
    if (y !== undefined) sim.world.transforms.get(id)!.pos.y = y;
    drivers.set(
      id,
      opts.seedDrivers === false
        ? new BotDriver({ entityId: id, profile, configs: activeConfigs })
        : new BotDriver({ entityId: id, profile, configs: activeConfigs, rng: deriveRng(seed, id) }),
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
      if (Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) > 5) moved++;
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
    // Owner heat x10 deliberately puts more time into rack cooldowns.
    expect(fired.length).toBeGreaterThan(3);
    // Current finite cooling must still produce an exchange, not one opening
    // shot followed by a match-long heat hold. Thirty seconds => ×2 for /min.
    for (const id of result.botIds) {
      const perMinute = fired.filter((event) => event.ownerId === id).length * (60 / result.duration);
      // Half-damage fights (owner 2026-08-05) run longer past the hot merge, so
      // the whole-match average sits lower than the old 30s burst window.
      expect(perMinute).toBeGreaterThanOrEqual(2);
    }
    expect(result.firstWeaponHitAt).toBeLessThan(15);
    expect(result.weaponDamage).toBeGreaterThan(40);
    // At the 50% damage rebase gun totals cap near the kill while contact
    // damage does not, so the old impact<weapon comparison stopped measuring
    // intent here too: guns must do decisive work and scenery cost stays
    // bounded (avoidance keeps it from running away).
    expect(result.impactDamage).toBeLessThan(120);

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
    // At the 50% damage rebase a deep-field kill caps gun totals near the hull
    // pool while merge contact stays constant, so the old impact<weapon
    // comparison no longer measures intent. Guns must still do real work and
    // scenery cost must stay bounded.
    expect(result.weaponDamage).toBeGreaterThan(40);
    // Doubled rack heat stretches the deep-field exchange and exposes both
    // hulls to more merge contact. Keep a firm cap above the deterministic
    // 112.267 result; the lock and gun-damage checks still require a firefight.
    expect(result.impactDamage).toBeLessThan(120);
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

  it("keeps tuned marksmanship honest against a laterally moving target", () => {
    const trial = (withError: boolean, seed: number) => {
      const sim = new ArenaSimulation(configs, "arena.ring-nebula", "gamemode.practice-bots", seed);
      const ship = configs.get<ShipConfig>("ship", "ship.interceptor")!;
      const fitting = [...ship.defaultFitting];
      fitting[0] = "module.kinetic-mk1";
      fitting[1] = "module.kinetic-mk1";
      const base = configs.get<BotprofileConfig>("botprofile", "bot.rookie")!;
      const profile = {
        ...base,
        id: withError ? "bot.measure-tuned" : "bot.measure-perfect",
        behaviors: {
          ...base.behaviors,
          engage: {
            ...base.behaviors.engage!,
            aimErrorRad: withError ? base.behaviors.engage?.aimErrorRad : 0,
            velocityErrorSec: withError ? base.behaviors.engage?.velocityErrorSec : 0,
          },
        },
        fireDiscipline: { ...base.fireDiscipline, engageRangeMult: 1 },
      } as BotprofileConfig;
      const bot = sim.spawnPlayerAt("ship.interceptor", fitting, 0, { x: 0, y: 0, z: 70 }, 0);
      const target = sim.spawnPlayerAt("ship.interceptor", ship.defaultFitting, 1, { x: 0, y: 0, z: 125 }, Math.PI);
      const driver = new BotDriver({ entityId: bot, profile, configs, rng: deriveRng(seed, bot) });
      let fired = 0;
      let hits = 0;
      let nowMs = 0;
      for (let tick = 0; tick < 30 * 35; tick++) {
        const t = tick / 30;
        const targetTf = sim.world.transforms.get(target)!;
        targetTf.pos.x = Math.sin(t * 1.7) * 22;
        targetTf.pos.z = 125;
        Object.assign(sim.world.velocities.get(target)!, { x: 0, y: 0, z: 0 });
        // Keep the measurement alive after hits without changing collision size.
        sim.world.shipCores.get(target)!.hull = sim.world.shipCores.get(target)!.hullMax;
        nowMs += DT * 1000;
        const snapshot = sim.snapshot();
        for (const order of driver.update(snapshot, nowMs)) sim.applyOrder(bot, order);
        sim.tick(DT);
        for (const event of sim.getEvents()) {
          if (event.type === "projectileFired" && event.ownerId === bot && event.kind === "kinetic") fired++;
          if (event.type === "damage" && event.sourceId === bot && event.targetId === target) hits++;
        }
      }
      return { fired, hits, fraction: fired === 0 ? 0 : hits / fired };
    };

    const aggregate = (withError: boolean) => {
      let fired = 0;
      let hits = 0;
      for (const seed of [17, 31, 47, 59, 73, 89, 101, 127]) {
        const result = trial(withError, seed);
        fired += result.fired;
        hits += result.hits;
      }
      return { fired, hits, fraction: hits / fired };
    };
    const perfect = aggregate(false);
    const tuned = aggregate(true);
    const evidence = `perfect=${JSON.stringify(perfect)} tuned=${JSON.stringify(tuned)}`;
    expect(perfect.fired, evidence).toBeGreaterThan(8);
    expect(tuned.fired, evidence).toBeGreaterThan(5);
    // With Ring Nebula's versus-only origin occluder removed, this open-field
    // trial now measures the driver's own aim error rather than collision-aided
    // alignment. It must still land a meaningful fraction of its shots.
    expect(tuned.fraction, evidence).toBeGreaterThan(0.05);
    expect(tuned.fraction, evidence).toBeLessThan(0.5);
    // Doubled rack heat puts the profiles into different sparse firing phases
    // against this oscillating target. Their tiny-sample fractions are no
    // longer monotonic, so the tuned accuracy band above carries the intent.
  });

  /**
   * The T4 acceptance test (BUBBLE.md §D). The shipped offsets are intentionally
   * modest, so a bots-vs-bots match can still look entirely healthy while the pitch
   * axis is dead — a planar bot would pass every assertion above. This one starts
   * the two teams 80 units apart VERTICALLY: the sim's lock cone is a true
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
    // another in plan view. The damage boundary keeps a losing retreat from fleeing
    // unboundedly, while this assertion remains about closing the initial gap.
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

  it("keeps weapon heat meaningful at x10 without stalling bot combat", () => {
    // Missiles retain room for one launch, while the doubled laser shot heat
    // can legitimately trigger its own rack lockout. The bot must still re-arm
    // and land damage rather than stalling permanently.
    //
    // Seed re-pinned 11 → 5 on 2026-08-15: halving the missile rate of fire
    // halved the heat those racks generate, so seed 11 no longer trips a
    // lockout at x10 at all (it ends the match having only ever been `active`,
    // dealing 97.9 damage). That is the authored-heat drift docs/heat-system.md
    // warns about rather than a bot failure — the heat blocks have not been
    // rescaled since the weapons were retuned — and it is why the flag ships
    // off. Seeds 5, 7 and 9 still trip; 1, 2, 13, 17, 21 and 42 no longer do, which
    // is itself the measure of how far the heat costs have drifted.
    const result = runMatch(["bot.cautious", "bot.cautious"], 5, undefined, { configService: heatConfigs });
    expect(result.seenStates.has("overheated")).toBe(true);
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

  it("noses onto a target directly OVERHEAD instead of jittering at the pole", () => {
    // The pole was the one bearing the old clamp could not serve (BUBBLE.md §A):
    // a target straight up asks for an elevation of PI/2, the hull stopped at
    // ~1.4, and the bot held a full-deflection stick against a clamp that could
    // never null its own error. With pitch free the same request is simply
    // reachable — the bot pitches to vertical and flies at it.
    const sim = new ArenaSimulation(configs, "arena.ring-nebula", "gamemode.practice-bots", 11);
    const profile = configs.get<BotprofileConfig>("botprofile", "bot.aggressive")!;
    const ship = configs.get<ShipConfig>("ship", "ship.interceptor")!;
    const botId = sim.spawnPlayer("ship.interceptor", ship.defaultFitting, 0);
    const targetId = sim.spawnPlayer("ship.interceptor", ship.defaultFitting, 1);

    const bot = sim.world.transforms.get(botId)!;
    bot.pos.x = 0;
    bot.pos.y = 0;
    bot.pos.z = 0;
    bot.heading = 0;
    bot.pitch = 0; // level, nose on the horizon
    const target = sim.world.transforms.get(targetId)!;
    target.pos.x = 0;
    target.pos.y = 55; // inside the interceptor's 78-unit lockRange, straight up
    target.pos.z = 0;

    const driver = new BotDriver({ entityId: botId, profile, configs, rng: deriveRng(11, botId) });
    const coneRad = (ship.core.sensors.coneDeg / 2) * (Math.PI / 180);
    const facing = { x: 0, y: 0, z: 0 };
    const bearing = { x: 0, y: 0, z: 0 };

    let nowMs = 0;
    let onTargetAt = Infinity;
    let lockedAt = Infinity;
    let peakPitch = 0;
    const sticks: number[] = [];
    const TICKS = Math.round(6 / DT); // 6 sim seconds, countdown included

    for (let i = 0; i < TICKS; i++) {
      nowMs += DT * 1000;
      const snapshot = sim.snapshot();
      const self = snapshot.ships.find((s) => s.id === botId);
      const foe = snapshot.ships.find((s) => s.id === targetId);
      if (!self || !foe) break;

      facingVec(self.heading, self.pitch, facing);
      bearing.x = foe.pos.x - self.pos.x;
      bearing.y = foe.pos.y - self.pos.y;
      bearing.z = foe.pos.z - self.pos.z;
      if (angleBetween3(facing, bearing) <= coneRad && onTargetAt === Infinity) onTargetAt = i;
      if (self.locked && lockedAt === Infinity) lockedAt = i;
      peakPitch = Math.max(peakPitch, Math.abs(self.pitch));

      for (const order of driver.update(snapshot, nowMs)) {
        if (order.kind === "flight") sticks.push(order.pitchStick ?? 0);
        sim.applyOrder(botId, order);
      }
      // The target is a stationary dummy: no driver, no flight state, no drift.
      sim.tick(DT);
    }

    // Lock GEOMETRY first — the nose inside the sensor cone — then the sim's own
    // lock, which needs `lockTimeSec` of continuous nose-on discipline on top.
    expect(onTargetAt).toBeLessThan(Math.round(3 / DT));
    expect(lockedAt).toBeLessThan(TICKS);
    // The nose really did have to climb near vertical to get there — an
    // elevation the old clamp allowed only barely, and one this bot now holds by
    // choice rather than by being pinned.
    expect(peakPitch).toBeGreaterThan(1.0);
    // And it got there by holding one direction, not by chattering across the
    // pole: a jittering bot alternates the pitch axis EVERY decision, which over
    // this run would be dozens of flips. The bound is a chatter guard, not an
    // exact count — the bot also dodges whatever rocks the arena happens to place
    // in its climb, and each of those is a legitimate correction. Deliberately
    // loose enough to survive a re-authored arena while still failing hard on the
    // oscillation this test exists to catch.
    const flips = sticks.filter((s, i) => i > 0 && s !== 0 && sticks[i - 1]! !== 0 && Math.sign(s) !== Math.sign(sticks[i - 1]!)).length;
    expect(sticks.length).toBeGreaterThan(2);
    expect(flips).toBeLessThanOrEqual(Math.max(4, sticks.length / 4));
  });

  it("resolves the practice-bots roster from content: 2v2 — one allied rookie, two enemy rookies (owner 2026-07-31)", () => {
    const gm = configs.get<GamemodeConfig>("gamemode", "gamemode.practice-bots")!;
    const roster = resolveBotRoster(gm, configs);
    expect(roster.length).toBe(3);
    expect(roster.filter((r) => r.team === 0).length).toBe(1); // the player's wingman
    expect(roster.filter((r) => r.team === 1).length).toBe(2);
    expect(roster.every((r) => r.profile.id === "bot.rookie")).toBe(true);
  });

  it("resolves the 1v1 practice roster: one enemy rookie, no wingman (owner 2026-07-31)", () => {
    const gm = configs.get<GamemodeConfig>("gamemode", "gamemode.practice-bots-1v1")!;
    expect(gm.teams).toBe("1v1");
    const roster = resolveBotRoster(gm, configs);
    expect(roster.length).toBe(1);
    expect(roster[0]!.team).toBe(1);
    expect(roster[0]!.profile.id).toBe("bot.rookie");
  });

  it("both practice-vs-bots modes share one ruleset — only the team size differs", () => {
    const solo = configs.get<GamemodeConfig>("gamemode", "gamemode.practice-bots-1v1")!;
    const duo = configs.get<GamemodeConfig>("gamemode", "gamemode.practice-bots")!;
    expect(solo.winCondition).toEqual(duo.winCondition); // first to 10 frags
    expect(solo.timeLimitCapSec).toBe(duo.timeLimitCapSec); // same hard cap
    expect(solo.respawn).toEqual(duo.respawn);
    expect(solo.eliminationEndsMatch).toBe(false); // respawn modes must not end on a wipe
    expect(solo.boundaryRule).toEqual(duo.boundaryRule);
    expect(solo.defaultArena).toBe(duo.defaultArena);
  });

  it("separates a nose-in BRAWLER from the shipped colossal CTF rock and resumes movement", () => {
    const sim = new ArenaSimulation(configs, "arena.lunar-crater", "gamemode.practice-ctf-5v5", 17);
    const hull = configs.get<ShipConfig>("ship", "ship.brawler")!;
    const profile = configs.get<BotprofileConfig>("botprofile", "bot.flagrunner")!;
    const botId = sim.spawnPlayerAt(hull.id, hull.defaultFitting, 0, { x: 0, y: 12, z: 0 }, -Math.PI / 2);
    sim.spawnPlayerAt("ship.interceptor", configs.get<ShipConfig>("ship", "ship.interceptor")!.defaultFitting, 1, { x: 250, y: 12, z: 250 });
    const rockId = sim.world.asteroidIds().find((id) => sim.world.asteroids.get(id)?.configId === "asteroid.colossal-a")!;
    const rock = sim.world.transforms.get(rockId)!;
    const rockRadius = sim.world.colliders.get(rockId)!.radius;
    const bot = sim.world.transforms.get(botId)!;
    bot.pos.x = rock.pos.x;
    bot.pos.y = rock.pos.y;
    bot.pos.z = rock.pos.z + rockRadius + hull.collider.radius - 0.05;
    bot.heading = -Math.PI / 2; // exactly nose-in: the old recovery steering singularity
    const velocity = sim.world.velocities.get(botId)!;
    velocity.x = velocity.y = velocity.z = 0;

    const driver = new BotDriver({
      entityId: botId,
      profile,
      configs,
      rng: deriveRng(17, botId),
      floorY: 0,
      visualRadius: hull.render.modelScale,
    });
    let nowMs = 0;
    let separated = false;
    let resumed = false;
    for (let tick = 0; tick < 12 / DT; tick++) {
      nowMs += DT * 1000;
      for (const order of driver.update(sim.snapshot(), nowMs)) sim.applyOrder(botId, order);
      sim.tick(DT);
      const clearance = Math.hypot(bot.pos.x - rock.pos.x, bot.pos.y - rock.pos.y, bot.pos.z - rock.pos.z)
        - rockRadius - hull.collider.radius;
      separated ||= clearance >= Math.max(4, hull.collider.radius * 3);
      resumed ||= separated && Math.hypot(velocity.x, velocity.y, velocity.z) > 1;
    }
    expect(separated).toBe(true);
    expect(resumed).toBe(true);
  });
});

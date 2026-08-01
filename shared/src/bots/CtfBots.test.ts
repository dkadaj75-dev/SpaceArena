import { beforeAll, describe, expect, it } from "vitest";
import type { ConfigService } from "../core/ConfigService.js";
import type { BotprofileConfig, GamemodeConfig, ShipConfig } from "../schemas/index.js";
import { ArenaSimulation } from "../sim/ArenaSimulation.js";
import type { EntityId } from "../sim/components.js";
import type { SimEvent } from "../sim/events.js";
import { deriveRng } from "../sim/rng.js";
import { loadTestConfigs } from "../sim/testutil.js";
import { BotDriver } from "./BotDriver.js";

const DT = 1 / 30;
const CTF = "gamemode.practice-ctf-5v5";

let configs: ConfigService;
beforeAll(async () => {
  configs = await loadTestConfigs();
});

/**
 * A full 5v5 capture match driven entirely by bots. This is the proof that the
 * `objective` behaviour actually plays the mode rather than merely existing: no
 * assertion here inspects a bot's internals, only what the match produced.
 */
function playCtf(seed: number, seconds: number) {
  const sim = new ArenaSimulation(configs, "arena.ring-nebula", CTF, seed);
  const gamemode = configs.get<GamemodeConfig>("gamemode", CTF)!;
  const profile = configs.get<BotprofileConfig>("botprofile", "bot.flagrunner")!;
  const fitting = configs.get<ShipConfig>("ship", "ship.interceptor")!.defaultFitting;

  const drivers: { id: EntityId; driver: BotDriver }[] = [];
  const enlist = (team: number): void => {
    const id = sim.spawnPlayer("ship.interceptor", fitting, team);
    drivers.push({ id, driver: new BotDriver({ entityId: id, profile, configs, rng: deriveRng(seed, id) }) });
  };
  for (const slot of gamemode.bots?.roster ?? []) {
    for (let i = 0; i < (slot.count ?? 1); i++) enlist(slot.team);
  }
  enlist(0); // the seat a human would take, filled so both sides are five

  const events: SimEvent[] = [];
  const contactRuns = new Map<EntityId, { ticks: number; start: { x: number; y: number; z: number } }>();
  const stuck: Array<{ id: EntityId; pos: { x: number; y: number; z: number }; speed: number; home: number; surface: number }> = [];
  let nowMs = 0;
  for (let i = 0; i < Math.round(seconds / DT) && !sim.isEnded; i++) {
    nowMs += DT * 1000;
    const snapshot = sim.snapshot();
    for (const flag of snapshot.flags) {
      if (flag.state !== "carried" || flag.carrierId === null) continue;
      const carrier = snapshot.ships.find((candidate) => candidate.id === flag.carrierId);
      if (!carrier) continue;
      const shipRadius = sim.world.colliders.get(carrier.id)!.radius;
      const surface = Math.min(...sim.world.asteroidIds().map((asteroidId) => {
        const at = sim.world.transforms.get(asteroidId)!;
        return Math.hypot(carrier.pos.x - at.pos.x, carrier.pos.y - at.pos.y, carrier.pos.z - at.pos.z)
          - sim.world.colliders.get(asteroidId)!.radius - shipRadius;
      }));
      if (surface <= 0.05) {
        const run = contactRuns.get(carrier.id) ?? { ticks: 0, start: { ...carrier.pos } };
        run.ticks += 1;
        contactRuns.set(carrier.id, run);
        const displacement = Math.hypot(carrier.pos.x - run.start.x, carrier.pos.y - run.start.y, carrier.pos.z - run.start.z);
        if (run.ticks === 90 && displacement < 1) {
          const velocity = sim.world.velocities.get(carrier.id)!;
          const ownHome = snapshot.flags.find((candidate) => candidate.team === carrier.team)!.home;
          stuck.push({ id: carrier.id, pos: { ...carrier.pos }, speed: Math.hypot(velocity.x, velocity.y, velocity.z), home: Math.hypot(carrier.pos.x - ownHome.x, carrier.pos.y - ownHome.y, carrier.pos.z - ownHome.z), surface });
        }
      } else {
        contactRuns.delete(carrier.id);
      }
    }
    for (const { id, driver } of drivers) {
      if (!sim.hasShip(id)) continue;
      for (const order of driver.update(snapshot, nowMs)) sim.applyOrder(id, order);
    }
    sim.tick(DT);
    events.push(...sim.getEvents());
  }
  return { sim, events, stuck };
}

function carryFlagHome(seed: number, seconds: number) {
  const sim = new ArenaSimulation(configs, "arena.ring-nebula", CTF, seed);
  const profile = configs.get<BotprofileConfig>("botprofile", "bot.flagrunner")!;
  const ship = configs.get<ShipConfig>("ship", "ship.interceptor")!;
  const own = sim.snapshot().flags.find((flag) => flag.team === 0)!;
  // Start 100 units away and broadside to home. This makes the test exercise
  // arrival/turning rather than granting the runner a straight-line approach.
  const id = sim.spawnPlayerAt(
    "ship.interceptor",
    ship.defaultFitting,
    0,
    { x: own.home.x + 100, y: own.home.y, z: own.home.z },
    Math.PI / 2,
  );
  const enemyFlagId = sim.world.flagIds().find((flagId) => sim.world.flags.get(flagId)!.team === 1)!;
  const enemyFlag = sim.world.flags.get(enemyFlagId)!;
  enemyFlag.state = "carried";
  enemyFlag.carrierId = id;
  const flagTf = sim.world.transforms.get(enemyFlagId)!;
  Object.assign(flagTf.pos, sim.world.transforms.get(id)!.pos);

  const driver = new BotDriver({ entityId: id, profile, configs, rng: deriveRng(seed, id) });
  const events: SimEvent[] = [];
  const distances: number[] = [];
  let nowMs = 0;
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    nowMs += DT * 1000;
    const snapshot = sim.snapshot();
    const carrier = snapshot.ships.find((candidate) => candidate.id === id);
    if (!carrier) break;
    if (i % 30 === 0) {
      distances.push(Math.hypot(carrier.pos.x - own.home.x, carrier.pos.y - own.home.y, carrier.pos.z - own.home.z));
    }
    for (const order of driver.update(snapshot, nowMs)) sim.applyOrder(id, order);
    sim.tick(DT);
    events.push(...sim.getEvents());
    if (events.some((event) => event.type === "flagCaptured")) break;
  }
  return { events, distances };
}

function carryFlagAcrossCentre(seed: number, seconds: number) {
  const sim = new ArenaSimulation(configs, "arena.ring-nebula", CTF, seed);
  const profile = configs.get<BotprofileConfig>("botprofile", "bot.flagrunner")!;
  const ship = configs.get<ShipConfig>("ship", "ship.interceptor")!;
  const own = sim.snapshot().flags.find((flag) => flag.team === 0)!;
  const enemy = sim.snapshot().flags.find((flag) => flag.team === 1)!;
  const id = sim.spawnPlayerAt("ship.interceptor", ship.defaultFitting, 0, enemy.home, Math.PI * 1.25);
  const flag = sim.world.flags.get(enemy.id)!;
  flag.state = "carried";
  flag.carrierId = id;
  Object.assign(sim.world.transforms.get(enemy.id)!.pos, sim.world.transforms.get(id)!.pos);

  const driver = new BotDriver({ entityId: id, profile, configs, rng: deriveRng(seed, id) });
  const events: SimEvent[] = [];
  const samples: Array<{ second: number; x: number; y: number; z: number; speed: number; home: number; surface: number }> = [];
  let contactTicks = 0;
  let maxContactTicks = 0;
  let nowMs = 0;
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    nowMs += DT * 1000;
    const snapshot = sim.snapshot();
    const carrier = snapshot.ships.find((candidate) => candidate.id === id);
    if (!carrier) break;
    const shipRadius = sim.world.colliders.get(id)!.radius;
    const surface = Math.min(...sim.world.asteroidIds().map((asteroidId) => {
      const at = sim.world.transforms.get(asteroidId)!;
      const ar = sim.world.colliders.get(asteroidId)!.radius;
      return Math.hypot(carrier.pos.x - at.pos.x, carrier.pos.y - at.pos.y, carrier.pos.z - at.pos.z) - ar - shipRadius;
    }));
    contactTicks = surface <= 0.05 ? contactTicks + 1 : 0;
    maxContactTicks = Math.max(maxContactTicks, contactTicks);
    const velocity = sim.world.velocities.get(id)!;
    if (i % 30 === 0) samples.push({ second: i / 30, ...carrier.pos, speed: Math.hypot(velocity.x, velocity.y, velocity.z), home: Math.hypot(carrier.pos.x - own.home.x, carrier.pos.y - own.home.y, carrier.pos.z - own.home.z), surface });
    for (const order of driver.update(snapshot, nowMs)) sim.applyOrder(id, order);
    sim.tick(DT);
    events.push(...sim.getEvents());
    if (events.some((event) => event.type === "flagCaptured")) break;
  }
  return { events, samples, maxContactSec: maxContactTicks * DT };
}

describe("bots play capture the flag (owner 2026-07-31)", () => {
  it("get the flag off its stand and run with it", () => {
    const { events } = playCtf(42, 120);
    const taken = events.filter((e) => e.type === "flagTaken");
    expect(taken.length).toBeGreaterThan(0);
    // A carrier is always an ENEMY of the flag's owner — nobody picks up their
    // own flag off its base.
    for (const ev of taken) {
      if (ev.type !== "flagTaken") continue;
      expect(ev.carrierTeam).not.toBe(ev.flagTeam);
    }
  });

  it("actually score, rather than circling the objective forever", () => {
    const { sim, events, stuck } = playCtf(42, 300);
    const captures = events.filter((e) => e.type === "flagCaptured");
    expect(captures.length).toBeGreaterThan(0);
    const scores = sim.snapshot().teamScores;
    expect(scores.reduce((n, s) => n + s.captures, 0)).toBeGreaterThan(0);
    expect(stuck, `carriers pinned to asteroid colliders: ${JSON.stringify(stuck)}`).toEqual([]);
  });

  it("delivers a carried flag from a broadside approach", () => {
    const { events, distances } = carryFlagHome(42, 60);
    expect(
      events.some((event) => event.type === "flagCaptured"),
      `carrier distance to home each second: ${distances.map((distance) => distance.toFixed(2)).join(", ")}`,
    ).toBe(true);
  });

  it("routes a carrier around the colossal centrepiece without getting pinned", () => {
    const result = carryFlagAcrossCentre(42, 90);
    expect(result.events.some((event) => event.type === "flagCaptured"), JSON.stringify(result.samples)).toBe(true);
    expect(result.maxContactSec, JSON.stringify(result.samples)).toBeLessThan(3);
  });

  it("leave every flag in a legal state at the end of the run", () => {
    const { sim } = playCtf(11, 120);
    for (const flag of sim.snapshot().flags) {
      if (flag.state === "carried") {
        expect(flag.carrierId).not.toBeNull();
        // A carrier is a live ship on the other side.
        expect(sim.hasShip(flag.carrierId!)).toBe(true);
        expect(sim.teamOf(flag.carrierId!)).not.toBe(flag.team);
      } else {
        expect(flag.carrierId).toBeNull();
      }
      if (flag.state === "home") expect(flag.pos).toEqual(flag.home);
      if (flag.state === "dropped") expect(flag.dropRemaining).toBeGreaterThan(0);
    }
  });

  it("is deterministic — the same seed fields the same match", () => {
    const a = playCtf(5, 60);
    const b = playCtf(5, 60);
    expect(a.sim.snapshot().flags).toEqual(b.sim.snapshot().flags);
    expect(a.sim.snapshot().teamScores).toEqual(b.sim.snapshot().teamScores);
  });
});

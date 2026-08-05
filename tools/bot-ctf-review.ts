import type { BotprofileConfig, GamemodeConfig, ModuleConfig, ShipConfig } from "../shared/src/schemas/index.js";
import { BotDriver } from "../shared/src/bots/BotDriver.js";
import { ArenaSimulation } from "../shared/src/sim/ArenaSimulation.js";
import type { EntityId } from "../shared/src/sim/components.js";
import { dist3 } from "../shared/src/sim/math.js";
import { deriveRng } from "../shared/src/sim/rng.js";
import { loadTestConfigs } from "../shared/src/sim/testutil.js";

const DT = 1 / 30;
const SEEDS = [11, 42, 73];
const DURATION_SEC = 180;
const ARENA = "arena.lunar-crater";
const MODE = "gamemode.practice-ctf-5v5";
const NEAR_ZERO_SPEED = 0.5;
const STUCK_RADIUS = 2;
const STUCK_SEC = 5;

interface RunMetrics {
  seed: number;
  durationSec: number;
  distancePer10Sec: number[];
  nearZeroFraction: number[];
  shotsPerMinute: number[];
  rackLockoutFraction: number[];
  carrierRuns: Array<{ carrierId: EntityId; startHomeDistance: number; endHomeDistance: number; durationSec: number; outcome: string }>;
  stuckWindows: number;
  captures: number;
  floorCutFraction: number;
}

const configs = await loadTestConfigs();
const results = SEEDS.map(run);
const all = <K extends keyof RunMetrics>(key: K): number[] => results.flatMap((r) => r[key] as number[]);
const mean = (xs: number[]): number => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const quantile = (xs: number[], q: number): number => {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * q)]!;
};
const completed = results.flatMap((r) => r.carrierRuns).filter((r) => r.outcome === "captured");
console.log(JSON.stringify({
  seeds: SEEDS,
  durationSec: results.reduce((n, r) => n + r.durationSec, 0),
  perSeed: results,
  summary: {
    distancePer10Sec: { mean: mean(all("distancePer10Sec")), p10: quantile(all("distancePer10Sec"), 0.1) },
    nearZeroFraction: mean(all("nearZeroFraction")),
    shotsPerBotMinute: { mean: mean(all("shotsPerMinute")), p10: quantile(all("shotsPerMinute"), 0.1) },
    rackLockoutFraction: mean(all("rackLockoutFraction")),
    carrierTimeToHomeSec: { mean: mean(completed.map((r) => r.durationSec)), count: completed.length },
    stuckWindows: results.reduce((n, r) => n + r.stuckWindows, 0),
    captures: results.reduce((n, r) => n + r.captures, 0),
    floorCutFraction: mean(results.map((r) => r.floorCutFraction)),
  },
}, null, 2));

function run(seed: number): RunMetrics {
  const sim = new ArenaSimulation(configs, ARENA, MODE, seed);
  const mode = configs.get<GamemodeConfig>("gamemode", MODE)!;
  const profile = configs.get<BotprofileConfig>("botprofile", mode.bots!.defaultProfile!)!;
  const ship = configs.get<ShipConfig>("ship", mode.bots!.defaultShip!)!;
  const drivers = new Map<EntityId, BotDriver>();
  for (let team = 0; team < 2; team++) {
    for (let i = 0; i < 5; i++) {
      const id = sim.spawnPlayer(ship.id, ship.defaultFitting, team);
      drivers.set(id, new BotDriver({ entityId: id, profile, configs, rng: deriveRng(seed, id), floorY: 0 }));
    }
  }
  const ids = [...drivers.keys()];
  const windowDistance = new Map(ids.map((id) => [id, 0]));
  const distancePer10Sec: number[] = [];
  const nearZero = new Map(ids.map((id) => [id, 0]));
  const liveTicks = new Map(ids.map((id) => [id, 0]));
  const shots = new Map(ids.map((id) => [id, 0]));
  const lockoutTicks = new Map(ids.map((id) => [id, 0]));
  const rackTicks = new Map(ids.map((id) => [id, 0]));
  const previous = new Map<EntityId, { x: number; y: number; z: number }>();
  const stuck = new Map<EntityId, { start: { x: number; y: number; z: number }; ticks: number; reported: boolean }>();
  const activeRuns = new Map<EntityId, { startAt: number; startHomeDistance: number; lastHomeDistance: number }>();
  const carrierRuns: RunMetrics["carrierRuns"] = [];
  let captures = 0;
  let stuckWindows = 0;
  let floorCuts = 0;
  let decisions = 0;
  let nowMs = 0;
  let elapsed = 0;

  for (let tick = 0; tick < DURATION_SEC / DT && !sim.isEnded; tick++) {
    nowMs += DT * 1000;
    const snapshot = sim.snapshot();
    elapsed = snapshot.elapsed;
    const live = new Set(snapshot.ships.map((s) => s.id));
    for (const self of snapshot.ships) {
      if (!drivers.has(self.id)) continue;
      const velocity = sim.world.velocities.get(self.id)!;
      const speed = Math.hypot(velocity.x, velocity.y, velocity.z);
      liveTicks.set(self.id, liveTicks.get(self.id)! + 1);
      if (speed < NEAR_ZERO_SPEED) nearZero.set(self.id, nearZero.get(self.id)! + 1);
      const prior = previous.get(self.id);
      if (prior) {
        const delta = dist3(prior, self.pos);
        windowDistance.set(self.id, windowDistance.get(self.id)! + delta);
      }
      previous.set(self.id, { ...self.pos });
      for (const module of self.modules) {
        const config = configs.get<ModuleConfig>("module", module.moduleId);
        if (!config?.fire) continue;
        rackTicks.set(self.id, rackTicks.get(self.id)! + 1);
        if (module.state === "overheated") lockoutTicks.set(self.id, lockoutTicks.get(self.id)! + 1);
      }
    }
    if ((tick + 1) % (10 / DT) === 0) {
      for (const id of ids) {
        distancePer10Sec.push(windowDistance.get(id)!);
        windowDistance.set(id, 0);
      }
    }

    const carriers = new Set<EntityId>();
    for (const flag of snapshot.flags) {
      if (flag.state !== "carried" || flag.carrierId === null) continue;
      const self = snapshot.ships.find((s) => s.id === flag.carrierId);
      if (!self) continue;
      carriers.add(self.id);
      const ownHome = snapshot.flags.find((f) => f.team === self.team)!.home;
      const homeDistance = dist3(self.pos, ownHome);
      if (!activeRuns.has(self.id)) activeRuns.set(self.id, { startAt: elapsed, startHomeDistance: homeDistance, lastHomeDistance: homeDistance });
      activeRuns.get(self.id)!.lastHomeDistance = homeDistance;
      const state = stuck.get(self.id) ?? { start: { ...self.pos }, ticks: 0, reported: false };
      if (dist3(state.start, self.pos) <= STUCK_RADIUS && directPathClear(sim, self.id, ownHome)) state.ticks++;
      else Object.assign(state, { start: { ...self.pos }, ticks: 0, reported: false });
      if (!state.reported && state.ticks >= STUCK_SEC / DT) { stuckWindows++; state.reported = true; }
      stuck.set(self.id, state);
    }
    for (const [id, run] of activeRuns) {
      if (carriers.has(id)) continue;
      carrierRuns.push({ carrierId: id, startHomeDistance: run.startHomeDistance, endHomeDistance: run.lastHomeDistance, durationSec: elapsed - run.startAt, outcome: live.has(id) ? "dropped/captured" : "died" });
      activeRuns.delete(id);
      stuck.delete(id);
    }

    for (const [id, driver] of drivers) {
      if (!sim.hasShip(id)) continue;
      for (const order of driver.update(snapshot, nowMs)) sim.applyOrder(id, order);
      const decision = driver.lastDecision;
      if (decision?.atMs === nowMs && decision.flight) {
        decisions++;
        if (decision.flight.throttle < 0.05 && decision.plannedMove && (decision.flight.pitchStick - (decision.flight?.pitchStick ?? 0)) >= 0) floorCuts++;
      }
    }
    sim.tick(DT);
    for (const event of sim.getEvents()) {
      if (event.type === "projectileFired" && shots.has(event.ownerId)) shots.set(event.ownerId, shots.get(event.ownerId)! + 1);
      if (event.type === "flagCaptured") {
        captures++;
        const run = activeRuns.get(event.carrierId);
        if (run) {
          carrierRuns.push({ carrierId: event.carrierId, startHomeDistance: run.startHomeDistance, endHomeDistance: 0, durationSec: elapsed - run.startAt, outcome: "captured" });
          activeRuns.delete(event.carrierId);
        }
      }
    }
  }
  for (const [id, run] of activeRuns) carrierRuns.push({ carrierId: id, startHomeDistance: run.startHomeDistance, endHomeDistance: run.lastHomeDistance, durationSec: elapsed - run.startAt, outcome: "still-carrying" });
  return {
    seed, durationSec: elapsed, distancePer10Sec,
    nearZeroFraction: ids.map((id) => nearZero.get(id)! / Math.max(1, liveTicks.get(id)!)),
    shotsPerMinute: ids.map((id) => shots.get(id)! / Math.max(elapsed / 60, 1e-9)),
    rackLockoutFraction: ids.map((id) => lockoutTicks.get(id)! / Math.max(1, rackTicks.get(id)!)),
    carrierRuns, stuckWindows, captures, floorCutFraction: floorCuts / Math.max(1, decisions),
  };
}

function directPathClear(sim: ArenaSimulation, shipId: EntityId, target: { x: number; y?: number; z: number }): boolean {
  const from = sim.world.transforms.get(shipId)!.pos;
  const shipRadius = sim.world.colliders.get(shipId)!.radius;
  const vx = target.x - from.x, vy = (target.y ?? 0) - from.y, vz = target.z - from.z;
  const length2 = vx * vx + vy * vy + vz * vz;
  for (const id of sim.world.asteroidIds()) {
    const p = sim.world.transforms.get(id)!.pos;
    const t = Math.max(0, Math.min(1, ((p.x - from.x) * vx + (p.y - from.y) * vy + (p.z - from.z) * vz) / Math.max(length2, 1e-9)));
    const d = Math.hypot(p.x - (from.x + vx * t), p.y - (from.y + vy * t), p.z - (from.z + vz * t));
    if (d <= sim.world.colliders.get(id)!.radius + shipRadius + 1) return false;
  }
  return true;
}

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
const MODE = "gamemode.practice-ctf-10v10";
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
  objectiveIntentFraction: number[];
  pickupsByTeam: number[];
  returnsByTeam: number[];
  floorCutFraction: number;
  profiles: string[];
  meanAltitude: number[];
  nearFloorFraction: number[];
  floorContactEvents: number;
  floorRecoveryTriggers: number;
  combatEngagementFraction: number[];
  escortFraction: number[];
  carrierKills: number[];
  returns: number[];
  capturesByBot: number[];
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
const profileSummary = Object.fromEntries(configs.getAll<BotprofileConfig>("botprofile").map((profile) => {
  const samples = results.flatMap((result) => result.profiles.flatMap((id, index) => id === profile.id ? [{ result, index }] : []));
  return [profile.id, {
    objectiveIntentPct: mean(samples.map(({ result, index }) => result.objectiveIntentFraction[index]!)) * 100,
    combatEngagementPct: mean(samples.map(({ result, index }) => result.combatEngagementFraction[index]!)) * 100,
    escortPct: mean(samples.map(({ result, index }) => result.escortFraction[index]!)) * 100,
    carrierKills: samples.reduce((n, { result, index }) => n + result.carrierKills[index]!, 0),
    returns: samples.reduce((n, { result, index }) => n + result.returns[index]!, 0),
    captures: samples.reduce((n, { result, index }) => n + result.capturesByBot[index]!, 0),
  }];
}));
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
    objectiveIntentFraction: mean(all("objectiveIntentFraction")),
    pickupsByTeam: [0, 1].map((team) => results.reduce((n, r) => n + (r.pickupsByTeam[team] ?? 0), 0)),
    returnsByTeam: [0, 1].map((team) => results.reduce((n, r) => n + (r.returnsByTeam[team] ?? 0), 0)),
    floorCutFraction: mean(results.map((r) => r.floorCutFraction)),
    meanAltitude: mean(all("meanAltitude")),
    nearFloorFraction: mean(all("nearFloorFraction")),
    floorContactEvents: results.reduce((n, r) => n + r.floorContactEvents, 0),
    floorRecoveryTriggers: results.reduce((n, r) => n + r.floorRecoveryTriggers, 0),
    perProfile: profileSummary,
  },
}, null, 2));

function run(seed: number): RunMetrics {
  const sim = new ArenaSimulation(configs, ARENA, MODE, seed);
  const mode = configs.get<GamemodeConfig>("gamemode", MODE)!;
  const profiles = ["bot.flagrunner", "bot.aggressive", "bot.cautious", "bot.rookie"]
    .map((id) => configs.get<BotprofileConfig>("botprofile", id)!);
  const ship = configs.get<ShipConfig>("ship", mode.bots!.defaultShip!)!;
  const drivers = new Map<EntityId, BotDriver>();
  for (let team = 0; team < 2; team++) {
    for (let i = 0; i < 10; i++) {
      const id = sim.spawnPlayer(ship.id, ship.defaultFitting, team);
      const profile = profiles[(team * 10 + i) % profiles.length]!;
      drivers.set(id, new BotDriver({ entityId: id, profile, configs, rng: deriveRng(seed, id), floorY: sim.world.arena.bounds.shape === "sphere" ? sim.world.arena.bounds.floorY : undefined }));
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
  const objectiveTicks = new Map(ids.map((id) => [id, 0]));
  const profileIds = new Map([...drivers].map(([id, driver]) => [id, driver.profile.id]));
  const altitudeSum = new Map(ids.map((id) => [id, 0]));
  const nearFloorTicks = new Map(ids.map((id) => [id, 0]));
  const engagementTicks = new Map(ids.map((id) => [id, 0]));
  const escortTicks = new Map(ids.map((id) => [id, 0]));
  const carrierKills = new Map(ids.map((id) => [id, 0]));
  const returns = new Map(ids.map((id) => [id, 0]));
  const capturesByBot = new Map(ids.map((id) => [id, 0]));
  const recoveryActive = new Map(ids.map((id) => [id, false]));
  const pickupsByTeam = [0, 0];
  const returnsByTeam = [0, 0];
  const activeRuns = new Map<EntityId, { startAt: number; startHomeDistance: number; lastHomeDistance: number }>();
  const carrierRuns: RunMetrics["carrierRuns"] = [];
  let captures = 0;
  let stuckWindows = 0;
  let floorCuts = 0;
  let decisions = 0;
  let floorContactEvents = 0;
  let floorRecoveryTriggers = 0;
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
      const floorY = sim.world.arena.bounds.shape === "sphere" ? sim.world.arena.bounds.floorY : undefined;
      if (floorY !== undefined) {
        const altitude = self.pos.y - floorY - (self.colliderRadius ?? 0);
        altitudeSum.set(self.id, altitudeSum.get(self.id)! + altitude);
        if (altitude < Math.max(4, (self.colliderRadius ?? 0) * 3)) nearFloorTicks.set(self.id, nearFloorTicks.get(self.id)! + 1);
      }
      const ownCarrier = snapshot.flags.find((flag) => flag.team !== self.team && flag.state === "carried" && flag.carrierId !== null)?.carrierId;
      const carrier = snapshot.ships.find((candidate) => candidate.id === ownCarrier);
      if (carrier && carrier.id !== self.id && dist3(self.pos, carrier.pos) <= 35) escortTicks.set(self.id, escortTicks.get(self.id)! + 1);
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
      if (decision?.behavior === "objective") objectiveTicks.set(id, objectiveTicks.get(id)! + 1);
      if (decision?.engaged) engagementTicks.set(id, engagementTicks.get(id)! + 1);
      const recovering = decision?.floorRecovery === true;
      if (recovering && !recoveryActive.get(id)) floorRecoveryTriggers++;
      recoveryActive.set(id, recovering);
      const self = snapshot.ships.find((shipSnapshot) => shipSnapshot.id === id);
      if (self && decision?.flight && decision.flight.throttle >= 0.2) {
        const velocity = sim.world.velocities.get(id)!;
        const speed = Math.hypot(velocity.x, velocity.y, velocity.z);
        const contact = colliderSurface(sim, id) <= 0.05;
        const state = stuck.get(id) ?? { start: { ...self.pos }, ticks: 0, reported: false };
        if (contact && speed < NEAR_ZERO_SPEED && dist3(state.start, self.pos) <= STUCK_RADIUS) state.ticks++;
        else Object.assign(state, { start: { ...self.pos }, ticks: 0, reported: false });
        if (!state.reported && state.ticks >= STUCK_SEC / DT) { stuckWindows++; state.reported = true; }
        stuck.set(id, state);
      } else stuck.delete(id);
      if (decision?.atMs === nowMs && decision.flight) {
        decisions++;
        if (decision.flight.throttle < 0.05 && decision.plannedMove && (decision.flight.pitchStick - (decision.flight?.pitchStick ?? 0)) >= 0) floorCuts++;
      }
    }
    sim.tick(DT);
    for (const event of sim.getEvents()) {
      if (event.type === "boundaryHit") {
        const body = sim.world.transforms.get(event.entityId);
        const collider = sim.world.colliders.get(event.entityId);
        const floorY = sim.world.arena.bounds.shape === "sphere" ? sim.world.arena.bounds.floorY : undefined;
        if (body && collider && floorY !== undefined && body.pos.y <= floorY + collider.radius + 0.02) floorContactEvents++;
      }
      if (event.type === "projectileFired" && shots.has(event.ownerId)) shots.set(event.ownerId, shots.get(event.ownerId)! + 1);
      if (event.type === "flagCaptured") {
        captures++;
        if (capturesByBot.has(event.carrierId)) capturesByBot.set(event.carrierId, capturesByBot.get(event.carrierId)! + 1);
        const run = activeRuns.get(event.carrierId);
        if (run) {
          carrierRuns.push({ carrierId: event.carrierId, startHomeDistance: run.startHomeDistance, endHomeDistance: 0, durationSec: elapsed - run.startAt, outcome: "captured" });
          activeRuns.delete(event.carrierId);
        }
      }
      if (event.type === "flagTaken") pickupsByTeam[event.carrierTeam] = (pickupsByTeam[event.carrierTeam] ?? 0) + 1;
      if (event.type === "flagReturned" && event.byId !== null) {
        const team = sim.teamOf(event.byId);
        if (team !== undefined) returnsByTeam[team] = (returnsByTeam[team] ?? 0) + 1;
        if (returns.has(event.byId)) returns.set(event.byId, returns.get(event.byId)! + 1);
      }
      if (event.type === "entityDestroyed" && event.killerId !== null) {
        const wasCarrier = snapshot.flags.some((flag) => flag.state === "carried" && flag.carrierId === event.entityId);
        if (wasCarrier && carrierKills.has(event.killerId)) carrierKills.set(event.killerId, carrierKills.get(event.killerId)! + 1);
      }
    }
  }
  for (const [id, run] of activeRuns) carrierRuns.push({ carrierId: id, startHomeDistance: run.startHomeDistance, endHomeDistance: run.lastHomeDistance, durationSec: elapsed - run.startAt, outcome: "still-carrying" });
  return {
    seed, durationSec: elapsed, distancePer10Sec,
    nearZeroFraction: ids.map((id) => nearZero.get(id)! / Math.max(1, liveTicks.get(id)!)),
    shotsPerMinute: ids.map((id) => shots.get(id)! / Math.max(elapsed / 60, 1e-9)),
    rackLockoutFraction: ids.map((id) => lockoutTicks.get(id)! / Math.max(1, rackTicks.get(id)!)),
    carrierRuns, stuckWindows, captures,
    objectiveIntentFraction: ids.map((id) => objectiveTicks.get(id)! / Math.max(1, liveTicks.get(id)!)),
    pickupsByTeam, returnsByTeam,
    floorCutFraction: floorCuts / Math.max(1, decisions),
    profiles: ids.map((id) => profileIds.get(id)!),
    meanAltitude: ids.map((id) => altitudeSum.get(id)! / Math.max(1, liveTicks.get(id)!)),
    nearFloorFraction: ids.map((id) => nearFloorTicks.get(id)! / Math.max(1, liveTicks.get(id)!)),
    floorContactEvents,
    floorRecoveryTriggers,
    combatEngagementFraction: ids.map((id) => engagementTicks.get(id)! / Math.max(1, liveTicks.get(id)!)),
    escortFraction: ids.map((id) => escortTicks.get(id)! / Math.max(1, liveTicks.get(id)!)),
    carrierKills: ids.map((id) => carrierKills.get(id)!),
    returns: ids.map((id) => returns.get(id)!),
    capturesByBot: ids.map((id) => capturesByBot.get(id)!),
  };
}

function colliderSurface(sim: ArenaSimulation, shipId: EntityId): number {
  const from = sim.world.transforms.get(shipId)!.pos;
  const radius = sim.world.colliders.get(shipId)!.radius;
  let surface = Infinity;
  for (const id of [...sim.world.asteroidIds(), ...sim.world.shipIds()]) {
    if (id === shipId || !sim.world.transforms.has(id) || !sim.world.colliders.has(id)) continue;
    const at = sim.world.transforms.get(id)!.pos;
    surface = Math.min(surface, dist3(from, at) - radius - sim.world.colliders.get(id)!.radius);
  }
  return surface;
}

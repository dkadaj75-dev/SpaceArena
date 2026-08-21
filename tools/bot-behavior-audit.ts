import type { BotprofileConfig, GamemodeConfig, ModuleConfig, ShipConfig } from "../shared/src/schemas/index.js";
import { BotDriver } from "../shared/src/bots/BotDriver.js";
import { createBotDriver } from "../shared/src/bots/createBotDriver.js";
import { randomBotFitting } from "../shared/src/bots/botLoadout.js";
import { resolveBotRoster } from "../shared/src/bots/roster.js";
import { ArenaSimulation, type ShipSnapshot, type Snapshot } from "../shared/src/sim/ArenaSimulation.js";
import type { EntityId } from "../shared/src/sim/components.js";
import { MatchStatsAccumulator } from "../shared/src/sim/MatchStats.js";
import { dist3 } from "../shared/src/sim/math.js";
import { deriveRng } from "../shared/src/sim/rng.js";
import type { BotRole } from "../shared/src/bots/roleAllocator.js";
import { loadTestConfigs } from "../shared/src/sim/testutil.js";

const DT = 1 / 30;
const CTF_SEEDS = [11, 73];
const CTF_LIMIT_SEC = 600;
const DM_LIMIT_SEC = 900;
const DUEL_LIMIT_SEC = 600;
const STUCK_WINDOW_SEC = 10;
const STUCK_DISTANCE = 3;
const ZERO_THROTTLE = 0.05;
const EMPTY_FRACTION = 0.01;

interface BotAudit {
  id: EntityId;
  team: number;
  profile: string;
  ship: string;
  fitting: readonly (string | null)[];
  liveTicks: number;
  engagedTicks: number;
  fireTicks: number;
  commandThrottle: number;
  commandBoost: boolean;
  commandFire: boolean;
  shots: number;
  rackTicks: number;
  rackCooldownTicks: number;
  distance: number;
  zeroThrottleTicks: number;
  floorTicks: number;
  /**
   * Ticks where PREDICTIVE floor avoidance owned most of the command. Reported
   * separately from `floorTicks` (the latched recovery) because the predictive
   * branch fires at any altitude and can own the stick outright: counting only
   * the latched flag reported floorPct ~= 0 while the override was in fact
   * zeroing the throttle of most of the fleet.
   */
  floorAvoidTicks: number;
  surfaceTicks: number;
  missileTicks: number;
  carrierBoostTicks: number;
  damageDealt: number;
  damageTaken: number;
  objectiveHitEvents: number;
  objectiveHitShieldDown: number;
  shieldWantedTicks: number;
  shieldEmptyWantedTicks: number;
  boostWantedTicks: number;
  boostEmptyWantedTicks: number;
  decisions: number;
  lastDecisionAt: number;
  behaviors: Map<string, number>;
  /** Decisions taken under each team job claim (L2 occupancy). */
  roles: Map<BotRole, number>;
  /** Decisions where a combat behaviour won on a JOB while the threat latch was hot (D3). */
  combatUnderThreat: number;
  priorPos: { x: number; y: number; z: number } | null;
  moveWindow: Array<{ elapsed: number; pos: { x: number; y: number; z: number }; distance: number }>;
  worstStuck: StuckIncident | null;
}

interface StuckIncident {
  distance: number;
  pathDistance: number;
  elapsed: number;
  pos: { x: number; y: number; z: number };
  behavior: string | null;
  scores: Readonly<Record<string, number>>;
  throttle: number;
  turn: number;
  pitchStick: number;
  speed: number;
  surfaceRecovery: boolean;
  floorRecovery: boolean;
  contacts: readonly string[];
}

interface CarrierRun {
  id: EntityId;
  team: number;
  started: number;
  duration: number;
  distance: number;
  outcome: "captured" | "died" | "dropped" | "still-carrying";
  priorPos: { x: number; y: number; z: number };
}

interface MatchAudit {
  label: string;
  seed: number;
  elapsed: number;
  ended: boolean;
  winner: number | null;
  bots: BotAudit[];
  stats: MatchStatsAccumulator;
  captures: number[];
  attempts: number[];
  recoveries: number[];
  carrierRuns: CarrierRun[];
}

const configs = await loadTestConfigs();
const ctfMode = configs.get<GamemodeConfig>("gamemode", "gamemode.practice-ctf-5v5");
if (!ctfMode?.defaultArena) throw new Error("gamemode.practice-ctf-5v5 needs a defaultArena");
const duelSeedArg = process.env.BOT_AUDIT_DUEL_SEEDS ?? "7,17,42";
const range = duelSeedArg.match(/^(\d+)-(\d+)$/);
const duelSeeds = range
  ? Array.from({ length: Number(range[2]) - Number(range[1]) + 1 }, (_, index) => Number(range[1]) + index)
  : duelSeedArg.split(",").map(Number);
const baselineMatches = [
  ...CTF_SEEDS.map((seed) => runMatch("ctf", seed, ctfMode.defaultArena!, "gamemode.practice-ctf-5v5", CTF_LIMIT_SEC)),
  runMatch("deathmatch", 42, "arena.ring-nebula", "gamemode.practice-bots-5v5", DM_LIMIT_SEC),
];
const duelMatches = [
  ...duelSeeds.map((seed) => runMatch("duel-rookie", seed, "arena.ring-nebula", "gamemode.practice-duel-titans-1v1", DUEL_LIMIT_SEC, [
    { profile: "bot.rookie", ship: "ship.interceptor", team: 0 },
    { profile: "bot.rookie", ship: "ship.interceptor", team: 1 },
  ])),
  ...duelSeeds.map((seed) => runMatch("duel-brawler", seed, "arena.ring-nebula", "gamemode.practice-duel-titans-1v1", DUEL_LIMIT_SEC, [
    { profile: "bot.rookie", ship: "ship.brawler", team: 0 },
    { profile: "bot.rookie", ship: "ship.brawler", team: 1 },
  ])),
  ...duelSeeds.map((seed) => runMatch("duel-2v2", seed, "arena.ring-nebula", "gamemode.practice-duel-titans-1v1", DUEL_LIMIT_SEC, [
    { profile: "bot.rookie", ship: "ship.interceptor", team: 0 },
    { profile: "bot.rookie", ship: "ship.brawler", team: 0 },
    { profile: "bot.rookie", ship: "ship.interceptor", team: 1 },
    { profile: "bot.rookie", ship: "ship.brawler", team: 1 },
  ])),
];
const scenarioFilter = process.env.BOT_AUDIT_SCENARIO;
const selectedDuels = scenarioFilter ? duelMatches.filter((match) => match.label === scenarioFilter) : duelMatches;
const matches = process.env.BOT_AUDIT_DUELS_ONLY === "1" ? selectedDuels : [...baselineMatches, ...selectedDuels];

if (process.env.BOT_AUDIT_QUIET !== "1") {
  for (const match of matches) printMatch(match);
  printProfileSummary(matches);
  console.log("\nACCEPTANCE");
  for (const match of matches) printSummary(match);
} else {
  for (const match of matches) {
    for (const bot of match.bots.filter((candidate) => candidate.worstStuck)) {
      console.log("STUCK", match.label, `seed=${match.seed}`, `id=${bot.id}`, `ship=${bot.ship}`, bot.worstStuck);
    }
  }
}
printIssues(matches);

function runMatch(
  label: string,
  seed: number,
  arenaId: string,
  modeId: string,
  limitSec: number,
  authoredRoster?: readonly { profile: string; ship: string; team: number }[],
): MatchAudit {
  const sim = new ArenaSimulation(configs, arenaId, modeId, seed);
  const mode = configs.get<GamemodeConfig>("gamemode", modeId)!;
  const slots = resolveBotRoster(mode, configs);
  const wantedPerTeam = label === "ctf" ? 5 : Math.max(1, ...slots.map((slot) => slot.team + 1));
  const drivers = new Map<EntityId, BotDriver>();
  const audits = new Map<EntityId, BotAudit>();
  const teamCounts = new Map<number, number>();
  const spawn = (profile: BotprofileConfig, shipId: string, team: number, authored?: readonly (string | null)[]): void => {
    const ship = configs.get<ShipConfig>("ship", shipId)!;
    const rng = deriveRng(seed, team * 1_000 + (teamCounts.get(team) ?? 0) + 0xb07);
    const fitting = authored ?? (mode.bots?.randomizeLoadouts
      ? randomBotFitting(configs, ship.id, rng, profile)
      : ship.defaultFitting);
    const id = sim.spawnPlayer(ship.id, fitting, team);
    // Switching to createBotDriver deliberately GAINS staticWorld/navRoute (line-of-sight
    // and route planning, both previously absent here) and the collider-floored
    // visualRadius in place of a raw ship.render.modelScale — i.e. this now measures the
    // bot that actually ships. The tables recorded in docs/bots/behavior-map.md predate
    // this and need regenerating.
    drivers.set(id, createBotDriver(sim.world, id, profile, ship, deriveRng(seed, id)));
    audits.set(id, freshAudit(id, team, profile.id, ship.id, fitting));
    teamCounts.set(team, (teamCounts.get(team) ?? 0) + 1);
  };
  if (authoredRoster) {
    for (const slot of authoredRoster) {
      spawn(configs.get<BotprofileConfig>("botprofile", slot.profile)!, slot.ship, slot.team);
    }
  } else {
    for (const slot of slots) spawn(slot.profile, slot.shipId, slot.team, slot.fitting);
  }
  if (label === "ctf") {
    const fallback = configs.get<BotprofileConfig>("botprofile", mode.bots!.defaultProfile!)!;
    const shipId = mode.bots!.defaultShip!;
    for (const team of [0, 1]) {
      while ((teamCounts.get(team) ?? 0) < wantedPerTeam) spawn(fallback, shipId, team);
    }
  }

  const stats = new MatchStatsAccumulator((id) => audits.get(id)?.team);
  const activeRuns = new Map<EntityId, CarrierRun>();
  const carrierRuns: CarrierRun[] = [];
  const captures = [0, 0];
  const attempts = [0, 0];
  const recoveries = [0, 0];
  let nowMs = 0;
  while (!sim.isEnded && sim.snapshot().elapsed < limitSec) {
    nowMs += DT * 1000;
    const snapshot = sim.snapshot();
    const carriers = new Set(snapshot.flags.flatMap((flag) => flag.carrierId === null ? [] : [flag.carrierId]));
    trackCarrierRuns(snapshot, audits, activeRuns);
    for (const [id, driver] of drivers) {
      const self = snapshot.ships.find((ship) => ship.id === id);
      if (!self) {
        // Production practice hosts reset retained drivers while the old entity
        // id waits to respawn. Mirroring that is essential: otherwise the audit
        // invents a zero-throttle respawn stall from stale standing-order memory.
        driver.reset();
        continue;
      }
      const audit = audits.get(id)!;
      for (const order of driver.update(snapshot, nowMs)) {
        if (order.kind === "flight") {
          audit.commandThrottle = order.throttle;
          audit.commandBoost = order.boost;
          audit.commandFire = order.fire;
        }
        sim.applyOrder(id, order);
      }
      sampleBot(audit, self, snapshot, driver, carriers.has(id));
    }
    sim.tick(DT);
    const events = sim.getEvents();
    stats.consume(events, sim.snapshot().elapsed);
    for (const event of events) {
      if (event.type === "projectileFired") audits.get(event.ownerId)!.shots++;
      if (event.type === "damage" || event.type === "shieldAbsorb") {
        const targetAudit = audits.get(event.targetId);
        if (!targetAudit) continue;
        targetAudit.damageTaken += event.amount;
        if (event.sourceId !== null && audits.has(event.sourceId)) audits.get(event.sourceId)!.damageDealt += event.amount;
        const targetDriver = drivers.get(event.targetId);
        if (targetDriver?.lastDecision?.behavior === "objective") {
          targetAudit.objectiveHitEvents++;
          const target = sim.snapshot().ships.find((ship) => ship.id === event.targetId);
          if (target && !target.modules.some((module) => module.state === "active" && module.shieldPool > 0)) targetAudit.objectiveHitShieldDown++;
        }
      }
      if (event.type === "flagTaken") attempts[event.carrierTeam] = (attempts[event.carrierTeam] ?? 0) + 1;
      if (event.type === "flagReturned" && event.byId !== null) {
        const team = audits.get(event.byId)!.team;
        recoveries[team] = (recoveries[team] ?? 0) + 1;
      }
      if (event.type === "flagCaptured") {
        captures[event.scoringTeam] = (captures[event.scoringTeam] ?? 0) + 1;
        finishRun(activeRuns, carrierRuns, event.carrierId, "captured", sim.snapshot().elapsed);
      }
      if (event.type === "flagDropped" && event.carrierId !== null) {
        const dead = events.some((candidate) => candidate.type === "entityDestroyed" && candidate.entityId === event.carrierId);
        finishRun(activeRuns, carrierRuns, event.carrierId, dead ? "died" : "dropped", sim.snapshot().elapsed);
      }
    }
  }
  const final = sim.snapshot();
  for (const run of activeRuns.values()) carrierRuns.push({ ...run, duration: final.elapsed - run.started, outcome: "still-carrying" });
  return { label, seed, elapsed: final.elapsed, ended: sim.isEnded, winner: final.winnerTeam, bots: [...audits.values()], stats, captures, attempts, recoveries, carrierRuns };
}

function freshAudit(id: EntityId, team: number, profile: string, ship: string, fitting: readonly (string | null)[]): BotAudit {
  return {
    id, team, profile, ship, fitting, liveTicks: 0, engagedTicks: 0, fireTicks: 0,
    commandThrottle: 0, commandBoost: false, commandFire: false, shots: 0,
    rackTicks: 0, rackCooldownTicks: 0, distance: 0, zeroThrottleTicks: 0,
    floorTicks: 0, floorAvoidTicks: 0, surfaceTicks: 0, missileTicks: 0, carrierBoostTicks: 0,
    damageDealt: 0, damageTaken: 0, objectiveHitEvents: 0, objectiveHitShieldDown: 0,
    shieldWantedTicks: 0, shieldEmptyWantedTicks: 0,
    boostWantedTicks: 0, boostEmptyWantedTicks: 0, decisions: 0, lastDecisionAt: -1, behaviors: new Map(),
    roles: new Map(), combatUnderThreat: 0,
    priorPos: null, moveWindow: [], worstStuck: null,
  };
}

function sampleBot(audit: BotAudit, self: ShipSnapshot, snapshot: Snapshot, driver: BotDriver, carrying: boolean): void {
  // Respawning ships remain in snapshots with hull <= 0. Counting that authored
  // delay as a ten-second flight stall made every bot that died look wedged.
  if (self.hull <= 0) {
    audit.priorPos = null;
    audit.moveWindow.length = 0;
    return;
  }
  audit.liveTicks++;
  if (audit.priorPos) audit.distance += dist3(audit.priorPos, self.pos);
  audit.priorPos = { ...self.pos };
  const decision = driver.lastDecision;
  const blockedHold = isBlockedHomeHold(self, snapshot, driver.profile);
  if (decision?.engaged) audit.engagedTicks++;
  if (audit.commandFire) audit.fireTicks++;
  if (audit.commandThrottle < ZERO_THROTTLE && !blockedHold) audit.zeroThrottleTicks++;
  if (decision?.floorRecovery) audit.floorTicks++;
  if ((decision?.floorAvoidance ?? 0) >= 0.5) audit.floorAvoidTicks++;
  if (decision?.surfaceRecovery) audit.surfaceTicks++;
  if (decision?.missileEvasion) audit.missileTicks++;
  if (carrying && audit.commandBoost) audit.carrierBoostTicks++;
  if (decision && decision.atMs !== audit.lastDecisionAt) {
    audit.lastDecisionAt = decision.atMs;
    audit.decisions++;
    const key = decision.behavior ?? "none";
    audit.behaviors.set(key, (audit.behaviors.get(key) ?? 0) + 1);
    const role = decision.role ?? "free";
    audit.roles.set(role, (audit.roles.get(role) ?? 0) + 1);
    // The D3 unlock only exists for a bot holding a claim; a free agent fighting
    // under fire is ordinary combat and would drown the measurement.
    if (decision.underThreat && role !== "free" && (key === "engage" || key === "kite")) audit.combatUnderThreat++;
  }
  for (const module of self.modules) {
    const config = configs.get<ModuleConfig>("module", module.moduleId);
    if (!config) continue;
    if (config.fire) {
      audit.rackTicks++;
      // Heat deleted 2026-08-20: what a rack now spends waiting is its own
      // cycle time, so THAT is the downtime metric.
      if (module.cycleTimer > 0) audit.rackCooldownTicks++;
    }
    const fraction = module.energyCapacity > 0 ? module.energy / module.energyCapacity : 1;
    if (config.family === "shield" && decision?.engaged) {
      audit.shieldWantedTicks++;
      if (fraction <= EMPTY_FRACTION) audit.shieldEmptyWantedTicks++;
    }
    if (config.boost && audit.commandBoost) {
      audit.boostWantedTicks++;
      if (fraction <= EMPTY_FRACTION) audit.boostEmptyWantedTicks++;
    }
  }
  // An AUTHORED wait is loiter, not a powered flight stall: reset the window so
  // it cannot bridge the wait and indict the next route.
  //
  // Only the authored wait, though. This used to discard the window on ANY
  // zero-throttle tick outside a duel, which made the stuck detector blind to
  // exactly the failure it exists to catch: a bot whose throttle has been cut
  // by a bug simply never accumulates a window, so it can sit motionless for
  // an entire match and the audit reports `stuckRuns: 0`. That is what hid the
  // parked-nose-down flagrunners — `zeroPct` was the only witness. A commanded
  // zero in open space IS the stall, so it is now counted everywhere and
  // `detectIdle` no longer gates it.
  if (blockedHold) {
    audit.moveWindow.length = 0;
    return;
  }
  audit.moveWindow.push({ elapsed: snapshot.elapsed, pos: { ...self.pos }, distance: audit.distance });
  while (audit.moveWindow.length && snapshot.elapsed - audit.moveWindow[0]!.elapsed > STUCK_WINDOW_SEC) audit.moveWindow.shift();
  if (audit.moveWindow.length > 1 && snapshot.elapsed - audit.moveWindow[0]!.elapsed >= STUCK_WINDOW_SEC - DT * 2) {
    const pathDistance = audit.distance - audit.moveWindow[0]!.distance;
    const moved = process.env.BOT_AUDIT_STUCK_METRIC === "net" ? dist3(audit.moveWindow[0]!.pos, self.pos) : pathDistance;
    if (moved < STUCK_DISTANCE && (!audit.worstStuck || moved < audit.worstStuck.distance)) {
      const hull = configs.get<ShipConfig>("ship", audit.ship)!;
      const shipCollider = self.colliderRadius ?? hull.collider.radius;
      const shipVisual = hull.render.modelScale ?? shipCollider;
      const contacts = snapshot.asteroids
        .filter((asteroid) => asteroid.state !== "destroyed")
        .map((asteroid) => ({
          asteroid,
          center: dist3(self.pos, asteroid.pos),
          collider: dist3(self.pos, asteroid.pos) - (asteroid.colliderRadius ?? asteroid.radius) - shipCollider,
          rendered: dist3(self.pos, asteroid.pos) - asteroid.radius - shipVisual,
        }))
        .sort((a, b) => a.rendered - b.rendered);
      const velocity = self.velocity ?? { x: 0, y: 0, z: 0 };
      audit.worstStuck = {
        distance: moved,
        pathDistance,
        elapsed: snapshot.elapsed,
        pos: { ...self.pos },
        behavior: decision?.behavior ?? null,
        scores: decision?.scores ?? {},
        throttle: audit.commandThrottle,
        turn: decision?.flight?.turn ?? 0,
        pitchStick: decision?.flight?.pitchStick ?? 0,
        speed: Math.hypot(velocity.x, velocity.y, velocity.z),
        surfaceRecovery: decision?.surfaceRecovery === true,
        floorRecovery: decision?.floorRecovery === true,
        contacts: contacts.map(({ asteroid, center, collider, rendered }) =>
          `${asteroid.configId} center=${center.toFixed(2)} colliderGap=${collider.toFixed(2)} renderGap=${rendered.toFixed(2)} colliderContact=${collider <= 0.35} renderedContact=${rendered <= 0.35} rockCollider=${(asteroid.colliderRadius ?? asteroid.radius).toFixed(2)} rockRender=${asteroid.radius.toFixed(2)} shipCollider=${shipCollider.toFixed(2)} shipRender=${shipVisual.toFixed(2)}`),
      };
    }
  }
}

function isBlockedHomeHold(self: ShipSnapshot, snapshot: Snapshot, profile: BotprofileConfig): boolean {
  const carried = snapshot.flags.find((flag) => flag.carrierId === self.id && flag.team !== self.team);
  const own = snapshot.flags.find((flag) => flag.team === self.team);
  if (!carried || !own || own.state === "home") return false;
  const holdRange = Number(profile.behaviors.objective?.holdRange ?? 5);
  return dist3(self.pos, own.home) < holdRange;
}

function trackCarrierRuns(snapshot: Snapshot, audits: Map<EntityId, BotAudit>, active: Map<EntityId, CarrierRun>): void {
  for (const flag of snapshot.flags) {
    if (flag.carrierId === null || active.has(flag.carrierId)) continue;
    const ship = snapshot.ships.find((candidate) => candidate.id === flag.carrierId);
    if (!ship) continue;
    active.set(ship.id, { id: ship.id, team: audits.get(ship.id)!.team, started: snapshot.elapsed, duration: 0, distance: 0, outcome: "still-carrying", priorPos: { ...ship.pos } });
  }
  for (const run of active.values()) {
    const ship = snapshot.ships.find((candidate) => candidate.id === run.id);
    if (!ship) continue;
    run.distance += dist3(run.priorPos, ship.pos);
    run.priorPos = { ...ship.pos };
  }
}

function finishRun(active: Map<EntityId, CarrierRun>, complete: CarrierRun[], id: EntityId, outcome: CarrierRun["outcome"], elapsed: number): void {
  const run = active.get(id);
  if (!run) return;
  complete.push({ ...run, duration: elapsed - run.started, outcome });
  active.delete(id);
}

function printMatch(match: MatchAudit): void {
  console.log(`\n${match.label.toUpperCase()} seed=${match.seed} elapsed=${match.elapsed.toFixed(1)}s ended=${match.ended} winner=${match.winner ?? "draw"}`);
  console.table(match.bots.map((bot) => {
    const stat = match.stats.line(bot.id);
    return {
      id: bot.id, team: bot.team, profile: bot.profile.replace("bot.", ""), captures: stat.flagsCaptured,
      attempts: stat.flagsTaken, recoveries: stat.flagsReturned, kills: stat.kills, deaths: stat.deaths,
      assists: stat.assists, dealt: bot.damageDealt.toFixed(0), taken: bot.damageTaken.toFixed(0),
      firePct: pct(bot.fireTicks, bot.engagedTicks), shotsMin: rate(bot.shots, match.elapsed),
      cooldownPct: pct(bot.rackCooldownTicks, bot.rackTicks), floorPct: pct(bot.floorTicks, bot.liveTicks), avoidPct: pct(bot.floorAvoidTicks, bot.liveTicks),
      surfacePct: pct(bot.surfaceTicks, bot.liveTicks), missilePct: pct(bot.missileTicks, bot.liveTicks),
      zeroPct: pct(bot.zeroThrottleTicks, bot.liveTicks), energyStarvePct: pct(bot.shieldEmptyWantedTicks + bot.boostEmptyWantedTicks, bot.shieldWantedTicks + bot.boostWantedTicks),
    };
  }));
  console.table([0, 1].map((team) => {
    const bots = match.bots.filter((bot) => bot.team === team);
    return {
      team, captures: match.captures[team] ?? 0, attempts: match.attempts[team] ?? 0, recoveries: match.recoveries[team] ?? 0,
      kills: sum(bots, (bot) => match.stats.line(bot.id).kills), deaths: sum(bots, (bot) => match.stats.line(bot.id).deaths),
      assists: sum(bots, (bot) => match.stats.line(bot.id).assists), dealt: sum(bots, (bot) => bot.damageDealt).toFixed(0),
      taken: sum(bots, (bot) => bot.damageTaken).toFixed(0),
    };
  }));
  if (match.carrierRuns.length) console.table(match.carrierRuns.map((run) => ({ id: run.id, team: run.team, survivalSec: run.duration.toFixed(1), distance: run.distance.toFixed(1), outcome: run.outcome })));
  const stuck = match.bots.filter((bot) => bot.worstStuck).sort((a, b) => a.worstStuck!.distance - b.worstStuck!.distance);
  if (stuck.length) console.table(stuck.slice(0, 8).map((bot) => ({
    id: bot.id, profile: bot.profile, moved: bot.worstStuck!.distance.toFixed(2), path: bot.worstStuck!.pathDistance.toFixed(2),
    atSec: bot.worstStuck!.elapsed.toFixed(1), position: vec(bot.worstStuck!.pos), behavior: bot.worstStuck!.behavior,
    scores: JSON.stringify(bot.worstStuck!.scores), throttle: bot.worstStuck!.throttle.toFixed(2),
    stick: `${bot.worstStuck!.turn.toFixed(2)},${bot.worstStuck!.pitchStick.toFixed(2)}`,
    speed: bot.worstStuck!.speed.toFixed(2), surface: bot.worstStuck!.surfaceRecovery, floor: bot.worstStuck!.floorRecovery,
    contacts: bot.worstStuck!.contacts.join(" | "),
  })));
}

/**
 * One machine-comparable line per scenario. The per-bot tables are the evidence;
 * this is the acceptance row a before/after run is read off.
 */
function printSummary(match: MatchAudit): void {
  const zero = match.bots.filter((bot) => bot.liveTicks > 0).map((bot) => bot.zeroThrottleTicks / bot.liveTicks);
  const runs = match.carrierRuns;
  const survived = runs.filter((run) => run.outcome === "captured").length;
  const decisions = sum(match.bots, (bot) => bot.decisions);
  const roles = ["striker", "interceptor", "escort", "warden", "free"] as const;
  console.log("SUMMARY", {
    scenario: `${match.label}:${match.seed}`,
    end: match.ended ? `${match.elapsed.toFixed(1)}s ended` : `${match.elapsed.toFixed(1)}s cap`,
    captures: match.captures.join("-"),
    attempts: match.attempts.join("-"),
    carrierRuns: runs.length,
    carrierCaptured: survived,
    carrierDied: runs.filter((run) => run.outcome === "died").length,
    carrierMeanSec: Number((runs.reduce((total, run) => total + run.duration, 0) / Math.max(runs.length, 1)).toFixed(1)),
    zeroPctMean: Number(((zero.reduce((a, b) => a + b, 0) / Math.max(zero.length, 1)) * 100).toFixed(1)),
    zeroPctMax: Number((Math.max(0, ...zero) * 100).toFixed(1)),
    stuckRuns: match.bots.filter((bot) => bot.worstStuck).length,
    roleOccupancy: Object.fromEntries(roles.map((role) => [role, pct(sum(match.bots, (bot) => bot.roles.get(role) ?? 0), decisions)])),
    flagrunnerCombatUnderThreat: sum(match.bots.filter((bot) => bot.profile === "bot.flagrunner"), (bot) => bot.combatUnderThreat),
  });
}

function printProfileSummary(matches: MatchAudit[]): void {
  const profiles = [...new Set(matches.flatMap((match) => match.bots.map((bot) => bot.profile)))];
  console.log("\nBEHAVIOR OCCUPANCY BY PROFILE (% decisions won)");
  console.table(profiles.map((profile) => {
    const bots = matches.flatMap((match) => match.bots.filter((bot) => bot.profile === profile));
    const decisions = sum(bots, (bot) => bot.decisions);
    const keys = new Set(bots.flatMap((bot) => [...bot.behaviors.keys()]));
    return Object.fromEntries([["profile", profile], ...[...keys].sort().map((key) => [key, pct(sum(bots, (bot) => bot.behaviors.get(key) ?? 0), decisions)])]);
  }));
}

function printIssues(matches: MatchAudit[]): void {
  const bots = matches.flatMap((match) => match.bots);
  const ctf = matches.filter((match) => match.label === "ctf");
  const carrierBoost = sum(bots, (bot) => bot.carrierBoostTicks);
  const stuck = bots.filter((bot) => bot.worstStuck);
  const lockout = ratio(sum(bots, (bot) => bot.rackCooldownTicks), sum(bots, (bot) => bot.rackTicks));
  const fire = ratio(sum(bots, (bot) => bot.fireTicks), sum(bots, (bot) => bot.engagedTicks));
  const starvation = ratio(sum(bots, (bot) => bot.shieldEmptyWantedTicks + bot.boostEmptyWantedTicks), sum(bots, (bot) => bot.shieldWantedTicks + bot.boostWantedTicks));
  const objectiveShieldDown = ratio(sum(bots, (bot) => bot.objectiveHitShieldDown), sum(bots, (bot) => bot.objectiveHitEvents));
  console.log("\nAUDIT TOTALS", {
    stuckRuns: stuck.length,
    energyStarvationPct: Number((starvation * 100).toFixed(1)),
    objectiveShieldDownHitPct: Number((objectiveShieldDown * 100).toFixed(1)),
  });
  console.log("\nISSUES");
  const issues = [
    ...(ctf.some((match) => !match.ended) ? ["FINDING: at least one CTF match reached the 600 s cap without reaching the authored capture limit."] : []),
    ...(ctf.every((match) => match.attempts.reduce((a, b) => a + b, 0) === 0) ? ["FINDING: no CTF capture attempts were observed."] : []),
    ...(stuck.length ? [`FINDING: ${stuck.length} bot-runs moved < ${STUCK_DISTANCE} units in a ${STUCK_WINDOW_SEC} s non-loiter window.`] : []),
    ...(carrierBoost ? [`FIX: carriers requested boost for ${carrierBoost} ticks.`] : []),
    ...(lockout > 0.5 ? [`FINDING: aggregate rack lockout is ${(lockout * 100).toFixed(1)}%.`] : []),
    ...(fire < 0.05 ? [`FINDING: engaged fire uptime is only ${(fire * 100).toFixed(1)}%.`] : []),
    ...(starvation > 0.25 ? [`FINDING: wanted module energy starvation is ${(starvation * 100).toFixed(1)}%.`] : []),
    ...(objectiveShieldDown > 0.25 ? [`FINDING: objective bots had no active shield for ${(objectiveShieldDown * 100).toFixed(1)}% of incoming hit events.`] : []),
  ];
  if (!issues.length) console.log("No threshold divergence detected.");
  else for (const issue of issues) console.log(`- ${issue}`);
}

function sum<T>(items: readonly T[], value: (item: T) => number): number { return items.reduce((total, item) => total + value(item), 0); }
function ratio(n: number, d: number): number { return d > 0 ? n / d : 0; }
function pct(n: number, d: number): string { return `${(ratio(n, d) * 100).toFixed(1)}%`; }
function rate(n: number, elapsed: number): string { return (n / Math.max(elapsed / 60, 1e-9)).toFixed(1); }
function vec(pos: { x: number; y: number; z: number }): string { return `${pos.x.toFixed(1)},${pos.y.toFixed(1)},${pos.z.toFixed(1)}`; }

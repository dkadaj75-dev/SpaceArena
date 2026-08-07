import type { BotprofileConfig, GamemodeConfig, ModuleConfig, ShipConfig } from "../shared/src/schemas/index.js";
import { BotDriver } from "../shared/src/bots/BotDriver.js";
import { randomBotFitting } from "../shared/src/bots/botLoadout.js";
import { resolveBotRoster } from "../shared/src/bots/roster.js";
import { ArenaSimulation, type ShipSnapshot, type Snapshot } from "../shared/src/sim/ArenaSimulation.js";
import type { EntityId } from "../shared/src/sim/components.js";
import { MatchStatsAccumulator } from "../shared/src/sim/MatchStats.js";
import { dist3 } from "../shared/src/sim/math.js";
import { deriveRng } from "../shared/src/sim/rng.js";
import { loadTestConfigs } from "../shared/src/sim/testutil.js";

const DT = 1 / 30;
const CTF_SEEDS = [11, 73];
const CTF_LIMIT_SEC = 600;
const DM_LIMIT_SEC = 900;
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
  rackLockoutTicks: number;
  distance: number;
  zeroThrottleTicks: number;
  floorTicks: number;
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
  priorPos: { x: number; y: number; z: number } | null;
  moveWindow: Array<{ elapsed: number; pos: { x: number; y: number; z: number }; distance: number }>;
  worstStuck: StuckIncident | null;
}

interface StuckIncident {
  distance: number;
  elapsed: number;
  pos: { x: number; y: number; z: number };
  behavior: string | null;
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
const matches = [
  ...CTF_SEEDS.map((seed) => runMatch("ctf", seed, "arena.lunar-crater", "gamemode.practice-ctf-10v10", CTF_LIMIT_SEC)),
  runMatch("deathmatch", 42, "arena.ring-nebula", "gamemode.practice-bots-5v5", DM_LIMIT_SEC),
];

for (const match of matches) printMatch(match);
printProfileSummary(matches);
printIssues(matches);

function runMatch(label: string, seed: number, arenaId: string, modeId: string, limitSec: number): MatchAudit {
  const sim = new ArenaSimulation(configs, arenaId, modeId, seed);
  const mode = configs.get<GamemodeConfig>("gamemode", modeId)!;
  const slots = resolveBotRoster(mode, configs);
  const wantedPerTeam = label === "ctf" ? 10 : Math.max(1, ...slots.map((slot) => slot.team + 1));
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
    drivers.set(id, new BotDriver({
      entityId: id,
      profile,
      configs,
      rng: deriveRng(seed, id),
      arenaBounds: sim.world.arena.bounds,
      floorY: sim.world.arena.bounds.shape === "sphere" ? sim.world.arena.bounds.floorY : undefined,
      visualRadius: ship.render.modelScale,
    }));
    audits.set(id, freshAudit(id, team, profile.id, ship.id, fitting));
    teamCounts.set(team, (teamCounts.get(team) ?? 0) + 1);
  };
  for (const slot of slots) spawn(slot.profile, slot.shipId, slot.team, slot.fitting);
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
      if (!self) continue;
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
    rackTicks: 0, rackLockoutTicks: 0, distance: 0, zeroThrottleTicks: 0,
    floorTicks: 0, surfaceTicks: 0, missileTicks: 0, carrierBoostTicks: 0,
    damageDealt: 0, damageTaken: 0, objectiveHitEvents: 0, objectiveHitShieldDown: 0,
    shieldWantedTicks: 0, shieldEmptyWantedTicks: 0,
    boostWantedTicks: 0, boostEmptyWantedTicks: 0, decisions: 0, lastDecisionAt: -1, behaviors: new Map(),
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
  if (decision?.surfaceRecovery) audit.surfaceTicks++;
  if (decision?.missileEvasion) audit.missileTicks++;
  if (carrying && audit.commandBoost) audit.carrierBoostTicks++;
  if (decision && decision.atMs !== audit.lastDecisionAt) {
    audit.lastDecisionAt = decision.atMs;
    audit.decisions++;
    const key = decision.behavior ?? "none";
    audit.behaviors.set(key, (audit.behaviors.get(key) ?? 0) + 1);
  }
  for (const module of self.modules) {
    const config = configs.get<ModuleConfig>("module", module.moduleId);
    if (!config) continue;
    if (config.fire) {
      audit.rackTicks++;
      if (module.state === "overheated") audit.rackLockoutTicks++;
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
  // A cut-throttle arrival/respawn wait is loiter, not a powered flight stall.
  // Reset the window so it cannot bridge that wait and indict the next route.
  if (audit.commandThrottle < ZERO_THROTTLE || blockedHold) {
    audit.moveWindow.length = 0;
    return;
  }
  audit.moveWindow.push({ elapsed: snapshot.elapsed, pos: { ...self.pos }, distance: audit.distance });
  while (audit.moveWindow.length && snapshot.elapsed - audit.moveWindow[0]!.elapsed > STUCK_WINDOW_SEC) audit.moveWindow.shift();
  if (audit.moveWindow.length > 1 && snapshot.elapsed - audit.moveWindow[0]!.elapsed >= STUCK_WINDOW_SEC - DT * 2) {
    const moved = audit.distance - audit.moveWindow[0]!.distance;
    if (moved < STUCK_DISTANCE && (!audit.worstStuck || moved < audit.worstStuck.distance)) {
      audit.worstStuck = { distance: moved, elapsed: snapshot.elapsed, pos: { ...self.pos }, behavior: decision?.behavior ?? null };
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
      lockoutPct: pct(bot.rackLockoutTicks, bot.rackTicks), floorPct: pct(bot.floorTicks, bot.liveTicks),
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
  if (stuck.length) console.table(stuck.slice(0, 8).map((bot) => ({ id: bot.id, profile: bot.profile, moved: bot.worstStuck!.distance.toFixed(2), atSec: bot.worstStuck!.elapsed.toFixed(1), position: vec(bot.worstStuck!.pos), behavior: bot.worstStuck!.behavior })));
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
  const lockout = ratio(sum(bots, (bot) => bot.rackLockoutTicks), sum(bots, (bot) => bot.rackTicks));
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

/**
 * Headless match tracker (owner request 2026-08-15).
 *
 * Plays complete bot-vs-bot matches in the deterministic simulation — no
 * renderer, no server — and records everything a balance pass needs: who won
 * and how fast, per-pilot kills/deaths/assists, damage dealt and absorbed
 * broken down BY WEAPON and BY DAMAGE TYPE, time-to-kill samples, module
 * uptime, objective events, and where the damage actually landed (hull versus
 * shield).
 *
 * The sim is deterministic, so a run is fully reproducible from its seed. Each
 * match writes one JSON record; `tools/balance-report.ts` folds a directory of
 * them into docs/Balancing.md.
 *
 *   npx tsx tools/match-tracker.ts --mode ctf --matches 10 --out .balance/ctf
 *   npx tsx tools/match-tracker.ts --mode 5v5 --matches 10 --out .balance/5v5
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ConfigService } from "../shared/src/core/ConfigService.js";
import type {
  BotprofileConfig,
  GamemodeConfig,
  ShipConfig,
} from "../shared/src/schemas/index.js";
import { ArenaSimulation } from "../shared/src/sim/ArenaSimulation.js";
import type { EntityId } from "../shared/src/sim/components.js";
import type { SimEvent } from "../shared/src/sim/events.js";
import { deriveRng } from "../shared/src/sim/rng.js";
import { BotDriver } from "../shared/src/bots/BotDriver.js";
import { readFile } from "node:fs/promises";

const DT = 1 / 30;

/** One pilot's complete record for a match. */
export interface PilotRecord {
  entityId: EntityId;
  team: number;
  shipId: string;
  profileId: string;
  kills: number;
  deaths: number;
  assists: number;
  /** Damage that actually reduced hull, by the module that dealt it. */
  hullDamageByModule: Record<string, number>;
  /** Damage soaked by a shield, by the module that dealt it. */
  shieldDamageByModule: Record<string, number>;
  hullDamageByType: Record<string, number>;
  shieldDamageByType: Record<string, number>;
  hullDamageTaken: number;
  shieldDamageTaken: number;
  flagsTaken: number;
  flagsCaptured: number;
  flagsReturned: number;
  flagsDropped: number;
  /** Seconds this pilot was alive and able to fight. */
  aliveSec: number;
  secondsToFirstDeath: number | null;
}

export interface MatchRecord {
  mode: string;
  gamemodeId: string;
  arenaId: string;
  seed: number;
  durationSec: number;
  endedNaturally: boolean;
  score: Record<string, number>;
  winner: number | null;
  pilots: PilotRecord[];
  /** Seconds from a victim's first damage taken to its death — the real TTK. */
  ttkSamples: { victimShip: string; killerShip: string; sec: number }[];
  /** Total kills each ship class scored and suffered, for a quick matrix. */
  killMatrix: Record<string, Record<string, number>>;
  eventCounts: Record<string, number>;
}

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]!;
  if (fallback !== undefined) return fallback;
  throw new Error(`missing --${name}`);
}

const MODES: Record<string, { gamemode: string; arena: string }> = {
  ctf: { gamemode: "gamemode.practice-ctf-5v5", arena: "arena.lunar-rift" },
  "5v5": { gamemode: "gamemode.practice-bots-5v5", arena: "arena.deep-field" },
};

async function loadConfigs(): Promise<ConfigService> {
  const root = path.resolve(process.cwd(), "content");
  const svc = new ConfigService(async (rel: string) =>
    JSON.parse(await readFile(path.join(root, rel), "utf8")),
  );
  const result = await svc.load("manifest.json");
  if (!result.ok) throw new Error(`content failed to load: ${result.errors.slice(0, 3).map((e) => e.message).join("; ")}`);
  return svc;
}

/** Which module produced a hit, resolved from the event's module id when present. */
function moduleKey(ev: Extract<SimEvent, { type: "damage" | "shieldAbsorb" }>): string {
  const withModule = ev as unknown as { moduleId?: string; sourceModuleId?: string };
  return withModule.moduleId ?? withModule.sourceModuleId ?? "unknown";
}

export async function playMatch(
  configs: ConfigService,
  mode: string,
  seed: number,
  maxSeconds: number,
): Promise<MatchRecord> {
  const { gamemode: gamemodeId, arena: arenaId } = MODES[mode]!;
  const sim = new ArenaSimulation(configs, arenaId, gamemodeId, seed);
  const gamemode = configs.get<GamemodeConfig>("gamemode", gamemodeId)!;

  const pilots = new Map<EntityId, PilotRecord>();
  const drivers: { id: EntityId; driver: BotDriver }[] = [];

  const enlist = (team: number, shipId: string, profileId: string): void => {
    const ship = configs.get<ShipConfig>("ship", shipId)!;
    const profile = configs.get<BotprofileConfig>("botprofile", profileId)!;
    const id = sim.spawnPlayer(shipId, ship.defaultFitting, team);
    drivers.push({ id, driver: new BotDriver({ entityId: id, profile, configs, rng: deriveRng(seed, id) }) });
    pilots.set(id, {
      entityId: id, team, shipId, profileId,
      kills: 0, deaths: 0, assists: 0,
      hullDamageByModule: {}, shieldDamageByModule: {},
      hullDamageByType: {}, shieldDamageByType: {},
      hullDamageTaken: 0, shieldDamageTaken: 0,
      flagsTaken: 0, flagsCaptured: 0, flagsReturned: 0, flagsDropped: 0,
      aliveSec: 0, secondsToFirstDeath: null,
    });
  };

  // Seat the authored roster, then vary hulls across seats so the sample covers
  // every ship rather than re-measuring one hull ten times.
  const HULLS = ["ship.interceptor", "ship.brawler", "ship.support"];
  // Hull is chosen by the seat's index WITHIN ITS TEAM, never by a global
  // counter: a global one hands one side an extra brawler and the report then
  // reads that as a side bias rather than as the harness's own doing.
  const seatOfTeam = new Map<number, number>();
  const fallbackProfile = gamemode.bots?.defaultProfile ?? "bot.flagrunner";
  const seatUp = (team: number): number => {
    const n = seatOfTeam.get(team) ?? 0;
    seatOfTeam.set(team, n + 1);
    return n;
  };
  for (const slot of gamemode.bots?.roster ?? []) {
    for (let i = 0; i < (slot.count ?? 1); i++) {
      enlist(slot.team, HULLS[seatUp(slot.team) % HULLS.length]!, slot.profile ?? fallbackProfile);
    }
  }
  // The seat a human would occupy, so both sides field equal numbers.
  if (drivers.length % 2 === 1) enlist(0, HULLS[seatUp(0) % HULLS.length]!, fallbackProfile);

  const ttkSamples: MatchRecord["ttkSamples"] = [];
  const killMatrix: Record<string, Record<string, number>> = {};
  const eventCounts: Record<string, number> = {};
  // victim -> { firstHitSec, lastAttacker }
  const engagement = new Map<EntityId, { firstHitSec: number; lastAttacker: EntityId | null }>();
  const recentDamage = new Map<EntityId, Map<EntityId, number>>();

  let elapsed = 0;
  let nowMs = 0;
  const maxTicks = Math.round(maxSeconds / DT);
  for (let i = 0; i < maxTicks && !sim.isEnded; i++) {
    nowMs += DT * 1000;
    elapsed += DT;
    const snapshot = sim.snapshot();
    for (const { id, driver } of drivers) {
      if (!sim.hasShip(id)) continue;
      const record = pilots.get(id)!;
      record.aliveSec += DT;
      for (const order of driver.update(snapshot, nowMs)) sim.applyOrder(id, order);
    }
    sim.tick(DT);

    for (const ev of sim.getEvents()) {
      eventCounts[ev.type] = (eventCounts[ev.type] ?? 0) + 1;

      if ((ev.type === "damage" || ev.type === "shieldAbsorb") && !("isAsteroid" in ev && ev.isAsteroid)) {
        const source = ev.sourceId !== null ? pilots.get(ev.sourceId) : undefined;
        const victim = pilots.get(ev.targetId);
        const key = moduleKey(ev);
        if (source && ev.sourceId !== ev.targetId) {
          const byModule = ev.type === "damage" ? source.hullDamageByModule : source.shieldDamageByModule;
          const byType = ev.type === "damage" ? source.hullDamageByType : source.shieldDamageByType;
          byModule[key] = (byModule[key] ?? 0) + ev.amount;
          byType[ev.damageType] = (byType[ev.damageType] ?? 0) + ev.amount;
        }
        if (victim) {
          if (ev.type === "damage") victim.hullDamageTaken += ev.amount;
          else victim.shieldDamageTaken += ev.amount;
          if (!engagement.has(ev.targetId)) engagement.set(ev.targetId, { firstHitSec: elapsed, lastAttacker: ev.sourceId });
          else engagement.get(ev.targetId)!.lastAttacker = ev.sourceId ?? engagement.get(ev.targetId)!.lastAttacker;
          if (ev.sourceId !== null && ev.sourceId !== ev.targetId) {
            let attackers = recentDamage.get(ev.targetId);
            if (!attackers) { attackers = new Map(); recentDamage.set(ev.targetId, attackers); }
            attackers.set(ev.sourceId, elapsed);
          }
        }
      }

      if (ev.type === "entityDestroyed" && !ev.isAsteroid) {
        const victim = pilots.get(ev.entityId);
        if (victim) {
          victim.deaths++;
          if (victim.secondsToFirstDeath === null) victim.secondsToFirstDeath = elapsed;
          const bout = engagement.get(ev.entityId);
          const killerId = bout?.lastAttacker ?? null;
          const killer = killerId !== null ? pilots.get(killerId) : undefined;
          if (killer) {
            killer.kills++;
            const row = (killMatrix[killer.shipId] ??= {});
            row[victim.shipId] = (row[victim.shipId] ?? 0) + 1;
            if (bout) ttkSamples.push({ victimShip: victim.shipId, killerShip: killer.shipId, sec: +(elapsed - bout.firstHitSec).toFixed(2) });
          }
          // Assists: anyone else who damaged the victim in the last 8 seconds,
          // matching MatchStats' ASSIST_WINDOW_SEC.
          for (const [attacker, at] of recentDamage.get(ev.entityId) ?? []) {
            if (attacker === killerId || elapsed - at > 8) continue;
            const helper = pilots.get(attacker);
            if (helper) helper.assists++;
          }
          engagement.delete(ev.entityId);
          recentDamage.delete(ev.entityId);
        }
      }

      // Objective events. Each names the pilot responsible under a slightly
      // different key, so they are read individually rather than generically.
      const bumpFlag = (id: EntityId | null | undefined, stat: "flagsTaken" | "flagsCaptured" | "flagsReturned" | "flagsDropped"): void => {
        if (id === null || id === undefined) return;
        const pilot = pilots.get(id);
        if (pilot) pilot[stat]++;
      };
      if (ev.type === "flagTaken") bumpFlag(ev.carrierId, "flagsTaken");
      if (ev.type === "flagCaptured") bumpFlag(ev.carrierId, "flagsCaptured");
      if (ev.type === "flagReturned") bumpFlag((ev as unknown as { byId?: EntityId }).byId, "flagsReturned");
      if (ev.type === "flagDropped") bumpFlag((ev as unknown as { carrierId?: EntityId }).carrierId, "flagsDropped");
    }
  }

  // `teamScores` is the authoritative board. CTF is decided on captures, every
  // other mode on frags, so the winner is read from whichever this mode uses.
  const snap = sim.snapshot();
  const score: Record<string, number> = {};
  const decidedByCaptures = mode === "ctf";
  for (const row of snap.teamScores ?? []) {
    score[`team${row.team}.kills`] = row.kills;
    score[`team${row.team}.captures`] = row.captures;
  }
  let winner: number | null = null;
  const rows = [...(snap.teamScores ?? [])];
  if (rows.length === 2) {
    const value = (r: (typeof rows)[number]): number => (decidedByCaptures ? r.captures : r.kills);
    if (value(rows[0]!) !== value(rows[1]!)) {
      winner = value(rows[0]!) > value(rows[1]!) ? rows[0]!.team : rows[1]!.team;
    }
  }

  return {
    mode, gamemodeId, arenaId, seed,
    durationSec: +elapsed.toFixed(1),
    endedNaturally: sim.isEnded,
    score, winner,
    pilots: [...pilots.values()],
    ttkSamples, killMatrix, eventCounts,
  };
}

async function main(): Promise<void> {
  const mode = arg("mode", "ctf");
  if (!MODES[mode]) throw new Error(`unknown --mode ${mode} (have: ${Object.keys(MODES).join(", ")})`);
  const matches = Number(arg("matches", "10"));
  const seconds = Number(arg("seconds", "300"));
  const outDir = path.resolve(process.cwd(), arg("out", `.balance/${mode}`));
  mkdirSync(outDir, { recursive: true });

  const configs = await loadConfigs();
  for (let m = 0; m < matches; m++) {
    const seed = 1000 + m * 7;
    const started = Date.now();
    const record = await playMatch(configs, mode, seed, seconds);
    writeFileSync(path.join(outDir, `match-${String(m).padStart(2, "0")}.json`), JSON.stringify(record, null, 2));
    const kills = record.pilots.reduce((sum, p) => sum + p.kills, 0);
    process.stdout.write(
      `${mode} match ${m + 1}/${matches}  seed ${seed}  ${record.durationSec.toFixed(0)}s  ` +
      `score ${JSON.stringify(record.score)}  kills ${kills}  ${((Date.now() - started) / 1000).toFixed(1)}s wall\n`,
    );
  }
  process.stdout.write(`wrote ${matches} records to ${outDir}\n`);
}

if (process.argv[1]?.includes("match-tracker")) {
  main().catch((err) => { console.error(err); process.exit(1); });
}

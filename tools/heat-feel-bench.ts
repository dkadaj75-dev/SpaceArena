/**
 * Scripted proof of the 2026-08-07 heat/energy feel targets + the TTK matrix.
 * Run: node --import tsx <this file>
 */
import type { ConfigService } from "../shared/src/core/ConfigService.js";
import type { ModuleConfig, ShipConfig } from "../shared/src/schemas/index.js";
import { ArenaSimulation } from "../shared/src/sim/ArenaSimulation.js";
import { loadTestConfigs, pinLock } from "../shared/src/sim/testutil.js";

const DT = 1 / 30;
const TPS = 30;
const ARENA = "arena.bench";
const MODE = "gamemode.bench";

const configs: ConfigService = await loadTestConfigs();

function ensureBench(): void {
  const r1 = configs.replace({
    id: ARENA, type: "arena", version: 1, name: "Bench",
    bounds: { shape: "sphere", radius: 307.67 },
    asteroidPlacements: [],
    spawnPoints: [
      { id: "b0", team: 0, position: { x: 0, z: 0 }, heading: 0 },
      { id: "b1", team: 1, position: { x: 22, z: 0 }, heading: Math.PI },
    ],
  });
  if (!r1.ok) throw new Error(JSON.stringify(r1.errors));
  const r2 = configs.replace({
    id: MODE, type: "gamemode", version: 1, name: "Bench", teams: "1v1",
    winCondition: { type: "timeLimit", seconds: 3600 },
    eliminationEndsMatch: false,
    respawn: { enabled: false, delay: 0 },
    boundaryRule: { type: "warning" },
    rewards: { win: 0, loss: 0, perKill: 0 },
  });
  if (!r2.ok) throw new Error(JSON.stringify(r2.errors));
}

const ship = (id: string) => configs.get<ShipConfig>("ship", id)!;
const mod = (id: string) => configs.get<ModuleConfig>("module", id)!;
const r2 = (v: number) => Math.round(v * 100) / 100;

const BASE = [
  null,
  null,
  "module.engine-civ",
  "module.generator-compact",
  "module.transformer-stock",
  "module.heatsink-basic",
  "module.sensors-basic",
];

/** Interceptor fitting carrying exactly one module under test. */
function fittingWith(moduleId: string): (string | null)[] {
  const f = [...BASE];
  const m = mod(moduleId);
  const slot = m.family === "laser" || m.family === "kinetic" ? 0 : m.family === "utility" ? 7 : 1;
  if (slot === 7) f.push(null, moduleId);
  else f[slot] = moduleId;
  return f;
}

interface WeaponFeel {
  id: string;
  burnSec: number;
  lockoutSec: number;
  recoverSec: number;
  /** Share of a 60 s held trigger the rack was NOT locked out. */
  uptimePct: number;
  nominalDps: number;
  /** nominal x uptime — the damage a held trigger actually delivers. */
  sustainedDps: number;
}

/** Hold the trigger on an immortal target and watch one rack's whole cycle. */
function weaponFeel(moduleId: string): WeaponFeel {
  const cfg = mod(moduleId);
  const sim = new ArenaSimulation(configs, ARENA, MODE, 1);
  const me = sim.spawnPlayerAt("ship.interceptor", fittingWith(moduleId), 0, { x: 0, z: 0 }, 0);
  const foe = sim.spawnPlayerAt("ship.brawler", ship("ship.brawler").defaultFitting, 1, { x: 22, z: 0 }, Math.PI);
  const foeCore = sim.world.shipCores.get(foe)!;
  const m = sim.world.modules.get(me)!.modules.find((x) => x.moduleId === moduleId)!;
  sim.applyOrder(me, { kind: "flight", throttle: 0, turn: 0, boost: false, fire: true });

  let burn = -1;
  let rearm = -1;
  let upTicks = 0;
  const MEASURE_S = 60;
  for (let t = 1; t <= MEASURE_S * TPS; t++) {
    pinLock(sim.world, me);
    sim.tick(DT);
    sim.getEvents();
    foeCore.hull = foeCore.hullMax; // immortal sparring partner: this measures upkeep
    if (m.state !== "overheated") upTicks++;
    if (burn < 0 && m.state === "overheated") burn = t / TPS;
    if (burn > 0 && rearm < 0 && m.state !== "overheated") rearm = t / TPS - burn;
  }
  // Recovery from a full rack with the trigger released.
  const sim2 = new ArenaSimulation(configs, ARENA, MODE, 1);
  const me2 = sim2.spawnPlayerAt("ship.interceptor", fittingWith(moduleId), 0, { x: 0, z: 0 }, 0);
  const m2 = sim2.world.modules.get(me2)!.modules.find((x) => x.moduleId === moduleId)!;
  m2.heat = m2.heatCapacity;
  let recover = -1;
  for (let t = 1; t <= 30 * TPS; t++) {
    sim2.tick(DT);
    sim2.getEvents();
    if (m2.heat <= 0) {
      recover = t / TPS;
      break;
    }
  }
  const nominal =
    cfg.fire!.mode === "continuous" ? cfg.fire!.damage : cfg.fire!.damage / cfg.fire!.cycleTime;
  const uptime = upTicks / (MEASURE_S * TPS);
  return {
    id: moduleId,
    burnSec: r2(burn),
    lockoutSec: r2(rearm),
    recoverSec: r2(recover),
    uptimePct: Math.round(uptime * 100),
    nominalDps: r2(nominal),
    sustainedDps: r2(nominal * uptime),
  };
}

interface EnergyFeel {
  id: string;
  activeSec: number;
  rechargeSec: number;
  capacity: number;
}

/** Drain one energy module flat out, then time its refill from empty. */
function energyFeel(moduleId: string): EnergyFeel {
  const cfg = mod(moduleId);
  const isBoost = cfg.boost !== undefined;
  const fitting = isBoost && cfg.family === "engine" ? [...BASE] : fittingWith(moduleId);
  if (isBoost && cfg.family === "engine") fitting[2] = moduleId;
  if (isBoost && cfg.family === "boost") return { id: moduleId, activeSec: NaN, rechargeSec: NaN, capacity: 0 };

  const sim = new ArenaSimulation(configs, ARENA, MODE, 1);
  const me = sim.spawnPlayerAt("ship.interceptor", fitting, 0, { x: 0, z: 0 }, 0);
  const mods = sim.world.modules.get(me)!.modules;
  const m = mods.find((x) => x.moduleId === moduleId)!;
  // Bring it up (boost engines and shields both spawn offline).
  sim.applyOrder(me, { kind: "moduleToggle", hardpointIndex: m.hardpointIndex });
  for (let i = 0; i < 30; i++) {
    sim.applyOrder(me, { kind: "flight", throttle: 1, turn: 0, boost: true, fire: false });
    sim.tick(DT);
    sim.getEvents();
    if (m.state === "active") break;
  }

  let active = -1;
  for (let t = 1; t <= 60 * TPS; t++) {
    sim.applyOrder(me, { kind: "flight", throttle: 1, turn: 0, boost: true, fire: false });
    if (cfg.mitigation) m.energy = Math.max(0, m.energy - 6 * DT); // stand-in for focused fire
    sim.tick(DT);
    sim.getEvents();
    if (m.energy <= 0) {
      active = t / TPS;
      break;
    }
  }
  let recharge = -1;
  for (let t = 1; t <= 120 * TPS; t++) {
    sim.applyOrder(me, { kind: "flight", throttle: 0, turn: 0, boost: false, fire: false });
    sim.tick(DT);
    sim.getEvents();
    if (m.energy >= m.energyCapacity - 1e-6) {
      recharge = t / TPS;
      break;
    }
  }
  return { id: moduleId, activeSec: r2(active), rechargeSec: r2(recharge), capacity: r2(m.energyCapacity) };
}

// --- TTK matrix (the fixed bench, mirrored from balanceRegression) ---------
type KillResult = { outcome: "killed" | "attackerDied" | "neither"; seconds: number };

function timeToKill(attackerShip: string, defenderShip: string, range: number): KillResult {
  const sim = new ArenaSimulation(configs, ARENA, MODE, 1);
  const attacker = sim.spawnPlayerAt(attackerShip, ship(attackerShip).defaultFitting, 0, { x: 0, z: 0 }, 0);
  const defender = sim.spawnPlayerAt(defenderShip, ship(defenderShip).defaultFitting, 1, { x: range, z: 0 }, Math.PI);
  for (let t = 0; t < 5 * TPS; t++) {
    if (sim.world.targets.get(attacker)?.locked) break;
    sim.tick(DT);
    sim.getEvents();
  }
  sim.applyOrder(attacker, { kind: "flight", throttle: 0, turn: 0, boost: false, fire: true });
  for (let tick = 1; tick <= 120 * TPS; tick++) {
    sim.tick(DT);
    sim.getEvents();
    if (!sim.hasShip(attacker)) return { outcome: "attackerDied", seconds: r2(tick / TPS) };
    if (!sim.hasShip(defender)) return { outcome: "killed", seconds: r2(tick / TPS) };
  }
  return { outcome: "neither", seconds: Infinity };
}

ensureBench();
const WEAPONS = configs
  .getAll<ModuleConfig>("module")
  .filter((m) => m.fire)
  .map((m) => m.id)
  .sort();
const ENERGY = configs
  .getAll<ModuleConfig>("module")
  .filter((m) => m.energy && (m.boost || m.mitigation))
  .map((m) => m.id)
  .sort();

console.log("\n=== WEAPON THERMAL FEEL (interceptor hull, free radiator) ===");
console.log(
  ["module", "burn s", "lockout s", "recover s", "uptime %", "nominal DPS", "sustained DPS"].join("\t"),
);
for (const id of WEAPONS) {
  const f = weaponFeel(id);
  console.log([f.id, f.burnSec, f.lockoutSec, f.recoverSec, f.uptimePct, f.nominalDps, f.sustainedDps].join("\t"));
}

console.log("\n=== ENERGY MODULE FEEL (interceptor hull, free generator) ===");
console.log(["module", "capacity", "active s", "recharge s"].join("\t"));
for (const id of ENERGY) {
  const f = energyFeel(id);
  if (Number.isNaN(f.activeSec)) continue;
  console.log([f.id, f.capacity, f.activeSec, f.rechargeSec].join("\t"));
}

console.log("\n=== TTK MATRIX (default fittings, weapons hot, 22 units) ===");
const SHIPS = ["ship.interceptor", "ship.brawler", "ship.support"];
for (const a of SHIPS) {
  for (const d of SHIPS) {
    const r = timeToKill(a, d, 22);
    console.log([a, "vs", d, r.outcome, r.seconds].join("\t"));
  }
}


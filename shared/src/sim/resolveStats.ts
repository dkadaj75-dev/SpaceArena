import type { ConfigService } from "../core/ConfigService.js";
import type { ModuleConfig, ShipConfig, StatOp, UpgradeConfig } from "../schemas/index.js";
import type { ShipCore } from "./components.js";

/**
 * DB upgrade levels = **purchase counts** per track (0 = none bought, matching
 * `ship_upgrades` rows and `/api/ships`). A count of N means "levels[N-1] is the
 * active line" (each upgrade level holds the cumulative absolute delta from base);
 * count 0 applies no delta.
 */
export interface UpgradeLevels {
  hull: number;
  engine: number;
  energy: number;
  heat: number;
}

const ZERO_LEVELS: UpgradeLevels = { hull: 0, engine: 0, energy: 0, heat: 0 };

/** Canonical stat paths (no `core.` prefix). Order fixed for determinism. */
const STAT_PATHS = [
  "hull.base",
  "engine.nominalSpeed",
  "engine.accel",
  "engine.turnRate",
  "cooling.multiplier",
  "recharge.multiplier",
  "heatStore.multiplier",
  "energyStore.multiplier",
  "sensors.lockRange",
  "sensors.lockTimeSec",
  "sensors.coneDeg",
  "power.capacity",
  "efficiency.energyDraw",
  "efficiency.heatGen",
] as const;

/** Strip an optional leading `core.` so authors may write either form. */
function normalizePath(target: string): string {
  return target.startsWith("core.") ? target.slice("core.".length) : target;
}

/**
 * Deterministic stat resolution stack (4.1 ⭐). Pipeline, in fixed order:
 *
 *   ship class base
 *     → upgrade track levels   (upgrade config `add`/`mul` records = op bag)
 *     → module passive ops     (utility modules' `passives: StatOp[]`)
 *     → apply add, then mul, then clamp
 *
 * The one resolver used by sim spawn (server passes the player's DB upgrade
 * levels) and exported for the future hangar stat panel / balance workbench.
 * Pure and deterministic: same inputs ⇒ same {@link ShipCore}.
 */
export function resolveShipStats(
  config: ShipConfig,
  configs: ConfigService,
  opts: { upgradeLevels?: UpgradeLevels; fittedModuleIds?: readonly (string | null | undefined)[] } = {},
): ShipCore {
  const upgradeLevels = opts.upgradeLevels ?? ZERO_LEVELS;
  const c = config.core;

  // Flatten base stats into a path→value bag.
  const base: Record<string, number> = {
    "hull.base": c.hull.base,
    "engine.nominalSpeed": c.engine.nominalSpeed,
    "engine.accel": c.engine.accel,
    "engine.turnRate": c.engine.turnRate,
    // Hull-wide heat/energy levers (overhaul 2026-08-07). Defaulted rather than
    // required for the same reason `efficiency` is: hand-built cores (editor
    // previews, benches) may omit them, and "no opinion" is a multiplier of 1.
    "cooling.multiplier": c.cooling?.multiplier ?? 1,
    "recharge.multiplier": c.recharge?.multiplier ?? 1,
    "heatStore.multiplier": c.heatStore?.multiplier ?? 1,
    "energyStore.multiplier": c.energyStore?.multiplier ?? 1,
    "sensors.lockRange": c.sensors.lockRange,
    "sensors.lockTimeSec": c.sensors.lockTimeSec,
    "sensors.coneDeg": c.sensors.coneDeg,
    "power.capacity": c.power?.capacity ?? 0,
    // Defaulted rather than required: the schema always supplies this block,
    // but hand-built configs (editor previews, balance workbench) may omit it,
    // and "no transformer opinion" is exactly a multiplier of 1.
    "efficiency.energyDraw": c.efficiency?.energyDraw ?? 1,
    "efficiency.heatGen": c.efficiency?.heatGen ?? 1,
  };

  const adds: Record<string, number> = {};
  const muls: Record<string, number> = {};
  const addOp = (path: string, v: number) => {
    const p = normalizePath(path);
    adds[p] = (adds[p] ?? 0) + v;
  };
  const mulOp = (path: string, v: number) => {
    const p = normalizePath(path);
    muls[p] = (muls[p] ?? 1) * v;
  };

  // 1. Upgrade track levels. count N → levels[N-1]; count 0 → nothing.
  const tracks: Array<[keyof UpgradeLevels, string]> = [
    ["hull", config.upgradeTracks.hull],
    ["engine", config.upgradeTracks.engine],
    ["energy", config.upgradeTracks.energy],
    ["heat", config.upgradeTracks.heat],
  ];
  for (const [track, upgradeId] of tracks) {
    const count = upgradeLevels[track];
    if (count <= 0) continue;
    const upgrade = configs.get<UpgradeConfig>("upgrade", upgradeId);
    if (!upgrade) continue;
    const level = upgrade.levels[Math.min(count, upgrade.levels.length) - 1];
    if (!level) continue;
    for (const [k, v] of Object.entries(level.add ?? {})) addOp(k, v);
    for (const [k, v] of Object.entries(level.mul ?? {})) mulOp(k, v);
  }

  // 2. Module passives (utility modules) plus the two dedicated ship-wide blocks
  //    a heatsink and a generator author directly. Iterate in fitted order for
  //    determinism; both blocks are multiplicative, so two sinks stack.
  for (const moduleId of opts.fittedModuleIds ?? []) {
    if (!moduleId) continue;
    const mod = configs.get<ModuleConfig>("module", moduleId);
    if (mod?.cooling) mulOp("cooling.multiplier", mod.cooling.multiplier);
    if (mod?.recharge) mulOp("recharge.multiplier", mod.recharge.multiplier);
    const passives: StatOp[] | undefined = mod?.passives;
    if (!passives) continue;
    for (const op of passives) {
      if (op.op === "add") addOp(op.target, op.value);
      else mulOp(op.target, op.value);
    }
  }

  // 3. Apply add → mul → clamp (never below 0).
  const stats: Record<string, number> = {};
  for (const path of STAT_PATHS) {
    const v = (base[path]! + (adds[path] ?? 0)) * (muls[path] ?? 1);
    stats[path] = v < 0 ? 0 : v;
  }

  const hullMax = stats["hull.base"]!;
  return {
    hull: hullMax,
    hullMax,
    shield: 0,
    shieldMax: 0,
    resists: { kinetic: c.hull.resists.kinetic, energy: c.hull.resists.energy },
    engine: {
      nominalSpeed: stats["engine.nominalSpeed"]!,
      accel: stats["engine.accel"]!,
      turnRate: stats["engine.turnRate"]!,
    },
    cooling: { multiplier: stats["cooling.multiplier"]! },
    recharge: { multiplier: stats["recharge.multiplier"]! },
    heatStore: { multiplier: stats["heatStore.multiplier"]! },
    energyStore: { multiplier: stats["energyStore.multiplier"]! },
    sensors: {
      lockRange: stats["sensors.lockRange"]!,
      lockTimeSec: stats["sensors.lockTimeSec"]!,
      coneDeg: stats["sensors.coneDeg"]!,
    },
    power: { capacity: stats["power.capacity"]! },
    efficiency: {
      energyDraw: stats["efficiency.energyDraw"]!,
      heatGen: stats["efficiency.heatGen"]!,
    },
  };
}

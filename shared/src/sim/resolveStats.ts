import type { ConfigService } from "../core/ConfigService.js";
import {
  COMBAT_MULT_MAX,
  COMBAT_MULT_MIN,
  DEFAULT_COMBAT_MULT,
  RESIST_MAX,
  RESIST_MIN,
  type DamageType,
} from "../schemas/common.js";
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
}

const ZERO_LEVELS: UpgradeLevels = { hull: 0, engine: 0, energy: 0 };

/** Canonical stat paths (no `core.` prefix). Order fixed for determinism. */
const STAT_PATHS = [
  "hull.base",
  // The hull's RESIST columns (owner 2026-08-22). They used to be copied
  // straight out of the ship config into the resolved core, which meant they
  // were the only combat-relevant hull numbers nothing could move — no upgrade
  // track, no module passive. The alloy line is exactly a trade against them
  // ("Martian Purity IV: +50% hull, +30% kinetic resist, −15% energy resist"),
  // so they become ordinary stat paths and travel the same add→mul→clamp road
  // as everything else. See {@link RESIST_PATHS} for the band.
  "hull.resists.kinetic",
  "hull.resists.energy",
  "engine.nominalSpeed",
  "engine.accel",
  "engine.turnRate",
  "recharge.multiplier",
  "energyStore.multiplier",
  "sensors.lockRange",
  "sensors.lockTimeSec",
  "sensors.coneDeg",
  "power.capacity",
  "efficiency.energyDraw",
  // Role profile (`core.combat`). Ordinary stat paths on purpose: an upgrade
  // track or a utility module's passive can move them exactly like speed or
  // hull, and a designer addresses them by the same dotted name.
  "combat.damageOutput.kinetic",
  "combat.damageOutput.energy",
  "combat.rateOfFire.kinetic",
  "combat.rateOfFire.energy",
  "combat.rateOfFire.hybrid",
  "combat.shieldEfficiency",
] as const;

/**
 * Stat paths held inside the combat band rather than merely floored at 0. The
 * schema already bounds what an AUTHOR can write; this bounds what upgrades and
 * passives can stack on top, so no combination of legal content produces a hull
 * that deals 40× damage or one that can never hurt anything.
 */
const COMBAT_PATHS: ReadonlySet<string> = new Set(
  STAT_PATHS.filter((p) => p.startsWith("combat.")),
);

/**
 * Stat paths held to the RESIST band rather than merely floored at 0 — the same
 * band `hull.resists` enforces on an author. A resist is a FRACTION of a hit
 * removed, so letting a stack of alloys push one to 1 would make a hull immune
 * to a whole damage channel, and letting one push below 0 would silently turn a
 * resist into a vulnerability nothing in the pipeline is written for.
 */
const RESIST_PATHS: ReadonlySet<string> = new Set(
  STAT_PATHS.filter((p) => p.startsWith("hull.resists.")),
);

/** Strip an optional leading `core.` so authors may write either form. */
function normalizePath(target: string): string {
  return target.startsWith("core.") ? target.slice("core.".length) : target;
}

/**
 * Deterministic stat resolution stack (4.1 ⭐). Pipeline, in fixed order:
 *
 *   ship class base
 *     → upgrade track levels   (upgrade config `add`/`mul` records = op bag)
 *     → module passive ops     (every fitted module's `passives: StatOp[]`)
 *     → apply add, then mul, then clamp
 *
 * ## The compose rule for stacked percentages (owner 2026-08-22)
 *
 * Per stat path: every `add` is SUMMED into one offset, every `mul` is
 * MULTIPLIED into one factor, and the result is `(base + Σadd) × Πmul`, clamped
 * last. So two modules that each move the same stat COMPOUND rather than
 * cancel or average: an Earth Engine Engineered IV (`engine.nominalSpeed` ×1.5)
 * fitted alongside a Martian Alloy Purity IV (×0.90) resolves to
 * `27 × 1.5 × 0.90 = 36.45`, not `27 × (1 + 0.5 − 0.10)`.
 *
 * Multiplication is commutative and every op comes from the ordered fitting, so
 * the result does not depend on which bay is read first — the resolver is
 * deterministic in the strong sense (same inputs ⇒ same bits), which is what
 * the golden-fingerprint suite pins.
 *
 * Runtime multipliers are NOT part of this: boost (`boost.speedMult`) and the
 * slowing ray both multiply the RESOLVED speed inside NavigationSystem, once
 * per tick, and never touch the core.
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
    "hull.resists.kinetic": c.hull.resists.kinetic,
    "hull.resists.energy": c.hull.resists.energy,
    "engine.nominalSpeed": c.engine.nominalSpeed,
    "engine.accel": c.engine.accel,
    "engine.turnRate": c.engine.turnRate,
    // Hull-wide energy levers. Defaulted rather than required for the same
    // reason `efficiency` is: hand-built cores (editor previews, benches) may
    // omit them, and "no opinion" is a multiplier of 1.
    "recharge.multiplier": c.recharge?.multiplier ?? 1,
    "energyStore.multiplier": c.energyStore?.multiplier ?? 1,
    "sensors.lockRange": c.sensors.lockRange,
    "sensors.lockTimeSec": c.sensors.lockTimeSec,
    "sensors.coneDeg": c.sensors.coneDeg,
    "power.capacity": c.power?.capacity ?? 0,
    // Defaulted rather than required: the schema always supplies this block,
    // but hand-built configs (editor previews, balance workbench) may omit it,
    // and "nothing is taxing this ship's draw" is exactly a multiplier of 1.
    // The Earth Engine line is what moves it now (owner 2026-08-22).
    "efficiency.energyDraw": c.efficiency?.energyDraw ?? 1,
    // Role profile: absent block, and absent field within it, both mean 1.
    "combat.damageOutput.kinetic": c.combat?.damageOutput?.kinetic ?? DEFAULT_COMBAT_MULT,
    "combat.damageOutput.energy": c.combat?.damageOutput?.energy ?? DEFAULT_COMBAT_MULT,
    "combat.rateOfFire.kinetic": c.combat?.rateOfFire?.kinetic ?? DEFAULT_COMBAT_MULT,
    "combat.rateOfFire.energy": c.combat?.rateOfFire?.energy ?? DEFAULT_COMBAT_MULT,
    "combat.rateOfFire.hybrid": c.combat?.rateOfFire?.hybrid ?? DEFAULT_COMBAT_MULT,
    "combat.shieldEfficiency": c.combat?.shieldEfficiency ?? DEFAULT_COMBAT_MULT,
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

  // 2. Module passives — every fitted module, internal bays included (the
  //    engine, alloy and sensor lines are ENTIRELY passives since 2026-08-22)
  //    — plus the ship-wide block a generator authors directly. Iterate in
  //    fitted order for determinism; the block is multiplicative, so two
  //    generators stack, and so do two passives on the same path.
  for (const moduleId of opts.fittedModuleIds ?? []) {
    if (!moduleId) continue;
    const mod = configs.get<ModuleConfig>("module", moduleId);
    if (mod?.recharge) mulOp("recharge.multiplier", mod.recharge.multiplier);
    const passives: StatOp[] | undefined = mod?.passives;
    if (!passives) continue;
    for (const op of passives) {
      if (op.op === "add") addOp(op.target, op.value);
      else mulOp(op.target, op.value);
    }
  }

  // 3. Apply add → mul → clamp (never below 0; combat paths to their band).
  const stats: Record<string, number> = {};
  for (const path of STAT_PATHS) {
    const v = (base[path]! + (adds[path] ?? 0)) * (muls[path] ?? 1);
    if (COMBAT_PATHS.has(path)) {
      stats[path] = Number.isFinite(v) ? Math.min(COMBAT_MULT_MAX, Math.max(COMBAT_MULT_MIN, v)) : DEFAULT_COMBAT_MULT;
      continue;
    }
    if (RESIST_PATHS.has(path)) {
      stats[path] = Number.isFinite(v) ? Math.min(RESIST_MAX, Math.max(RESIST_MIN, v)) : RESIST_MIN;
      continue;
    }
    stats[path] = v < 0 ? 0 : v;
  }

  const hullMax = stats["hull.base"]!;
  return {
    hull: hullMax,
    hullMax,
    shield: 0,
    shieldMax: 0,
    resists: { kinetic: stats["hull.resists.kinetic"]!, energy: stats["hull.resists.energy"]! },
    engine: {
      nominalSpeed: stats["engine.nominalSpeed"]!,
      accel: stats["engine.accel"]!,
      turnRate: stats["engine.turnRate"]!,
    },
    recharge: { multiplier: stats["recharge.multiplier"]! },
    energyStore: { multiplier: stats["energyStore.multiplier"]! },
    sensors: {
      lockRange: stats["sensors.lockRange"]!,
      lockTimeSec: stats["sensors.lockTimeSec"]!,
      coneDeg: stats["sensors.coneDeg"]!,
    },
    power: { capacity: stats["power.capacity"]! },
    efficiency: {
      energyDraw: stats["efficiency.energyDraw"]!,
    },
    combat: {
      damageOutput: {
        kinetic: stats["combat.damageOutput.kinetic"]!,
        energy: stats["combat.damageOutput.energy"]!,
      },
      rateOfFire: {
        kinetic: stats["combat.rateOfFire.kinetic"]!,
        energy: stats["combat.rateOfFire.energy"]!,
        hybrid: stats["combat.rateOfFire.hybrid"]!,
      },
      shieldEfficiency: stats["combat.shieldEfficiency"]!,
    },
  };
}

/**
 * The hull's rate-of-fire multiplier for a weapon of `type` — keyed by the
 * weapon's AUTHORED `fire.damageType`, so `hybrid` is the dual-type
 * (missile/warhead) bucket the designer sees in the ship tool, not a resolved
 * leaf. Above 1 means faster.
 */
export function rateOfFireFor(core: Pick<ShipCore, "combat">, type: DamageType): number {
  const rof = core.combat.rateOfFire;
  return type === "kinetic" ? rof.kinetic : type === "energy" ? rof.energy : rof.hybrid;
}

/**
 * Seconds this hull actually waits between shots of a weapon authored with
 * `cycleTime` seconds and `type` damage. Rate of fire DIVIDES the cycle: 2×
 * fire rate is half the wait. The multiplier is band-clamped well away from 0
 * by the resolver, so this cannot divide by zero.
 *
 * Ignored by `continuous` weapons, which have no shot cadence — see
 * {@link channelDamageScale}.
 */
export function effectiveCycleTime(core: Pick<ShipCore, "combat">, cycleTime: number, type: DamageType): number {
  return cycleTime / rateOfFireFor(core, type);
}

/**
 * What a channel's authored DPS is multiplied by on this hull. A `continuous`
 * weapon has no shots to speed up, so its rate-of-fire knob buys the only thing
 * that "firing more often" would have bought: more damage per second. Same
 * multiplier, same designer intent, no separate field.
 */
export function channelDamageScale(core: Pick<ShipCore, "combat">, type: DamageType): number {
  return rateOfFireFor(core, type);
}

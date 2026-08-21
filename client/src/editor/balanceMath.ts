import {
  hardpointsOf,
  resolveShipStats,
  type ConfigService,
  type ModuleConfig,
  type ShipConfig,
  type ShipCore,
} from "@space-arena/shared";

/**
 * Balance-workbench math (4.6b). Pure arithmetic over module/ship CONFIG numbers
 * — deliberately NOT the full {@link ArenaSimulation}. No movement, line-of-sight,
 * targeting or netcode is modelled because balance iteration only needs the
 * sustained energy/DPS envelope of a fit, which is a closed-form function of
 * the configs. Every simplification is called out in the field docs below.
 */

/** Minimal config surface these helpers need (so tests can pass a stub). */
export type ConfigLookup = Pick<ConfigService, "get" | "getAll">;

/** Resolved, per-fit balance metrics for one ship + module loadout. */
export interface FitMetrics {
  hull: number;
  /** Effective HP: `hull × (1 + averageResist)`. A coarse tankiness proxy (ignores channel split). */
  ehp: number;
  speed: number;
  /** Σ of every fitted module's own energy tank (boost bottles, shield reserves). */
  energyReserve: number;
  /** Resolved hull-wide recharge multiplier (generator + passives). */
  rechargeMult: number;
  /** Σ weapon `damage / cycleTime` over fitted weapons — the trigger-down rate. */
  burstDps: number;
  /**
   * Σ weapon DPS with each weapon's magazine downtime paid. Equal to
   * {@link burstDps} for clipless weapons: since the heat system was deleted
   * (2026-08-20) a weapon's only limiter is its own cycle time, so a gun with
   * no clip simply runs forever at its nominal rate.
   */
  sustainedDps: number;
  /** Shield reserve this fit contributes (Σ shield-module tank capacity). */
  shieldPool: number;
}

/** Resolve a fit's core stats via the shared 4.1 resolver (level-0 upgrades). */
export function resolveFitCore(ship: ShipConfig, configs: ConfigLookup, moduleIds: readonly (string | null)[]): ShipCore {
  return resolveShipStats(ship, configs as ConfigService, { fittedModuleIds: moduleIds });
}

/** Held-trigger shot rate including magazine downtime; clipless weapons are unchanged. */
function sustainedShotsPerSec(m: ModuleConfig): number {
  if (!m.fire || m.fire.mode === "continuous") return 0;
  const clip = m.fire.clip;
  return clip
    ? clip.size / ((clip.size - 1) * m.fire.cycleTime + clip.reloadSec)
    : 1 / m.fire.cycleTime;
}

/** Compute the balance metrics for a ship with a given ordered module loadout. */
export function fitMetrics(ship: ShipConfig, configs: ConfigLookup, moduleIds: readonly (string | null)[]): FitMetrics {
  const core = resolveFitCore(ship, configs, moduleIds);
  const mods = moduleIds
    .map((id) => (id ? configs.get<ModuleConfig>("module", id) : undefined))
    .filter((m): m is ModuleConfig => !!m);

  let energyReserve = 0;
  let burstDps = 0;
  let sustainedDps = 0;
  let shieldPool = 0;

  for (const m of mods) {
    const tank = (m.energy?.capacity ?? 0) * core.energyStore.multiplier;
    energyReserve += tank;
    if (m.mitigation) shieldPool += tank;
    if (m.fire) {
      const nominal = m.fire.mode === "continuous" ? m.fire.damage : m.fire.damage / m.fire.cycleTime;
      burstDps += nominal;
      // The magazine is the only thing that makes a held trigger deliver less
      // than its nominal rate now; a clipless weapon's two numbers are equal.
      sustainedDps += m.fire.mode === "continuous" ? nominal : m.fire.damage * sustainedShotsPerSec(m);
    }
  }

  const avgResist = (core.resists.kinetic + core.resists.energy) / 2;
  return {
    hull: core.hullMax,
    ehp: core.hullMax * (1 + avgResist),
    speed: core.engine.nominalSpeed,
    energyReserve,
    rechargeMult: core.recharge.multiplier,
    burstDps,
    sustainedDps,
    shieldPool,
  };
}

/**
 * Time-to-kill of `attacker` firing on `defender`, in seconds.
 * Simplification: `(defenderEHP + defenderShieldPool) / attackerSustainedDps`,
 * where sustained DPS already carries the magazine tax. Ignores movement,
 * range, line-of-sight and shield damage-reduction — a first-order comparator,
 * not a duel outcome. Infinity if 0 DPS.
 */
export function timeToKill(attacker: FitMetrics, defender: FitMetrics): number {
  if (attacker.sustainedDps <= 0) return Infinity;
  return (defender.ehp + defender.shieldPool) / attacker.sustainedDps;
}

/** One sampled point in the engagement curve. */
export interface EngagementSample {
  t: number;
  /** Emptiest module tank, 0..1 of its own capacity (1 when the fit has none). */
  energy: number;
  /** Number of modules actively working this step. */
  activeCount: number;
}

export interface EngagementResult {
  samples: EngagementSample[];
  /** Fraction of module-time spent actively working (0..1) across the run. */
  uptime: number;
  /** How many times a module ran its own tank dry during the run. */
  flameouts: number;
}

interface SimModule {
  cfg: ModuleConfig;
  energy: number;
  energyCapacity: number;
  working: boolean;
}

/**
 * Headless 60 s engagement simulation for a fit — an arithmetic port of
 * {@link EnergySystem}'s PER-MODULE model (2026-08-07): each tank drains while
 * its module works and refills while it rests, and a module whose tank empties
 * flames out until it has charge again. Movement and combat resolution are
 * omitted on purpose. Invariant: energy is clamped to `[0, capacity]` every
 * step.
 *
 * Weapons no longer appear in this curve at all (heat deleted 2026-08-20): they
 * carry no tank and are limited only by their own cycle time, so there is
 * nothing about them for a 60-second energy trace to show.
 */
export function simulateEngagement(
  ship: ShipConfig,
  configs: ConfigLookup,
  moduleIds: readonly (string | null)[],
  opts: { duration?: number; dt?: number } = {},
): EngagementResult {
  const duration = opts.duration ?? 60;
  const dt = opts.dt ?? 0.1;
  const core = resolveFitCore(ship, configs, moduleIds);

  const sim: SimModule[] = moduleIds
    .map((id) => (id ? configs.get<ModuleConfig>("module", id) : undefined))
    .filter((m): m is ModuleConfig => !!m && m.energy !== undefined)
    .map((cfg) => ({
      cfg,
      energy: (cfg.energy?.capacity ?? 0) * core.energyStore.multiplier,
      energyCapacity: (cfg.energy?.capacity ?? 0) * core.energyStore.multiplier,
      working: true,
    }));

  const samples: EngagementSample[] = [];
  let workingTicks = 0;
  let flameouts = 0;
  const steps = Math.max(1, Math.round(duration / dt));

  for (let i = 0; i <= steps; i++) {
    const t = i * dt;
    for (const m of sim) {
      // A module with no tank at all is always fed; one with a tank works only
      // while it has charge (the sim's flameout, in arithmetic form).
      const wasWorking = m.working;
      m.working = m.energyCapacity <= 0 || m.energy > 0;
      if (wasWorking && !m.working) flameouts++;

      // Energy: drain while working, refill while resting.
      if (m.energyCapacity > 0) {
        if (m.working) {
          m.energy = Math.max(0, m.energy - (m.cfg.energy?.drawPerSec ?? 0) * core.efficiency.energyDraw * dt);
        } else {
          m.energy = Math.min(
            m.energyCapacity,
            m.energy + (m.cfg.energy?.rechargePerSec ?? 0) * core.recharge.multiplier * dt,
          );
        }
      }

    }

    let energy = 1;
    let activeCount = 0;
    for (const m of sim) {
      if (m.energyCapacity > 0) energy = Math.min(energy, m.energy / m.energyCapacity);
      if (m.working) activeCount++;
    }
    workingTicks += activeCount;
    samples.push({ t, energy, activeCount });
  }

  const totalPossible = sim.length * (steps + 1);
  return {
    samples,
    uptime: totalPossible > 0 ? workingTicks / totalPossible : 0,
    flameouts,
  };
}

/** The default fit for a ship, padded/truncated to its hardpoint count. */
export function defaultFitOf(ship: ShipConfig): (string | null)[] {
  const count = hardpointsOf(ship).length;
  const fit: (string | null)[] = [];
  for (let i = 0; i < count; i++) fit.push(ship.defaultFitting[i] ?? null);
  return fit;
}

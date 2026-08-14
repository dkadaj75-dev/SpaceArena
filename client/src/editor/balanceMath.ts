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
 * sustained energy/heat/DPS envelope of a fit, which is a closed-form function of
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
  /** Resolved hull-wide cooling multiplier (heatsink + passives). */
  coolingMult: number;
  /** Σ weapon `damage / cycleTime` over fitted weapons — the trigger-down rate. */
  burstDps: number;
  /**
   * Σ weapon DPS across a whole heat cycle: nominal × the rack's duty, which
   * under the 2026-08-07 model is exactly `cooling / generation`. This is the
   * number a fit actually delivers on a held trigger.
   */
  sustainedDps: number;
  /** Seconds of held trigger before the FIRST rack locks out, or Infinity if heat-stable. */
  timeToOverheat: number;
  /** Longest full cold-down of any fitted rack (capacity / effective cooling). */
  recoverSec: number;
  /** Shield reserve this fit contributes (Σ shield-module tank capacity). */
  shieldPool: number;
}

const ACTIVE_FAMILIES = new Set(["laser", "kinetic", "missile", "boost", "shield"]);

/** Resolve a fit's core stats via the shared 4.1 resolver (level-0 upgrades). */
export function resolveFitCore(ship: ShipConfig, configs: ConfigLookup, moduleIds: readonly (string | null)[]): ShipCore {
  return resolveShipStats(ship, configs as ConfigService, { fittedModuleIds: moduleIds });
}

/** Heat a module generates per second of work, transformer tax included. */
function heatGenPerSec(m: ModuleConfig, heatGenMult: number): number {
  if (!m.heat) return 0;
  const perShot = m.fire && m.fire.mode !== "continuous"
    ? m.heat.perShot * sustainedShotsPerSec(m)
    : 0;
  return (m.heat.perSecondActive + perShot) * heatGenMult;
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
  let timeToOverheat = Infinity;
  let recoverSec = 0;

  for (const m of mods) {
    const tank = (m.energy?.capacity ?? 0) * core.energyStore.multiplier;
    energyReserve += tank;
    if (m.mitigation) shieldPool += tank;
    if (m.fire) {
      const nominal = m.fire.mode === "continuous" ? m.fire.damage : m.fire.damage / m.fire.cycleTime;
      const triggerHeld = m.fire.mode === "continuous" ? nominal : m.fire.damage * sustainedShotsPerSec(m);
      burstDps += nominal;
      const gen = heatGenPerSec(m, core.efficiency.heatGen);
      const cooling = (m.heat?.coolingPerSec ?? 0) * core.cooling.multiplier;
      // Duty cycle of a rack that trips and re-arms forever is cooling/generation
      // — burn and lockout both scale with the same capacity, so it cancels out.
      sustainedDps += gen > cooling ? triggerHeld * (cooling / gen) : triggerHeld;
    }
    if (!m.heat) continue;
    const capacity = m.heat.capacity * core.heatStore.multiplier;
    const cooling = m.heat.coolingPerSec * core.cooling.multiplier;
    if (cooling > 0) recoverSec = Math.max(recoverSec, capacity / cooling);
    const net = heatGenPerSec(m, core.efficiency.heatGen) - cooling;
    if (net > 0 && ACTIVE_FAMILIES.has(m.family)) {
      const perShot = (m.heat.perShot || 0) * core.efficiency.heatGen;
      timeToOverheat = Math.min(timeToOverheat, Math.max(0, capacity - perShot) / net);
    }
  }

  const avgResist = (core.resists.kinetic + core.resists.energy) / 2;
  return {
    hull: core.hullMax,
    ehp: core.hullMax * (1 + avgResist),
    speed: core.engine.nominalSpeed,
    energyReserve,
    rechargeMult: core.recharge.multiplier,
    coolingMult: core.cooling.multiplier,
    burstDps,
    sustainedDps,
    timeToOverheat,
    recoverSec,
    shieldPool,
  };
}

/**
 * Time-to-kill of `attacker` firing on `defender`, in seconds.
 * Simplification: `(defenderEHP + defenderShieldPool) / attackerSustainedDps`,
 * where sustained DPS already carries the rack duty cycle. Ignores movement,
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
  /** Hottest rack, 0..1 of its own capacity. */
  heat: number;
  /** Emptiest module tank, 0..1 of its own capacity (1 when the fit has none). */
  energy: number;
  /** Number of modules actively working this step. */
  activeCount: number;
}

export interface EngagementResult {
  samples: EngagementSample[];
  /** Fraction of module-time spent actively working (0..1) across the run. */
  uptime: number;
  /** How many times a rack locked itself out during the run. */
  lockouts: number;
}

interface SimModule {
  cfg: ModuleConfig;
  heat: number;
  heatCapacity: number;
  cooling: number;
  gen: number;
  energy: number;
  energyCapacity: number;
  lockedOut: boolean;
  working: boolean;
}

/**
 * Headless 60 s engagement simulation for a fit — an arithmetic port of
 * {@link EnergySystem}'s PER-MODULE model (2026-08-07): each rack heats, cools,
 * locks out at its own capacity and re-arms under `rearmBelow`; each tank drains
 * while its module works and refills while it rests. Movement and combat
 * resolution are omitted on purpose. Invariants: heat never goes negative and
 * energy is clamped to `[0, capacity]` every step.
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
    .filter((m): m is ModuleConfig => !!m && ACTIVE_FAMILIES.has(m.family))
    .map((cfg) => ({
      cfg,
      heat: 0,
      heatCapacity: (cfg.heat?.capacity ?? 0) * core.heatStore.multiplier,
      cooling: (cfg.heat?.coolingPerSec ?? 0) * core.cooling.multiplier,
      gen: heatGenPerSec(cfg, core.efficiency.heatGen),
      energy: (cfg.energy?.capacity ?? 0) * core.energyStore.multiplier,
      energyCapacity: (cfg.energy?.capacity ?? 0) * core.energyStore.multiplier,
      lockedOut: false,
      working: true,
    }));

  const samples: EngagementSample[] = [];
  let workingTicks = 0;
  let lockouts = 0;
  const steps = Math.max(1, Math.round(duration / dt));

  for (let i = 0; i <= steps; i++) {
    const t = i * dt;
    for (const m of sim) {
      // A module with no tank at all is always fed; one with a tank works only
      // while it has charge (the sim's flameout, in arithmetic form).
      m.working = !m.lockedOut && (m.energyCapacity <= 0 || m.energy > 0);

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

      // Heat: generate while working, cool always, trip and re-arm on the pair.
      if (m.heatCapacity > 0) {
        if (m.working) m.heat += m.gen * dt;
        m.heat = Math.max(0, m.heat - m.cooling * dt);
        if (m.lockedOut) {
          if (m.heat <= m.heatCapacity * (m.cfg.heat?.rearmBelow ?? 0.25)) m.lockedOut = false;
        } else if (m.heat >= m.heatCapacity) {
          m.lockedOut = true;
          lockouts++;
        }
      }
    }

    let heat = 0;
    let energy = 1;
    let activeCount = 0;
    for (const m of sim) {
      if (m.heatCapacity > 0) heat = Math.max(heat, m.heat / m.heatCapacity);
      if (m.energyCapacity > 0) energy = Math.min(energy, m.energy / m.energyCapacity);
      if (m.working) activeCount++;
    }
    workingTicks += activeCount;
    samples.push({ t, heat, energy, activeCount });
  }

  const totalPossible = sim.length * (steps + 1);
  return {
    samples,
    uptime: totalPossible > 0 ? workingTicks / totalPossible : 0,
    lockouts,
  };
}

/** The default fit for a ship, padded/truncated to its hardpoint count. */
export function defaultFitOf(ship: ShipConfig): (string | null)[] {
  const count = hardpointsOf(ship).length;
  const fit: (string | null)[] = [];
  for (let i = 0; i < count; i++) fit.push(ship.defaultFitting[i] ?? null);
  return fit;
}

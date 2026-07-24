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
  capacitor: number;
  regen: number;
  /** Σ `energy.drawIdle` over all fitted modules (baseline passive draw). */
  idleDraw: number;
  /** Σ `energy.drawActive` over modules assumed active (weapons + boost/shield). */
  activeDraw: number;
  /** Σ weapon `damage / cycleTime` over fitted weapons (sustained, no LoS/travel). */
  sustainedDps: number;
  /** Σ active-heat rate (`heat.perSecondActive`, or `boost.heatPerSec`). */
  heatPerSec: number;
  /** Seconds until the first module overheats under sustained fire, or Infinity if heat-stable. */
  timeToOverheat: number;
  /** Shield absorb pool this fit contributes (Σ `mitigation.absorbPerSecond`). */
  shieldPool: number;
}

const ACTIVE_FAMILIES = new Set(["laser", "kinetic", "missile", "boost", "shield"]);

/** Resolve a fit's core stats via the shared 4.1 resolver (level-0 upgrades). */
export function resolveFitCore(ship: ShipConfig, configs: ConfigLookup, moduleIds: readonly (string | null)[]): ShipCore {
  return resolveShipStats(ship, configs as ConfigService, { fittedModuleIds: moduleIds });
}

/** Compute the balance metrics for a ship with a given ordered module loadout. */
export function fitMetrics(ship: ShipConfig, configs: ConfigLookup, moduleIds: readonly (string | null)[]): FitMetrics {
  const core = resolveFitCore(ship, configs, moduleIds);
  const mods = moduleIds
    .map((id) => (id ? configs.get<ModuleConfig>("module", id) : undefined))
    .filter((m): m is ModuleConfig => !!m);

  let idleDraw = 0;
  let activeDraw = 0;
  let sustainedDps = 0;
  let heatPerSec = 0;
  let shieldPool = 0;
  let timeToOverheat = Infinity;
  const activeMods = mods.filter((m) => ACTIVE_FAMILIES.has(m.family));
  const dissipationShare = activeMods.length > 0 ? core.heat.dissipation / activeMods.length : 0;

  for (const m of mods) {
    idleDraw += m.energy.drawIdle;
    if (ACTIVE_FAMILIES.has(m.family)) activeDraw += m.energy.drawActive;
    if (m.fire) sustainedDps += m.fire.damage / m.fire.cycleTime;
    if (m.mitigation?.absorbPerSecond) shieldPool += m.mitigation.absorbPerSecond;
    const heatRate = m.boost ? m.boost.heatPerSec : ACTIVE_FAMILIES.has(m.family) ? m.heat.perSecondActive : 0;
    heatPerSec += heatRate;
    // Per-module time-to-overheat: threshold / net heat rate (gen minus its dissipation share).
    const net = heatRate - dissipationShare;
    if (net > 0) timeToOverheat = Math.min(timeToOverheat, m.heat.overheatThreshold / net);
  }

  const avgResist = (core.resists.kinetic + core.resists.energy) / 2;
  return {
    hull: core.hullMax,
    ehp: core.hullMax * (1 + avgResist),
    speed: core.engine.nominalSpeed,
    capacitor: core.capacitor.max,
    regen: core.capacitor.regen,
    idleDraw,
    activeDraw,
    sustainedDps,
    heatPerSec,
    timeToOverheat,
    shieldPool,
  };
}

/**
 * Time-to-kill of `attacker` firing on `defender`, in seconds.
 * Simplification: `(defenderEHP + defenderShieldPool) / attackerSustainedDps`.
 * Ignores movement, range, line-of-sight, shield damage-reduction and heat
 * downtime — a first-order comparator, not a duel outcome. Infinity if 0 DPS.
 */
export function timeToKill(attacker: FitMetrics, defender: FitMetrics): number {
  if (attacker.sustainedDps <= 0) return Infinity;
  return (defender.ehp + defender.shieldPool) / attacker.sustainedDps;
}

/** One sampled point in the engagement curve. */
export interface EngagementSample {
  t: number;
  energy: number;
  heat: number;
  /** Number of modules actively working this step. */
  activeCount: number;
}

export interface EngagementResult {
  samples: EngagementSample[];
  capacitorMax: number;
  heatCapacity: number;
  /** Fraction of module-time spent actively working (0..1) across the run. */
  uptime: number;
  /** True if the capacitor ever hit 0 (brown-out). */
  brownedOut: boolean;
}

interface SimModule {
  cfg: ModuleConfig;
  heat: number;
  overheatTimer: number;
  /** Working = active and not overheated / browned-out. */
  working: boolean;
  heatRate: number;
}

/**
 * Headless 60 s engagement simulation for a fit — a faithful arithmetic port of
 * {@link EnergySystem}'s energy/heat model (regen, active/idle draw, per-module
 * overheat shutdown + cooldown, proportional dissipation, brown-out) WITHOUT the
 * ECS/world. Movement and combat resolution are omitted on purpose: the fit's
 * sustained energy/heat envelope does not depend on them. Invariant: energy is
 * clamped to `[0, capacitorMax]` every step, so it is never negative.
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
      overheatTimer: 0,
      working: true,
      heatRate: cfg.boost ? cfg.boost.heatPerSec : cfg.heat.perSecondActive,
    }));

  let energy = core.capacitor.max;
  const samples: EngagementSample[] = [];
  let workingTicks = 0;
  let brownedOut = false;
  const steps = Math.max(1, Math.round(duration / dt));

  for (let i = 0; i <= steps; i++) {
    const t = i * dt;

    // Overheat cooldown countdown (module returns to working when it expires).
    for (const m of sim) {
      if (m.overheatTimer > 0) {
        m.overheatTimer = Math.max(0, m.overheatTimer - dt);
        if (m.overheatTimer === 0) {
          m.heat = 0;
          m.working = true;
        }
      }
    }

    // Energy: regen first, then drain per working (drawActive) / non-working idle (drawIdle).
    energy = Math.min(core.capacitor.max, energy + core.capacitor.regen * dt);
    let drain = 0;
    for (const m of sim) drain += (m.working ? m.cfg.energy.drawActive : m.cfg.energy.drawIdle) * dt;
    energy -= drain;
    if (energy < 0) {
      energy = 0;
      brownedOut = true;
      // Brown-out: force the last still-working module offline this step.
      for (let k = sim.length - 1; k >= 0; k--) {
        if (sim[k]!.working && sim[k]!.overheatTimer === 0) {
          sim[k]!.working = false;
          break;
        }
      }
    } else {
      // Recover browned-out modules once the capacitor is comfortably full.
      if (energy > core.capacitor.max * 0.5) {
        for (const m of sim) if (!m.working && m.overheatTimer === 0) m.working = true;
      }
    }

    // Heat: generation for working modules, then overheat detection.
    for (const m of sim) if (m.working) m.heat += m.heatRate * dt;
    for (const m of sim) {
      if (m.working && m.heat >= m.cfg.heat.overheatThreshold) {
        m.working = false;
        m.overheatTimer = m.cfg.heat.overheatCooldown;
      }
    }
    // Heat: proportional dissipation across still-hot working modules.
    let hotTotal = 0;
    for (const m of sim) if (m.working && m.heat > 0) hotTotal += m.heat;
    if (hotTotal > 0) {
      const budget = core.heat.dissipation * dt;
      for (const m of sim) {
        if (!m.working || m.heat <= 0) continue;
        m.heat = Math.max(0, m.heat - budget * (m.heat / hotTotal));
      }
    }

    let heat = 0;
    let activeCount = 0;
    for (const m of sim) {
      heat += m.heat;
      if (m.working) activeCount++;
    }
    workingTicks += activeCount;
    samples.push({ t, energy, heat, activeCount });
  }

  const totalPossible = sim.length * (steps + 1);
  return {
    samples,
    capacitorMax: core.capacitor.max,
    heatCapacity: core.heat.capacity,
    uptime: totalPossible > 0 ? workingTicks / totalPossible : 0,
    brownedOut,
  };
}

/** The default fit for a ship, padded/truncated to its hardpoint count. */
export function defaultFitOf(ship: ShipConfig): (string | null)[] {
  const count = hardpointsOf(ship).length;
  const fit: (string | null)[] = [];
  for (let i = 0; i < count; i++) fit.push(ship.defaultFitting[i] ?? null);
  return fit;
}

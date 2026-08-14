import {
  fittingPowerDraw,
  resolveShipStats,
  type ConfigService,
  type ModuleConfig,
  type ShipConfig,
  type UpgradeLevels,
} from "@space-arena/shared";

/**
 * Hangar live stat panel (ROADMAP §9 4.5). Wraps the 4.1 `resolveShipStats`
 * resolver with the fit-level projections the Hangar UI needs that the
 * resolver itself doesn't compute: idle energy budget, sustained-fire heat
 * trend, rough DPS/EHP. All "sustained"/"worst case" figures assume every
 * fitted module is simultaneously deployed and firing — a deliberately
 * pessimistic preview, not a sim replay. Since the 2026-08-07 heat/energy
 * overhaul every number here is a per-MODULE store rolled up over the fit:
 * there is no ship capacitor and no ship heat pool to report.
 */
export interface HangarStatPanel {
  hullMax: number;
  nominalSpeed: number;
  /** Σ of every fitted module's own energy tank (boost bottle, shield reserve). */
  energyReserve: number;
  /** Resolved hull-wide recharge multiplier — how fast those tanks refill. */
  rechargeMult: number;
  /** Resolved hull-wide cooling multiplier — how fast every rack sheds heat. */
  coolingMult: number;
  /** Shortest held-trigger burn of any fitted weapon, in seconds (Infinity = heat-stable). */
  burnSec: number;
  /** Longest full cold-down of any fitted rack, in seconds. */
  recoverSec: number;
  /** Rough damage/sec across every fitted weapon module (fire block present), ignoring range/LoS/target availability. */
  dps: number;
  /** Same, but multiplied by each rack's duty cycle — what a held trigger really delivers. */
  sustainedDps: number;
  /** hullMax stretched by the ship's average kinetic/energy resist — a rough "effective HP", not sim-accurate. */
  ehpApprox: number;
  /** Power-rail current the hull can deliver (2026-07-31), mostly from the transformer. */
  powerCapacity: number;
  /** Rail current the fitted hardpoints would hold if every one of them were online at once. */
  powerDrawTotal: number;
  /**
   * Rail current the fit draws with only its ALWAYS-ON modules up — weapons,
   * which spawn online. The deployables (shields, and anything else the pilot
   * raises) are the difference between this and {@link powerDrawTotal}, which
   * is the pair of numbers the outfitting screen shows as two bars.
   */
  powerDrawRetracted: number;
  /**
   * True when the fit asks for more rail than the hull has. NOT an error — the
   * fitting is legal and saveable, it simply cannot run whole, so the Hangar
   * warns and the sim shuts one module down when another comes up.
   */
  powerOverSubscribed: boolean;
}

export interface ComputeStatPanelOptions {
  upgradeLevels?: UpgradeLevels;
  fittedModuleIds: readonly (string | null | undefined)[];
}

function sustainedShotsPerSec(mod: ModuleConfig): number {
  if (!mod.fire || mod.fire.mode === "continuous") return 0;
  const clip = mod.fire.clip;
  return clip
    ? clip.size / ((clip.size - 1) * mod.fire.cycleTime + clip.reloadSec)
    : 1 / mod.fire.cycleTime;
}

export function computeStatPanel(ship: ShipConfig, configs: ConfigService, opts: ComputeStatPanelOptions): HangarStatPanel {
  const core = resolveShipStats(ship, configs, {
    upgradeLevels: opts.upgradeLevels,
    fittedModuleIds: opts.fittedModuleIds,
  });

  let energyReserve = 0;
  let dps = 0;
  let sustainedDps = 0;
  let burnSec = Infinity;
  let recoverSec = 0;
  let powerDrawRetracted = 0;
  for (const moduleId of opts.fittedModuleIds) {
    if (!moduleId) continue;
    const mod = configs.get<ModuleConfig>("module", moduleId);
    if (!mod) continue;
    // Weapons come up online at spawn, so their rail draw is what the hull
    // carries before the pilot raises anything.
    if (mod.fire) powerDrawRetracted += mod.power?.draw ?? 0;
    energyReserve += (mod.energy?.capacity ?? 0) * core.energyStore.multiplier;
    if (mod.heat) {
      const capacity = mod.heat.capacity * core.heatStore.multiplier;
      const cooling = mod.heat.coolingPerSec * core.cooling.multiplier;
      const perShot = mod.fire && mod.fire.mode !== "continuous" ? mod.heat.perShot * sustainedShotsPerSec(mod) : 0;
      const gen = (mod.heat.perSecondActive + perShot) * core.efficiency.heatGen;
      if (cooling > 0) recoverSec = Math.max(recoverSec, capacity / cooling);
      if (gen > cooling) {
        burnSec = Math.min(burnSec, Math.max(0, capacity - mod.heat.perShot * core.efficiency.heatGen) / (gen - cooling));
      }
      if (mod.fire) {
        const nominal = mod.fire.mode === "continuous" ? mod.fire.damage : mod.fire.damage * sustainedShotsPerSec(mod);
        sustainedDps += gen > cooling ? nominal * (cooling / gen) : nominal;
      }
    }
    if (mod.fire) dps += mod.fire.mode === "continuous" ? mod.fire.damage : mod.fire.damage / mod.fire.cycleTime;
  }

  const powerDrawTotal = fittingPowerDraw(configs, opts.fittedModuleIds);

  const avgResist = (ship.core.hull.resists.kinetic + ship.core.hull.resists.energy) / 2;
  const ehpApprox = core.hullMax / Math.max(0.05, 1 - avgResist);

  return {
    hullMax: core.hullMax,
    nominalSpeed: core.engine.nominalSpeed,
    energyReserve,
    rechargeMult: core.recharge.multiplier,
    coolingMult: core.cooling.multiplier,
    burnSec,
    recoverSec,
    dps,
    sustainedDps,
    ehpApprox,
    powerCapacity: core.power.capacity,
    powerDrawTotal,
    powerDrawRetracted,
    powerOverSubscribed: powerDrawTotal > core.power.capacity,
  };
}

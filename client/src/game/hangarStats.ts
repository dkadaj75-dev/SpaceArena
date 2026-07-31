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
 * fitted module is simultaneously deployed (idle draw) or firing (active
 * heat/DPS) — a deliberately pessimistic preview, not a sim replay.
 */
export interface HangarStatPanel {
  hullMax: number;
  nominalSpeed: number;
  capacitorMax: number;
  capacitorRegen: number;
  heatCapacity: number;
  heatDissipation: number;
  /** Sum of every fitted module's idle energy draw (all hardpoints deployed, none firing). */
  idleDrawTotal: number;
  /** `capacitorRegen - idleDrawTotal`; negative means idle draw alone drains the capacitor. */
  energyBudget: number;
  /** Sum of every fitted module's active heat rate minus ship dissipation; positive = heats up under sustained fire. */
  heatNetPerSec: number;
  /** Rough damage/sec across every fitted weapon module (fire block present), ignoring range/LoS/target availability. */
  dps: number;
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

export function computeStatPanel(ship: ShipConfig, configs: ConfigService, opts: ComputeStatPanelOptions): HangarStatPanel {
  const core = resolveShipStats(ship, configs, {
    upgradeLevels: opts.upgradeLevels,
    fittedModuleIds: opts.fittedModuleIds,
  });

  let idleDrawTotal = 0;
  let heatActiveTotal = 0;
  let dps = 0;
  let powerDrawRetracted = 0;
  for (const moduleId of opts.fittedModuleIds) {
    if (!moduleId) continue;
    const mod = configs.get<ModuleConfig>("module", moduleId);
    if (!mod) continue;
    // Weapons come up online at spawn, so their rail draw is what the hull
    // carries before the pilot raises anything.
    if (mod.fire) powerDrawRetracted += mod.power?.draw ?? 0;
    idleDrawTotal += mod.energy.drawIdle;
    heatActiveTotal += mod.boost ? mod.boost.heatPerSec : mod.heat.perSecondActive;
    if (mod.fire) dps += mod.fire.damage / mod.fire.cycleTime;
  }

  const powerDrawTotal = fittingPowerDraw(configs, opts.fittedModuleIds);

  const avgResist = (ship.core.hull.resists.kinetic + ship.core.hull.resists.energy) / 2;
  const ehpApprox = core.hullMax / Math.max(0.05, 1 - avgResist);

  return {
    hullMax: core.hullMax,
    nominalSpeed: core.engine.nominalSpeed,
    capacitorMax: core.capacitor.max,
    capacitorRegen: core.capacitor.regen,
    heatCapacity: core.heat.capacity,
    heatDissipation: core.heat.dissipation,
    idleDrawTotal,
    energyBudget: core.capacitor.regen - idleDrawTotal,
    heatNetPerSec: heatActiveTotal - core.heat.dissipation,
    dps,
    ehpApprox,
    powerCapacity: core.power.capacity,
    powerDrawTotal,
    powerDrawRetracted,
    powerOverSubscribed: powerDrawTotal > core.power.capacity,
  };
}

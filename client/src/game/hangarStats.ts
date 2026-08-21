import {
  fittingPowerDraw,
  moduleTankCapacity,
  rateOfFireFor,
  resolveShipStats,
  type ConfigService,
  type ModuleConfig,
  type ShipCore,
  type ShipConfig,
  type UpgradeLevels,
} from "@space-arena/shared";

/**
 * Hangar live stat panel (ROADMAP §9 4.5). Wraps the 4.1 `resolveShipStats`
 * resolver with the fit-level projections the Hangar UI needs that the
 * resolver itself doesn't compute: idle energy budget, rough DPS/EHP. All
 * "sustained"/"worst case" figures assume every fitted module is simultaneously
 * deployed and firing — a deliberately pessimistic preview, not a sim replay.
 * Since the 2026-08-07 energy overhaul every number here is a per-MODULE store
 * rolled up over the fit: there is no ship capacitor.
 */
export interface HangarStatPanel {
  hullMax: number;
  nominalSpeed: number;
  /** Σ of every fitted module's own energy tank (boost bottle, shield reserve). */
  energyReserve: number;
  /** Resolved hull-wide recharge multiplier — how fast those tanks refill. */
  rechargeMult: number;
  /** Rough damage/sec across every fitted weapon module (fire block present), ignoring range/LoS/target availability. */
  dps: number;
  /**
   * Same, but paying each weapon's clip reload — what a held trigger really
   * delivers. Equal to {@link dps} for a weapon with no authored clip, since
   * cycle time is a weapon's only limiter (heat deleted 2026-08-20).
   */
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

/**
 * Shots per second including the clip reload, on THIS hull — the hull's
 * `combat.rateOfFire` shortens the cycle between shots exactly as it does in
 * the sim, while the authored `reloadSec` is untouched (rate of fire is a
 * cadence knob, not a reload knob), so a clipped weapon gains less from it than
 * an unclipped one. That asymmetry is real in the sim too.
 */
function sustainedShotsPerSec(mod: ModuleConfig, core: ShipCore): number {
  if (!mod.fire || mod.fire.mode === "continuous") return 0;
  const cycle = mod.fire.cycleTime / rateOfFireFor(core, mod.fire.damageType);
  const clip = mod.fire.clip;
  return clip ? clip.size / ((clip.size - 1) * cycle + clip.reloadSec) : 1 / cycle;
}

/**
 * Damage per shot this hull deals with `mod`, after its outgoing role profile.
 * A `hybrid` warhead is split the way the damage pipeline splits it — half its
 * damage carries the kinetic multiplier, half the energy one (the shipped
 * 50/50 mix) — so the previewed number matches what the sim will deal.
 */
function shotDamage(mod: ModuleConfig, core: ShipCore): number {
  const fire = mod.fire;
  if (!fire) return 0;
  const out = core.combat.damageOutput;
  if (fire.damageType === "kinetic") return fire.damage * out.kinetic;
  if (fire.damageType === "energy") return fire.damage * out.energy;
  return fire.damage * (out.kinetic + out.energy) / 2;
}

export function computeStatPanel(ship: ShipConfig, configs: ConfigService, opts: ComputeStatPanelOptions): HangarStatPanel {
  const core = resolveShipStats(ship, configs, {
    upgradeLevels: opts.upgradeLevels,
    fittedModuleIds: opts.fittedModuleIds,
  });

  let energyReserve = 0;
  let dps = 0;
  let sustainedDps = 0;
  let powerDrawRetracted = 0;
  for (const moduleId of opts.fittedModuleIds) {
    if (!moduleId) continue;
    const mod = configs.get<ModuleConfig>("module", moduleId);
    if (!mod) continue;
    // Weapons come up online at spawn, so their rail draw is what the hull
    // carries before the pilot raises anything.
    if (mod.fire) powerDrawRetracted += mod.power?.draw ?? 0;
    energyReserve += moduleTankCapacity(mod, core);
    if (mod.fire) {
      // A channel's rate-of-fire knob buys DPS rather than cadence (see
      // `channelDamageScale`), so both of its multipliers land on the same number.
      const perShot = shotDamage(mod, core);
      dps += mod.fire.mode === "continuous"
        ? perShot * rateOfFireFor(core, mod.fire.damageType)
        : perShot * (rateOfFireFor(core, mod.fire.damageType) / mod.fire.cycleTime);
      sustainedDps += mod.fire.mode === "continuous"
        ? perShot * rateOfFireFor(core, mod.fire.damageType)
        : perShot * sustainedShotsPerSec(mod, core);
    }
  }

  const powerDrawTotal = fittingPowerDraw(configs, opts.fittedModuleIds);

  const avgResist = (ship.core.hull.resists.kinetic + ship.core.hull.resists.energy) / 2;
  const ehpApprox = core.hullMax / Math.max(0.05, 1 - avgResist);

  return {
    hullMax: core.hullMax,
    nominalSpeed: core.engine.nominalSpeed,
    energyReserve,
    rechargeMult: core.recharge.multiplier,
    dps,
    sustainedDps,
    ehpApprox,
    powerCapacity: core.power.capacity,
    powerDrawTotal,
    powerDrawRetracted,
    powerOverSubscribed: powerDrawTotal > core.power.capacity,
  };
}

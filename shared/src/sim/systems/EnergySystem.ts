import type { ModuleConfig } from "../../schemas/index.js";
import type { EntityId, ModuleRuntime, ShipCore } from "../components.js";
import { railFits, transition } from "./ModuleSystem.js";
import { heatSystemEnabled } from "../tuningDefaults.js";
import type { World } from "../World.js";

/**
 * EnergySystem (heat/energy overhaul, 2026-08-07) — the per-module heat and
 * energy stores, run AFTER combat/nav so the worked-this-tick flags are set.
 *
 * There is no ship heat pool and no shared capacitor any more. Every module owns
 * what it spends:
 *
 * **HEAT** (weapons, and anything else authoring a `heat` block)
 *   - a working module adds `heat.perSecondActive × efficiency.heatGen × dt`
 *     (discrete shots already added `heat.perShot` in CombatSystem);
 *   - EVERY module with heat sheds `heat.coolingPerSec × cooling.multiplier × dt`,
 *     lockout included — cooling during the lockout is what ends it;
 *   - heat reaching `heatCapacity` forces the module `overheated`;
 *   - the lockout clears the moment heat falls back below
 *     `heatCapacity × heat.rearmBelow`. No timer, no self-damage, no hull burn:
 *     the punishment for cooking a rack is the seconds you do not have it.
 *
 * **ENERGY** (boost tanks, shield reserves, active utilities)
 *   - a module that WORKED drains `energy.drawPerSec × efficiency.energyDraw × dt`
 *     and, at zero, is cut offline (a flameout — the tank is empty, not the ship);
 *   - a module that did not work refills at
 *     `energy.rechargePerSec × recharge.multiplier × dt` up to its capacity.
 *
 * The two ship-wide multipliers come from the fitted heatsink and generator; the
 * transformer's `efficiency` pair still taxes generation and draw per module.
 * Nothing here damages a hull — a loadout can no longer kill its own pilot.
 */
export function energySystem(world: World, dt: number): void {
  for (const id of world.shipIds()) {
    const core = world.shipCores.get(id)!;
    const mods = world.modules.get(id);
    if (!mods) continue;

    for (const m of mods.modules) {
      const cfg = world.configs.get<ModuleConfig>("module", m.moduleId);
      if (!cfg) continue;
      stepEnergy(world, id, core, m, cfg, dt);
      stepHeat(world, id, core, m, cfg, mods.modules, dt);
    }
  }
}

/** One module's energy tank: drain while working, refill while resting. */
function stepEnergy(
  world: World,
  id: EntityId,
  core: ShipCore,
  m: ModuleRuntime,
  cfg: ModuleConfig,
  dt: number,
): void {
  if (m.energyCapacity <= 0 || !cfg.energy) return;

  // A raised shield pays upkeep for being raised, whether or not it soaked a
  // hit this tick — holding it up is the work.
  const working = m.workedThisTick || (m.absorbs && m.state === "active");
  if (!working) {
    m.energy = Math.min(m.energyCapacity, m.energy + cfg.energy.rechargePerSec * core.recharge.multiplier * dt);
    return;
  }

  m.energy -= cfg.energy.drawPerSec * core.efficiency.energyDraw * dt;
  if (m.energy > 0) return;

  // Flameout: the tank is dry, so the module drops offline (instantly — the
  // charge is gone, there is nothing left to run a retract animation on). It
  // refills from there like any resting module and the pilot brings it back.
  m.energy = 0;
  m.workedThisTick = false;
  if (m.state !== "retracted" && m.state !== "overheated") {
    transition(world, id, m, "retracted", cfg.onDeactivate);
  }
}

/** One module's heat store: generate, cool, then trip or re-arm. */
function stepHeat(
  world: World,
  id: EntityId,
  core: ShipCore,
  m: ModuleRuntime,
  cfg: ModuleConfig,
  siblings: readonly ModuleRuntime[],
  dt: number,
): void {
  // The feature stays fully authored and replicated while switched off, but it
  // has no gameplay effects: no generation, cooling, trip, or re-arm.
  if (!heatSystemEnabled(world.tuning)) return;
  if (m.heatCapacity <= 0 || !cfg.heat) return;

  if (m.workedThisTick) {
    m.heat += cfg.heat.perSecondActive * core.efficiency.heatGen * dt;
  }
  // Cooling never stops — a locked-out rack is cooling, which is the only thing
  // that will ever bring it back.
  m.heat = Math.max(0, m.heat - cfg.heat.coolingPerSec * core.cooling.multiplier * dt);

  if (m.state === "overheated") {
    if (m.heat <= m.heatCapacity * cfg.heat.rearmBelow) {
      m.stateTimer = 0;
      // Weapons come straight back ONLINE (they are always-on: spawn.ts); a
      // support module returns retracted for the pilot to raise deliberately.
      // The rail still has the last word — see railFits.
      const online = cfg.fire !== undefined && railFits(world, id, m, siblings);
      transition(world, id, m, online ? "active" : "retracted", online ? cfg.onActivate : undefined);
    }
    return;
  }
  if (m.state === "retracted") return;

  if (m.heat >= m.heatCapacity) {
    m.heat = m.heatCapacity;
    m.stateTimer = 0;
    m.channeling = false;
    transition(world, id, m, "overheated");
    world.emit({
      type: "overheated",
      entityId: id,
      hardpointIndex: m.hardpointIndex,
      moduleId: m.moduleId,
      actions: cfg.onOverheat,
    });
  }
}

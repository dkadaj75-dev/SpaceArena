import type { ModuleConfig } from "../../schemas/index.js";
import type { EntityId, ModuleRuntime, ShipCore } from "../components.js";
import { transition } from "./ModuleSystem.js";
import type { World } from "../World.js";

/**
 * EnergySystem — the per-module energy stores, run AFTER combat/nav so the
 * worked-this-tick flags are set.
 *
 * There is no shared capacitor: every module owns what it spends. Weapons own
 * nothing at all — a weapon's only limiter is its own cycle time.
 *
 * **ENERGY** (boost tanks, shield reserves, active utilities)
 *   - a module that WORKED drains `energy.drawPerSec × efficiency.energyDraw × dt`
 *     and, at zero, is cut offline (a flameout — the tank is empty, not the ship);
 *     a flamed-out SHIELD has collapsed and additionally starts its
 *     `mitigation.collapseCooldownSec` lockout on its own `cycleTimer`
 *     (ModuleSystem counts it down and refuses the toggle while it runs);
 *   - a module that did not work refills at
 *     `energy.rechargePerSec × recharge.multiplier × dt` up to its capacity,
 *     with a SHIELD additionally scaled by the hull's `combat.shieldEfficiency`.
 *
 * The ship-wide recharge multiplier comes from the fitted generator; the
 * transformer's `efficiency.energyDraw` taxes draw per module. Nothing here
 * damages a hull — a loadout cannot kill its own pilot.
 */
export function energySystem(world: World, dt: number): void {
  for (const id of world.shipIds()) {
    const core = world.shipCores.get(id)!;
    const mods = world.modules.get(id);
    if (!mods) continue;

    for (const m of mods.modules) {
      const cfg = world.configs.get<ModuleConfig>("module", m.moduleId);
      if (!cfg) continue;
      stepEnergy(world, id, core, m, cfg, mods.modules, dt);
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
  siblings: readonly ModuleRuntime[],
  dt: number,
): void {
  if (m.energyCapacity <= 0 || !cfg.energy) return;

  // A raised shield pays upkeep for being raised, whether or not it soaked a
  // hit this tick — holding it up is the work.
  const working = m.workedThisTick || (m.absorbs && m.state === "active");
  if (!working) {
    // A SHIELD refills at the hull's `combat.shieldEfficiency` on top of the
    // ship-wide recharge multiplier — the same number that sized its tank at
    // spawn, so an efficiency of 2 means twice the reserve AND twice the rate
    // it comes back at, which is the whole of "this hull is a shield tank".
    const shieldScale = m.absorbs ? core.combat.shieldEfficiency : 1;
    m.energy = Math.min(
      m.energyCapacity,
      m.energy + cfg.energy.rechargePerSec * core.recharge.multiplier * shieldScale * dt,
    );
    return;
  }

  m.energy -= cfg.energy.drawPerSec * core.efficiency.energyDraw * dt;
  if (m.energy > 0) return;

  // Flameout: the tank is dry, so the module drops offline (instantly — the
  // charge is gone, there is nothing left to run a retract animation on). It
  // refills from there like any resting module and the pilot brings it back.
  m.energy = 0;
  m.workedThisTick = false;
  if (m.state !== "retracted") {
    // A SHIELD flaming out is a COLLAPSE, and a collapse costs the authored
    // lockout before the bubble can be raised again. This is the single point
    // both collapse causes pass through — fire that drained the reserve
    // (damage.ts stage 2 spends the same tank) and upkeep that simply outran
    // the recharge — so neither needs its own rule, and neither can dodge it.
    // Only a collapse arms it: a pilot who drops the shield deliberately, or a
    // shield shed by the power rail, still comes straight back.
    if (cfg.mitigation) m.cycleTimer = cfg.mitigation.collapseCooldownSec;
    transition(world, id, m, "retracted", cfg.onDeactivate);
  }
}

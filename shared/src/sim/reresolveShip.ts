import type { ConfigService } from "../core/ConfigService.js";
import type { DamageType } from "../schemas/common.js";
import type { ModuleConfig, ShipConfig } from "../schemas/index.js";
import type { EntityId } from "./components.js";
import { effectiveCycleTime, resolveShipStats } from "./resolveStats.js";
import { moduleTankCapacity } from "./spawn.js";
import type { World } from "./World.js";

/**
 * LIVE STAT RE-RESOLVE — apply a hot ship-config edit to a hull that is already
 * flying, instead of making the designer die to see it.
 *
 * ## Why this exists
 *
 * `World.configs` is the SAME `ConfigService` the F10 editor writes to in an
 * offline match, so the sim can already SEE an edited ship config the instant
 * `configService.replace` lands — `World.tuning` exploits exactly that, and
 * re-reads its config by id on every access for precisely this reason.
 *
 * A {@link import("./components.js").ShipCore} cannot work that way: it is a
 * one-way PROJECTION of ship config × upgrade levels × fitted module passives,
 * computed once at spawn, and several of its outputs (module tank sizes) are
 * baked further into per-module runtime state. So a live edit to hull, engine,
 * sensors or the combat role profile stayed invisible until the ship respawned
 * — which, to a designer nudging a slider, reads as "nothing happens".
 *
 * This re-runs the resolution from the inputs recorded at spawn
 * ({@link World.shipLoadouts}) and carries the ship's live state across.
 *
 * ## What is preserved, and why
 *
 * Every changed quantity is carried across as a FRACTION rather than clamped.
 * Clamping is lossy in one direction only (raising a maximum leaves the ship
 * mysteriously under-filled; lowering it silently deletes reserve), whereas a
 * fraction reads as "the ship is as healthy as it was, on a new scale" in both:
 *
 *  - **hull** keeps `hull / hullMax`, so doubling a hull's base heals nobody to
 *    full and halving it kills nobody;
 *  - **module tanks** (shield reserve, boost bottle) keep `energy / capacity`,
 *    so raising `combat.shieldEfficiency` mid-fight gives a bigger bubble at
 *    the same *state of charge* rather than a free full recharge — and lowering
 *    it cannot leave a tank holding more than it can hold;
 *  - **weapon cycle timers** are RESCALED by the ratio of the new effective
 *    cycle to the old one, so a doubled rate of fire immediately halves the
 *    wait the pilot is already serving without ever handing out a free instant
 *    shot (the timer is scaled, never zeroed). A shield's collapse lockout and
 *    a countermeasure's jettison cooldown ride the same `cycleTimer` field and
 *    are deliberately left alone — they are not weapon cadence.
 *
 * An unchanged value round-trips EXACTLY: each carry-over short-circuits when
 * its scale did not move, so re-resolving an untouched config is a genuine
 * no-op rather than a float-precision nudge. That is what makes this safe to
 * call on every `config:changed`.
 *
 * Returns true if the ship was re-resolved (false = not a live ship, or the sim
 * holds no record of what it was spawned from).
 */
export function reresolveShipCore(world: World, configs: ConfigService, id: EntityId): boolean {
  const loadout = world.shipLoadouts.get(id);
  const core = world.shipCores.get(id);
  if (!loadout || !core) return false;
  const ship = configs.get<ShipConfig>("ship", loadout.shipId);
  if (!ship) return false;

  const next = resolveShipStats(ship, configs, {
    upgradeLevels: loadout.upgradeLevels,
    fittedModuleIds: loadout.fittingModuleIds,
  });

  // Capture everything the carry-overs below need BEFORE the core is
  // overwritten — the old rate of fire in particular lives nowhere else.
  const oldHull = core.hull;
  const oldHullMax = core.hullMax;
  const oldRateOfFire = { ...core.combat.rateOfFire };

  // Mutate in place rather than swapping the map entry: systems fetch the core
  // per tick, but a bot driver or a mid-tick local may be holding this object.
  Object.assign(core, next);
  // `resolveShipStats` hands back a FRESH hull at full — this ship is not new.
  core.hull = oldHullMax === next.hullMax ? oldHull : fractionAcross(oldHull, oldHullMax, next.hullMax);

  const mods = world.modules.get(id);
  if (!mods) return true;
  for (const m of mods.modules) {
    const cfg = configs.get<ModuleConfig>("module", m.moduleId);
    if (!cfg) continue;

    const oldCapacity = m.energyCapacity;
    const newCapacity = moduleTankCapacity(cfg, core);
    if (newCapacity !== oldCapacity) {
      m.energyCapacity = newCapacity;
      m.energy = fractionAcross(m.energy, oldCapacity, newCapacity);
    }

    // Weapon cadence only. A shield serving `collapseCooldownSec`, or a pod
    // serving its jettison cooldown, parks a DURATION on this same field that
    // has nothing to do with rate of fire.
    if (!cfg.fire || cfg.mitigation || m.cycleTimer <= 0) continue;
    const type: DamageType = cfg.fire.damageType;
    const oldCycle = cfg.fire.cycleTime / rateOfFireIn(oldRateOfFire, type);
    const newCycle = effectiveCycleTime(core, cfg.fire.cycleTime, type);
    if (newCycle === oldCycle || oldCycle <= 0) continue;
    // Scaled, never zeroed: shortening the cycle must not become a free shot,
    // and the result can never exceed a full fresh cycle either.
    m.cycleTimer = Math.min(newCycle, m.cycleTimer * (newCycle / oldCycle));
  }
  return true;
}

/**
 * Re-resolve every LIVE ship flying `shipConfigId` — the entry point a
 * `config:changed` handler wants. Returns how many hulls it touched.
 */
export function reresolveShipsUsingConfig(world: World, configs: ConfigService, shipConfigId: string): number {
  let touched = 0;
  for (const id of world.shipIds()) {
    if (world.shipLoadouts.get(id)?.shipId !== shipConfigId) continue;
    if (reresolveShipCore(world, configs, id)) touched++;
  }
  return touched;
}

/** Carry `value` across a change of scale, preserving its fraction of the whole. */
function fractionAcross(value: number, oldMax: number, newMax: number): number {
  if (oldMax <= 0) return newMax;
  return Math.min(newMax, (value / oldMax) * newMax);
}

/** The rate-of-fire bucket for a weapon's authored damage type. */
function rateOfFireIn(rof: { kinetic: number; energy: number; hybrid: number }, type: DamageType): number {
  return type === "kinetic" ? rof.kinetic : type === "energy" ? rof.energy : rof.hybrid;
}

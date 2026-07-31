import { isInternalFamily, type ModuleConfig } from "../../schemas/index.js";
import type { ModuleRuntime } from "../components.js";
import { transition } from "./ModuleSystem.js";
import type { World } from "../World.js";

/** Heat generated per second by a working module (boost uses its own field). */
function workingHeatRate(cfg: ModuleConfig): number {
  if (cfg.boost) return cfg.boost.heatPerSec;
  return cfg.heat.perSecondActive;
}

/**
 * EnergySystem (1.4) — capacitor + heat, run AFTER combat/nav so worked-this-tick
 * flags are set. Model:
 *
 * ENERGY: regen first, then every non-retracted module drains `drawActive` if it
 * worked this tick else `drawIdle` (× dt). If the capacitor would go negative it
 * is clamped to 0 and the highest-hardpoint-index active module is force-retracted
 * (brown-out, reverse order, one per tick — priority is tunable later).
 *
 * HEAT: each worked module adds heat (boost: `boost.heatPerSec`, else
 * `heat.perSecondActive`). A module crossing its own `overheatThreshold` goes
 * `overheated` for `overheatCooldown` (dealing `overheatSelfDamage` to hull once).
 * Ship `heat.dissipation` is then split across the still-hot (non-overheated)
 * modules proportional to their heat. The shared ship heat pool = Σ module heats;
 * when it reaches `heat.capacity` the hull takes `criticalDamagePerSec`.
 */
export function energySystem(world: World, dt: number): void {
  for (const id of world.shipIds()) {
    const core = world.shipCores.get(id)!;
    const mods = world.modules.get(id);
    if (!mods) continue;

    // --- ENERGY ---
    core.capacitor.cur = Math.min(core.capacitor.max, core.capacitor.cur + core.capacitor.regen * dt);
    let drain = 0;
    for (const m of mods.modules) {
      if (m.state === "retracted" || m.state === "overheated") continue;
      const cfg = world.configs.get<ModuleConfig>("module", m.moduleId);
      if (!cfg) continue;
      drain += (m.workedThisTick ? cfg.energy.drawActive : cfg.energy.drawIdle) * dt;
    }
    // The fitted TRANSFORMER's efficiency applies to the whole bill.
    core.capacitor.cur -= drain * core.efficiency.energyDraw;
    if (core.capacitor.cur < 0) {
      core.capacitor.cur = 0;
      brownOut(world, id, mods.modules);
    }

    // --- HEAT: generation ---
    for (const m of mods.modules) {
      if (!m.workedThisTick) continue;
      const cfg = world.configs.get<ModuleConfig>("module", m.moduleId);
      if (!cfg) continue;
      // Same transformer lever on the heat side: a good one runs the loadout
      // cooler, a cheap one cooks it.
      m.heat += workingHeatRate(cfg) * core.efficiency.heatGen * dt;
    }

    // --- HEAT: overheat detection ---
    for (const m of mods.modules) {
      if (m.state === "retracted" || m.state === "overheated") continue;
      const cfg = world.configs.get<ModuleConfig>("module", m.moduleId);
      if (!cfg) continue;
      if (m.heat >= cfg.heat.overheatThreshold) {
        m.stateTimer = cfg.heat.overheatCooldown;
        transition(world, id, m, "overheated");
        world.emit({
          type: "overheated",
          entityId: id,
          hardpointIndex: m.hardpointIndex,
          moduleId: m.moduleId,
          actions: cfg.onOverheat,
        });
        if (cfg.heat.overheatSelfDamage > 0 && !m.overheatDamaged) {
          m.overheatDamaged = true;
          dealSelfDamage(world, id, core, cfg.heat.overheatSelfDamage);
        }
      }
    }

    // --- HEAT: dissipation (proportional across non-overheated hot modules) ---
    let hotTotal = 0;
    for (const m of mods.modules) {
      if (m.state !== "overheated" && m.heat > 0) hotTotal += m.heat;
    }
    if (hotTotal > 0) {
      const budget = core.heat.dissipation * dt;
      for (const m of mods.modules) {
        if (m.state === "overheated" || m.heat <= 0) continue;
        m.heat = Math.max(0, m.heat - budget * (m.heat / hotTotal));
      }
    }

    // --- HEAT: shared pool + critical hull damage ---
    let pool = 0;
    for (const m of mods.modules) pool += m.heat;
    core.heat.cur = pool;
    if (pool >= core.heat.capacity && core.heat.criticalDamagePerSec > 0) {
      dealSelfDamage(world, id, core, core.heat.criticalDamagePerSec * dt);
    }
  }
}

/** Shed priority: 0 = drop first. Internals are never shed at all. */
function shedTier(cfg: ModuleConfig | undefined): number {
  if (cfg === undefined) return 0;
  // The ship's own systems (engine, generator, transformer, heatsink, sensors)
  // are not a power budget the pilot can trade away — cutting the engine to
  // afford a shield would be worse than the brown-out. They stay on; the
  // capacitor simply floors at 0.
  if (isInternalFamily(cfg.family)) return Infinity;
  // Then shields and the like: the big draws, and the deliberate activations.
  if (cfg.fire === undefined) return 0;
  // Weapons only as a last resort — an empty capacitor must never silently
  // disarm a ship while a shield idles on.
  return 1;
}

function brownOut(world: World, id: number, modules: ModuleRuntime[]): void {
  for (const tier of [0, 1]) {
    for (let i = modules.length - 1; i >= 0; i--) {
      const m = modules[i]!;
      if (m.state === "retracted" || m.state === "overheated") continue;
      if (shedTier(world.configs.get<ModuleConfig>("module", m.moduleId)) !== tier) continue;
      // Force-retract instantly (bypass retractTime) to relieve the deficit.
      m.workedThisTick = false;
      transition(world, id, m, "retracted");
      return;
    }
  }
}

function dealSelfDamage(
  world: World,
  id: number,
  core: { hull: number },
  amount: number,
): void {
  const wasAlive = core.hull > 0;
  core.hull -= amount;
  world.emit({ type: "damage", targetId: id, sourceId: null, amount, damageType: "energy", isAsteroid: false });
  if (wasAlive && core.hull <= 0) {
    core.hull = 0;
    world.emit({
      type: "entityDestroyed",
      entityId: id,
      killerId: null,
      isAsteroid: false,
      team: world.teams.get(id)?.team,
    });
  }
}

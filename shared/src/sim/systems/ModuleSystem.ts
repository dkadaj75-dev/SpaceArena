import type { ModuleConfig } from "../../schemas/index.js";
import type { ModuleRuntime, ModuleState } from "../components.js";
import { activePowerDraw, modulesToShedFor, powerDrawOf } from "../powerRail.js";
import type { World } from "../World.js";

/**
 * ModuleSystem (1.3 ⭐) — the generic §2.3 state machine, run BEFORE combat so
 * deploy/retract/overheat-cooldown transitions settle before weapons resolve.
 *
 *   retracted ─(toggle)→ deploying(deployTime) → active
 *        ▲                                          │
 *        └─ retracting(retractTime) ←─(toggle)──────┘
 *   any active/deploying ─(heat ≥ threshold, in EnergySystem)→ overheated
 *        overheated ─(overheatCooldown)→ retracted (weapons: → active)
 *
 * Heat generation, overheat *detection*, dissipation and energy live in
 * EnergySystem (after combat) since they depend on the worked-this-tick flags.
 */
export function moduleSystem(world: World, dt: number): void {
  // Apply toggle orders. Modules are addressed by hardpoint index (the modules
  // array is sparse-safe: empty hardpoints have no runtime entry), so find the
  // module occupying the ordered hardpoint rather than indexing by position.
  for (const { entityId, order } of world.takeOrders("moduleToggle")) {
    const mods = world.modules.get(entityId);
    if (!mods) continue;
    const m = mods.modules.find((mm) => mm.hardpointIndex === order.hardpointIndex);
    if (!m) continue;
    toggle(world, entityId, m, mods.modules);
  }

  // Advance timed transitions.
  for (const id of world.shipIds()) {
    const mods = world.modules.get(id);
    if (!mods) continue;
    for (const m of mods.modules) {
      const cfg = world.configs.get<ModuleConfig>("module", m.moduleId);
      if (!cfg) continue;
      if (m.state === "deploying") {
        m.stateTimer -= dt;
        if (m.stateTimer <= 0) transition(world, id, m, "active", cfg.onActivate);
      } else if (m.state === "retracting") {
        m.stateTimer -= dt;
        if (m.stateTimer <= 0) transition(world, id, m, "retracted");
      } else if (m.state === "overheated") {
        m.stateTimer -= dt;
        if (m.stateTimer <= 0) {
          m.overheatDamaged = false;
          // Weapons come straight back ONLINE after the lockout — they are
          // always-on (spawned active, see spawn.ts) and the overheat cooldown
          // IS their punishment; making the pilot re-toggle would double it.
          // Support modules (shield/boost) return retracted as before.
          //
          // An overheated module holds no rail current, so the pilot may have
          // spent it meanwhile. The automatic return never displaces a
          // deliberate choice: if the rail is full, the weapon stays offline.
          transition(world, id, m, cfg.fire && railFits(world, id, m, mods.modules) ? "active" : "retracted");
        }
      }

      // Shield reservoir: regen while active (1-second cap), drop when offline.
      if (cfg.mitigation?.absorbPerSecond !== undefined) {
        const cap = cfg.mitigation.absorbPerSecond;
        if (m.state === "active") {
          m.shieldPool = Math.min(cap, m.shieldPool + cfg.mitigation.absorbPerSecond * dt);
        } else {
          m.shieldPool = 0;
        }
      }
    }
  }
}

function toggle(world: World, entityId: number, m: ModuleRuntime, siblings: readonly ModuleRuntime[]): void {
  const cfg = world.configs.get<ModuleConfig>("module", m.moduleId);
  if (!cfg) return;
  switch (m.state) {
    case "retracted": {
      // POWER RAIL (2026-07-31): bringing this up may mean taking others down.
      // That is the intended trade, and it happens AUTOMATICALLY — the pilot
      // clicks the big shield, the guns drop offline, no fitting-screen error.
      if (!clearRailFor(world, entityId, m, siblings)) return;
      if (cfg.activation.deployTime <= 0) {
        transition(world, entityId, m, "active", cfg.onActivate);
      } else {
        m.stateTimer = cfg.activation.deployTime;
        transition(world, entityId, m, "deploying", cfg.onActivate);
      }
      break;
    }
    case "deploying":
    case "active": {
      if (cfg.activation.retractTime <= 0) {
        transition(world, entityId, m, "retracted", cfg.onDeactivate);
      } else {
        m.stateTimer = cfg.activation.retractTime;
        transition(world, entityId, m, "retracting", cfg.onDeactivate);
      }
      break;
    }
    case "retracting": {
      // Re-deploy.
      if (!clearRailFor(world, entityId, m, siblings)) return;
      m.stateTimer = cfg.activation.deployTime;
      transition(world, entityId, m, cfg.activation.deployTime <= 0 ? "active" : "deploying", cfg.onActivate);
      break;
    }
    case "overheated":
      break; // forced offline; ignore toggles
  }
}

/** Whether `m` can come up on what is left of the rail, displacing nothing. */
function railFits(world: World, entityId: number, m: ModuleRuntime, siblings: readonly ModuleRuntime[]): boolean {
  const capacity = world.shipCores.get(entityId)?.power.capacity ?? 0;
  const draw = powerDrawOf(world.configs.get<ModuleConfig>("module", m.moduleId));
  return activePowerDraw(world.configs, siblings, m) + draw <= capacity;
}

/**
 * Make room on the power rail for `m`, returning false when the hull simply
 * cannot feed it (a module heavier than the whole rail — the Hangar warns about
 * that fitting; here the toggle is a no-op rather than a half-powered module).
 *
 * Displaced modules are cut STRAIGHT to retracted, not walked through their
 * retract animation: the rail current is gone the instant it is diverted, and a
 * module still counted as "retracting" would hold capacity the newcomer needs.
 */
function clearRailFor(
  world: World,
  entityId: number,
  m: ModuleRuntime,
  siblings: readonly ModuleRuntime[],
): boolean {
  const capacity = world.shipCores.get(entityId)?.power.capacity ?? 0;
  const shed = modulesToShedFor(world.configs, siblings, m, capacity);
  if (shed === null) return false;
  for (const victim of shed) {
    const victimCfg = world.configs.get<ModuleConfig>("module", victim.moduleId);
    transition(world, entityId, victim, "retracted", victimCfg?.onDeactivate);
  }
  return true;
}

export function transition(
  world: World,
  entityId: number,
  m: ModuleRuntime,
  to: ModuleState,
  actions?: string[],
): void {
  const from = m.state;
  if (from === to) return;
  m.state = to;
  world.emit({
    type: "moduleStateChanged",
    entityId,
    hardpointIndex: m.hardpointIndex,
    moduleId: m.moduleId,
    from,
    to,
    actions,
  });
}

import type { ModuleConfig } from "../../schemas/index.js";
import type { ModuleRuntime, ModuleState } from "../components.js";
import type { World } from "../World.js";

/**
 * ModuleSystem (1.3 ⭐) — the generic §2.3 state machine, run BEFORE combat so
 * deploy/retract/overheat-cooldown transitions settle before weapons resolve.
 *
 *   retracted ─(toggle)→ deploying(deployTime) → active
 *        ▲                                          │
 *        └─ retracting(retractTime) ←─(toggle)──────┘
 *   any active/deploying ─(heat ≥ threshold, in EnergySystem)→ overheated
 *        overheated ─(overheatCooldown)→ retracted
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
    toggle(world, entityId, m);
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
          m.heat = 0;
          m.overheatDamaged = false;
          transition(world, id, m, "retracted");
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

function toggle(world: World, entityId: number, m: ModuleRuntime): void {
  const cfg = world.configs.get<ModuleConfig>("module", m.moduleId);
  if (!cfg) return;
  switch (m.state) {
    case "retracted": {
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
      m.stateTimer = cfg.activation.deployTime;
      transition(world, entityId, m, cfg.activation.deployTime <= 0 ? "active" : "deploying", cfg.onActivate);
      break;
    }
    case "overheated":
      break; // forced offline; ignore toggles
  }
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

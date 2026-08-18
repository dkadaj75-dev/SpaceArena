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
 *   any active/deploying ─(heat ≥ its own capacity)→ overheated
 *        overheated ─(heat ≤ capacity × rearmBelow)→ retracted (weapons: → active)
 *
 * The whole heat/energy half — generation, cooling, the overheat trip AND the
 * re-arm, tank drain and refill — lives in EnergySystem (after combat), because
 * all of it depends on the worked-this-tick flags. Since the 2026-08-07 overhaul
 * a heat lockout is not timed at all, so nothing about it is counted down here.
 *
 * The one timer this system does own is the SHIELD COLLAPSE cooldown: a shield
 * whose reserve empties (to fire or to upkeep) is flamed out by EnergySystem,
 * which stamps `mitigation.collapseCooldownSec` onto the module's `cycleTimer`.
 * Counting it down and refusing the raise while it runs happens here, with every
 * other toggle rule — see {@link collapseReady}.
 */
export function moduleSystem(world: World, dt: number): void {
  // Shield collapse cooldowns tick down FIRST, so a toggle arriving on the tick
  // one expires is honoured rather than held for another frame. Shields carry no
  // `fire` block, so their `cycleTimer` is free for this exactly as the
  // heatsink's is free for the jettison cooldown (JettisonSystem).
  for (const id of world.shipIds()) {
    const mods = world.modules.get(id);
    if (!mods) continue;
    for (const m of mods.modules) {
      if (m.cycleTimer <= 0) continue;
      if (world.configs.get<ModuleConfig>("module", m.moduleId)?.mitigation) {
        m.cycleTimer = Math.max(0, m.cycleTimer - dt);
      }
    }
  }

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
      } else if (m.state === "reloading") {
        m.stateTimer -= dt;
        if (m.stateTimer <= 0 && cfg.fire?.clip) {
          m.rounds = cfg.fire.clip.size;
          m.stateTimer = 0;
          m.cycleTimer = 0;
          transition(world, id, m, "active");
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
      // A flamed-out tank must charge past its own `rearmAbove` before the
      // module can be raised again (heat/energy overhaul 2026-08-07) — the
      // energy twin of the overheat re-arm, and what stops an empty boost
      // bottle from stuttering one tick of thrust per three of trickle-charge.
      if (!tankReady(m, cfg)) return;
      if (!collapseReady(m, cfg)) return;
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
      if (!tankReady(m, cfg)) return;
      if (!collapseReady(m, cfg)) return;
      if (!clearRailFor(world, entityId, m, siblings)) return;
      m.stateTimer = cfg.activation.deployTime;
      transition(world, entityId, m, cfg.activation.deployTime <= 0 ? "active" : "deploying", cfg.onActivate);
      break;
    }
    case "overheated":
    case "reloading":
      break; // forced offline; ignore toggles
  }
}

/**
 * Whether an energy-bearing module holds enough charge to be raised at all.
 * Modules with no tank are always ready. Exported so the HUD/bot side can ask
 * the same question the sim answers (a BOOST button that lights up on a tank
 * the sim will refuse is worse than no button).
 */
export function tankReady(m: ModuleRuntime, cfg: ModuleConfig | undefined): boolean {
  if (m.energyCapacity <= 0 || !cfg?.energy) return true;
  return m.energy >= m.energyCapacity * cfg.energy.rearmAbove;
}

/**
 * Whether a shield is off its COLLAPSE cooldown (`mitigation.collapseCooldownSec`,
 * banked on the module's own `cycleTimer` by the EnergySystem flameout).
 * Non-shields are always ready — they have no such lockout, and their
 * `cycleTimer` means the weapon cadence instead.
 *
 * Exported for the same reason {@link tankReady} is: the HUD and the bots must
 * be able to ask the question the sim answers, rather than offering a toggle the
 * sim will silently refuse.
 */
export function collapseReady(m: ModuleRuntime, cfg: ModuleConfig | undefined): boolean {
  return !cfg?.mitigation || m.cycleTimer <= 0;
}

/**
 * Whether `m` can come up on what is left of the rail, displacing nothing.
 * Exported for the overheat RE-ARM in EnergySystem: a locked-out module holds no
 * rail current, so the pilot may have spent it meanwhile, and the automatic
 * return must never displace that deliberate choice.
 */
export function railFits(world: World, entityId: number, m: ModuleRuntime, siblings: readonly ModuleRuntime[]): boolean {
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

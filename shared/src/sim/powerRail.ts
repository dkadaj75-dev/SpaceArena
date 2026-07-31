import type { ConfigService } from "../core/ConfigService.js";
import { isInternalFamily, type ModuleConfig } from "../schemas/index.js";
import type { ModuleRuntime } from "./components.js";

/**
 * The POWER RAIL (owner 2026-07-31) — the second energy axis, and the one that
 * decides what can be online **at once**.
 *
 * The existing capacitor is a reservoir: modules drain it over time and it
 * refills. The rail is the opposite kind of quantity — an instantaneous current
 * budget. A module occupies its `power.draw` for as long as it is active, and
 * the sum across active modules may never exceed the hull's `power.capacity`
 * (mostly supplied by the fitted transformer).
 *
 * The consequence, and the point: a hull whose transformer delivers 15 can
 * carry two 10-draw lasers, but only ever run one. Bringing the second up takes
 * the first down, automatically. A heavy shield can be authored to need the
 * whole rail, so raising it shuts every gun off — a real decision rather than a
 * fitting-screen error.
 *
 * Over-subscribed fittings are deliberately LEGAL: the Hangar warns, the match
 * simply cannot have everything online. That is what lets a player carry a
 * situational heavy module they only bring up when it matters.
 *
 * INTERNALS never contend. They are the ship's own systems — the very things
 * that *supply* the rail — and they have no toggle, so pricing them here would
 * only mean a bay that can shut itself off. The schema rejects `power.draw` on
 * an internal family for the same reason.
 */

/** Rail current this module occupies while active. Absent block ⇒ free. */
export function powerDrawOf(cfg: ModuleConfig | undefined): number {
  if (!cfg || isInternalFamily(cfg.family)) return 0;
  return cfg.power?.draw ?? 0;
}

/** States that hold the rail: anything that is up or on its way up. */
function occupiesRail(m: ModuleRuntime): boolean {
  return m.state === "active" || m.state === "deploying";
}

/** Rail current currently committed across a ship's modules. */
export function activePowerDraw(
  configs: Pick<ConfigService, "get">,
  modules: readonly ModuleRuntime[],
  exclude?: ModuleRuntime,
): number {
  let total = 0;
  for (const m of modules) {
    if (m === exclude || !occupiesRail(m)) continue;
    total += powerDrawOf(configs.get<ModuleConfig>("module", m.moduleId));
  }
  return total;
}

/**
 * Which modules must come DOWN for `target` to come up, or `null` when the
 * hull cannot feed `target` even with everything else off (an over-heavy module
 * on a thin rail — the Hangar warns about this, and the sim refuses it).
 *
 * Shedding order is reverse slot index, matching the brown-out convention
 * elsewhere: deterministic, and it drops the later-fitted extras before the
 * hull's primary weapon.
 */
export function modulesToShedFor(
  configs: Pick<ConfigService, "get">,
  modules: readonly ModuleRuntime[],
  target: ModuleRuntime,
  capacity: number,
): ModuleRuntime[] | null {
  const need = powerDrawOf(configs.get<ModuleConfig>("module", target.moduleId));
  if (need > capacity) return null; // cannot be fed at all
  if (need === 0) return []; // free modules never contend

  let committed = activePowerDraw(configs, modules, target);
  if (committed + need <= capacity) return [];

  const shed: ModuleRuntime[] = [];
  for (let i = modules.length - 1; i >= 0; i--) {
    const m = modules[i]!;
    if (m === target || !occupiesRail(m)) continue;
    const draw = powerDrawOf(configs.get<ModuleConfig>("module", m.moduleId));
    if (draw === 0) continue;
    shed.push(m);
    committed -= draw;
    if (committed + need <= capacity) break;
  }
  return committed + need <= capacity ? shed : null;
}

/**
 * Which of `modules` may come up at SPAWN, filled greedily in slot order until
 * the rail is full. Everything else starts offline — this is the "install both,
 * only one runs" behaviour at the moment the ship appears.
 *
 * Slot order (not draw order) is the tie-break on purpose: the hangar list reads
 * top-down, so the pilot's first hardpoint is the one that boots.
 */
export function railAdmitted(
  configs: Pick<ConfigService, "get">,
  modules: readonly ModuleRuntime[],
  capacity: number,
): Set<ModuleRuntime> {
  const admitted = new Set<ModuleRuntime>();
  let committed = 0;
  for (const m of [...modules].sort((a, b) => a.hardpointIndex - b.hardpointIndex)) {
    const draw = powerDrawOf(configs.get<ModuleConfig>("module", m.moduleId));
    if (draw === 0) {
      admitted.add(m);
      continue;
    }
    if (committed + draw > capacity) continue;
    committed += draw;
    admitted.add(m);
  }
  return admitted;
}

/**
 * Total rail draw of a FITTING (every fitted module, active or not) — what the
 * Hangar compares against capacity to decide whether to warn.
 */
export function fittingPowerDraw(
  configs: Pick<ConfigService, "get">,
  moduleIds: readonly (string | null | undefined)[],
): number {
  let total = 0;
  for (const id of moduleIds) {
    if (!id) continue;
    total += powerDrawOf(configs.get<ModuleConfig>("module", id));
  }
  return total;
}

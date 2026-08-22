import type { ConfigService } from "../core/ConfigService.js";
import { isInternalFamily, type ModuleConfig } from "../schemas/index.js";
import type { ModuleRuntime } from "./components.js";

/**
 * The POWER RAIL (owner 2026-07-31) — the second energy axis, and the one that
 * decides what can be online **at once**.
 *
 * A module's own energy tank is a reservoir: it drains while the module works
 * and refills while it rests. The rail is the opposite kind of quantity — an
 * instantaneous current budget. A module occupies its `power.draw` for as long as it is active, and
 * the sum across active modules may never exceed the hull's `power.capacity`.
 *
 * Capacity is a pure HULL stat since the transformer family was retired (owner
 * 2026-08-22): no bay widens the rail any more, so how much a ship can run at
 * once is decided when the pilot picks the airframe, not when they pick a
 * module. That also means the rail no longer moves when a fitting changes,
 * which is what makes the Hangar's warning a property of the fit alone.
 *
 * The consequence, and the point: a hull whose rail delivers 15 can
 * carry a 10-draw laser and an 8-draw shield, but never run both. Raising the
 * shield is refused while the gun holds the rail — a real decision rather than a
 * fitting-screen error.
 *
 * Over-subscribed fittings are deliberately LEGAL: the Hangar warns, the match
 * simply cannot have everything online. That is what lets a player carry a
 * situational heavy module they only bring up when it matters.
 *
 * WHICH SIDE GIVES WAY changed on 2026-08-21, when weapons stopped being
 * toggleable. The rail used to shed guns to make room for a shield; a shed gun
 * now has no control that could bring it back, so the DEPLOYABLE is refused
 * instead and weapons hold the rail for the whole match. See
 * {@link isRailPermanent}.
 *
 * INTERNALS never contend, and never did. They are the ship's own systems — the
 * very things that *supply* the rail — and they have no toggle, so pricing them
 * here would only mean a bay that can shut itself off. The schema rejects
 * `power.draw` on an internal family for the same reason.
 */

/** Rail current this module occupies while active. Absent block ⇒ free. */
export function powerDrawOf(cfg: ModuleConfig | undefined): number {
  if (!cfg || isInternalFamily(cfg.family)) return 0;
  return cfg.power?.draw ?? 0;
}

/**
 * Modules the rail may never take DOWN: internals and, since 2026-08-21,
 * weapons.
 *
 * A weapon has no toggle any more — its HUD button is a trigger — so a weapon
 * shed to make room for a shield could never be brought back, and the pilot
 * would lose a gun for the rest of the match with no control that could undo
 * it. Making them permanent keeps the rail's actual decision intact and moves
 * it to the only side that can still act on it: the DEPLOYABLE is what gets
 * refused when the rail is full, not the gun.
 */
export function isRailPermanent(cfg: ModuleConfig | undefined): boolean {
  if (!cfg) return false;
  return isInternalFamily(cfg.family) || cfg.fire !== undefined;
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
 * elsewhere: deterministic, and it drops the later-fitted extras first. Rail
 * PERMANENTS (internals and weapons) are never candidates, so a target that can
 * only be fed by taking a gun down is simply refused.
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
    const cfg = configs.get<ModuleConfig>("module", m.moduleId);
    if (isRailPermanent(cfg)) continue; // never sheds — see isRailPermanent
    const draw = powerDrawOf(cfg);
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
  // Permanents first, then everything else, each group in slot order. They can
  // never be shed later (see {@link isRailPermanent}), so a rail that seats a
  // deployable ahead of a gun would strand the gun for the whole match.
  const order = [...modules].sort((a, b) => {
    const pa = isRailPermanent(configs.get<ModuleConfig>("module", a.moduleId)) ? 0 : 1;
    const pb = isRailPermanent(configs.get<ModuleConfig>("module", b.moduleId)) ? 0 : 1;
    return pa !== pb ? pa - pb : a.hardpointIndex - b.hardpointIndex;
  });
  for (const m of order) {
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

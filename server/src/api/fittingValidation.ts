import { hardpointsOf, type ConfigService, type HardpointMap, type ModuleConfig, type ShipConfig } from "@space-arena/shared";

export type FittingValidation =
  | { ok: true; moduleIds: string[] }
  | { ok: false; code: string; message: string };

/**
 * Validate a fitting against the content registry + a user's ownership/level.
 * Rejects only *illegal* fits (unknown module/ship, wrong hardpoint family, index
 * out of range, unowned module, level-gated module); *risky* fits (e.g. idle
 * energy draw exceeding regen) are allowed by design (see ROADMAP 3.5).
 *
 * `owned` is the set of module ids the user owns; `level` is their profile level.
 */
export function validateFitting(
  configs: ConfigService,
  shipId: string,
  hardpointMap: HardpointMap,
  owned: ReadonlySet<string>,
  level: number,
): FittingValidation {
  const ship = configs.get<ShipConfig>("ship", shipId);
  if (!ship) return { ok: false, code: "unknown-ship", message: `unknown ship: ${shipId}` };
  const hardpoints = hardpointsOf(ship);

  const moduleIds: string[] = [];
  for (const [key, moduleId] of Object.entries(hardpointMap)) {
    const idx = Number(key);
    if (!Number.isInteger(idx) || idx < 0 || idx >= hardpoints.length) {
      return { ok: false, code: "bad-hardpoint", message: `hardpoint index ${key} out of range for ${shipId}` };
    }
    const mod = configs.get<ModuleConfig>("module", moduleId);
    if (!mod) return { ok: false, code: "unknown-module", message: `unknown module: ${moduleId}` };

    const hardpoint = hardpoints[idx]!;
    if (!hardpoint.accepts.includes(mod.family)) {
      return {
        ok: false,
        code: "family-mismatch",
        message: `hardpoint ${idx} does not accept family '${mod.family}' (accepts ${hardpoint.accepts.join(", ")})`,
      };
    }
    if (!owned.has(moduleId)) {
      return { ok: false, code: "not-owned", message: `you do not own module ${moduleId}` };
    }
    if (mod.requiresLevel > level) {
      return {
        ok: false,
        code: "level-locked",
        message: `module ${moduleId} requires level ${mod.requiresLevel} (you are level ${level})`,
      };
    }
    moduleIds.push(moduleId);
  }
  return { ok: true, moduleIds };
}

/**
 * Drop the entries of a STORED fitting that the ship's sockets no longer
 * support: an index past the socket count, or a module whose family the socket
 * at that index does not accept.
 *
 * This exists because a fitting outlives the hull it was saved against. Sockets
 * are content — the 2026-08-22 hardpoint pass cut the Interceptor from three
 * hardpoints to two and re-ordered every hull's slots — and every fitting saved
 * before it now addresses a slot that moved or vanished. {@link validateFitting}
 * rejects those, and rejecting is right for a fitting a client is asking to
 * SAVE: that is a live edit, and a silent prune would be the API deciding what
 * the player meant.
 *
 * A fitting being loaded to fly is the opposite case. Nobody is asking for
 * anything, the mismatch is the pack's doing rather than the player's, and the
 * only honest options are "fly it minus the slots that no longer exist" or
 * "refuse to let them into the match". So the room prunes first and validates
 * what is left (see `ArenaRoom.resolveFitting`) — ownership and level are still
 * enforced on every surviving entry.
 *
 * Returns the pruned map plus the keys removed, so the caller can log the drop
 * rather than silently flying a different loadout than the player saved.
 */
export function pruneStaleFitting(
  configs: ConfigService,
  shipId: string,
  hardpointMap: HardpointMap,
): { map: HardpointMap; dropped: string[] } {
  const ship = configs.get<ShipConfig>("ship", shipId);
  if (!ship) return { map: {}, dropped: Object.keys(hardpointMap) };
  const hardpoints = hardpointsOf(ship);
  const map: HardpointMap = {};
  const dropped: string[] = [];
  for (const [key, moduleId] of Object.entries(hardpointMap)) {
    const idx = Number(key);
    const socket = Number.isInteger(idx) && idx >= 0 ? hardpoints[idx] : undefined;
    const family = configs.get<ModuleConfig>("module", moduleId)?.family;
    // An UNKNOWN module is left in place on purpose: it is not a socket-shape
    // problem, and `validateFitting` has a precise `unknown-module` answer for
    // it that a prune here would turn into a silently emptier ship.
    if (!socket || (family !== undefined && !socket.accepts.includes(family))) {
      dropped.push(key);
      continue;
    }
    map[key] = moduleId;
  }
  return { map, dropped };
}

/**
 * Expand a hardpoint map into a **positional** module list for spawning: the
 * array index is the hardpoint index and empty hardpoints are `null`. This
 * preserves hardpoint positions end-to-end so a fit like `{0:laser, 2:shield}`
 * spawns the shield answering hardpoint index 2 (not a compacted index 1).
 */
export function hardpointMapToFitting(ship: ShipConfig, hardpointMap: HardpointMap): (string | null)[] {
  const out: (string | null)[] = new Array(hardpointsOf(ship).length).fill(null);
  for (const [key, moduleId] of Object.entries(hardpointMap)) {
    const idx = Number(key);
    if (Number.isInteger(idx) && idx >= 0 && idx < out.length) out[idx] = moduleId;
  }
  return out;
}

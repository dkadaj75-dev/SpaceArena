import {
  hardpointsOf,
  type EmitterBinding,
  type ModuleFamily,
  type ShipConfig,
  type SignalId,
  type SocketConfig,
} from "@space-arena/shared";

/** A piecewise-linear response point `[input, output]` (mirrors socket schema). */
export type CurvePoint = [number, number];
export type SocketKind = SocketConfig["kind"];

/** Every socket id currently used by a ship. */
function socketIds(ship: ShipConfig): Set<string> {
  return new Set(ship.sockets.map((s) => s.id));
}

/**
 * A unique socket id derived from `base`, avoiding collisions with `existing`.
 * `base` → `base` if free, else `base-2`, `base-3`, … (deterministic).
 */
export function uniqueSocketId(existing: Set<string>, base: string): string {
  if (!existing.has(base)) return base;
  let n = 2;
  while (existing.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/** Deep clone a ship for a mutation working copy (never mutate the frozen registry object). */
function cloneShip(ship: ShipConfig): ShipConfig {
  return structuredClone(ship);
}

/** The 0-based hardpoint index of the socket at array position `arrayIndex`, or -1 if it is not a hardpoint. */
export function hardpointIndexOf(ship: ShipConfig, arrayIndex: number): number {
  let hp = -1;
  for (let i = 0; i <= arrayIndex && i < ship.sockets.length; i++) {
    if (ship.sockets[i]!.kind === "hardpoint") hp++;
  }
  return ship.sockets[arrayIndex]?.kind === "hardpoint" ? hp : -1;
}

/**
 * Append a new socket of `kind` with schema-valid defaults. Emitter sockets need
 * a valid `effect` id (the caller passes one that exists, e.g. the first effect
 * config); an empty string is rejected downstream by ConfigService.replace.
 */
export function addSocket(ship: ShipConfig, kind: SocketKind, effectId = ""): ShipConfig {
  const next = cloneShip(ship);
  const id = uniqueSocketId(socketIds(ship), kind === "hardpoint" ? "hp-new" : "emit-new");
  const socket: SocketConfig =
    kind === "hardpoint"
      ? { id, kind: "hardpoint", transform: { pos: [0, 0, 0] }, accepts: ["laser"] }
      : { id, kind: "emitter", transform: { pos: [0, 0, 0] }, effect: effectId, bindings: [] };
  next.sockets.push(socket);
  return next;
}

/**
 * Insert a copy of the socket at `arrayIndex` right after it (unique id).
 * Duplicating a hardpoint shifts every later hardpoint index by one, so the
 * positional `defaultFitting` is patched to keep each remaining hardpoint's
 * module aligned (the duplicate inherits the original's default module if any).
 */
export function duplicateSocket(ship: ShipConfig, arrayIndex: number): ShipConfig {
  const src = ship.sockets[arrayIndex];
  if (!src) return ship;
  const next = cloneShip(ship);
  const copy = structuredClone(src);
  copy.id = uniqueSocketId(socketIds(ship), `${src.id}-copy`);
  next.sockets.splice(arrayIndex + 1, 0, copy);
  if (src.kind === "hardpoint") {
    const hp = hardpointIndexOf(ship, arrayIndex);
    if (hp >= 0 && hp < next.defaultFitting.length) {
      next.defaultFitting.splice(hp + 1, 0, next.defaultFitting[hp]!);
    }
  }
  return next;
}

/**
 * Remove the socket at `arrayIndex`. Deleting a hardpoint also drops its
 * positional `defaultFitting` entry so later hardpoints keep their modules.
 */
export function deleteSocket(ship: ShipConfig, arrayIndex: number): ShipConfig {
  const src = ship.sockets[arrayIndex];
  if (!src) return ship;
  const next = cloneShip(ship);
  next.sockets.splice(arrayIndex, 1);
  if (src.kind === "hardpoint") {
    const hp = hardpointIndexOf(ship, arrayIndex);
    if (hp >= 0 && hp < next.defaultFitting.length) next.defaultFitting.splice(hp, 1);
  }
  return next;
}

/** Move `arr[from]` to position `to`, returning a new array (out-of-range = unchanged copy). */
function moveItem<T>(arr: readonly T[], from: number, to: number): T[] {
  const out = arr.slice();
  if (from < 0 || from >= out.length || to < 0 || to >= out.length) return out;
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item!);
  return out;
}

/** Result of a hardpoint reorder: the new ship plus a human-readable warning about fitting remaps. */
export interface ReorderResult {
  ship: ShipConfig;
  warning: string;
}

/**
 * Reorder hardpoint sockets by moving the hardpoint at `fromHp` to hardpoint
 * slot `toHp`. Because `hardpointIndex` is derived from array order, only the
 * hardpoint entries are permuted (emitter sockets keep their array positions).
 * `defaultFitting` is permuted with the same move so each hardpoint keeps its
 * default module. Existing player fittings in the DB are positional too, so a
 * warning is always returned — callers must surface it.
 */
export function reorderHardpoint(ship: ShipConfig, fromHp: number, toHp: number): ReorderResult {
  const hardpoints = hardpointsOf(ship);
  const warning = `Reordering hardpoints remaps hardpoint indices: existing saved fittings (defaultFitting and any player fittings referencing hardpoint ${fromHp}) will shift. defaultFitting was remapped automatically; player fittings in the DB are NOT and may point at the wrong module.`;
  if (fromHp < 0 || toHp < 0 || fromHp >= hardpoints.length || toHp >= hardpoints.length || fromHp === toHp) {
    return { ship, warning };
  }
  const next = cloneShip(ship);
  // Reordered hardpoint entries, then written back into the same array slots.
  const reordered = moveItem(hardpoints, fromHp, toHp);
  let hp = 0;
  next.sockets = next.sockets.map((s) => (s.kind === "hardpoint" ? structuredClone(reordered[hp++]!) : s));
  next.defaultFitting = moveItem(next.defaultFitting, fromHp, toHp);
  return { ship: next, warning };
}

/** Replace the emitter socket's effect id at `arrayIndex`. */
export function setEmitterEffect(ship: ShipConfig, arrayIndex: number, effectId: string): ShipConfig {
  const next = cloneShip(ship);
  const s = next.sockets[arrayIndex];
  if (s?.kind === "emitter") s.effect = effectId;
  return next;
}

/** Add a default binding to the emitter socket at `arrayIndex` (first signal, given param). */
export function addBinding(ship: ShipConfig, arrayIndex: number, source: SignalId, param: string): ShipConfig {
  const next = cloneShip(ship);
  const s = next.sockets[arrayIndex];
  if (s?.kind === "emitter") {
    const binding: EmitterBinding = { source, param, curve: [[0, 0], [1, 1]] };
    s.bindings.push(binding);
  }
  return next;
}

/** Remove binding `bindingIndex` from the emitter socket at `arrayIndex`. */
export function removeBinding(ship: ShipConfig, arrayIndex: number, bindingIndex: number): ShipConfig {
  const next = cloneShip(ship);
  const s = next.sockets[arrayIndex];
  if (s?.kind === "emitter") s.bindings.splice(bindingIndex, 1);
  return next;
}

/** Patch fields of a binding (source/param). */
export function patchBinding(
  ship: ShipConfig,
  arrayIndex: number,
  bindingIndex: number,
  patch: Partial<Pick<EmitterBinding, "source" | "param">>,
): ShipConfig {
  const next = cloneShip(ship);
  const s = next.sockets[arrayIndex];
  if (s?.kind === "emitter") {
    const b = s.bindings[bindingIndex];
    if (b) Object.assign(b, patch);
  }
  return next;
}

/** Replace the entire curve of a binding (curve editor commit — round-trips through the schema). */
export function setBindingCurve(
  ship: ShipConfig,
  arrayIndex: number,
  bindingIndex: number,
  curve: readonly CurvePoint[],
): ShipConfig {
  const next = cloneShip(ship);
  const s = next.sockets[arrayIndex];
  if (s?.kind === "emitter") {
    const b = s.bindings[bindingIndex];
    if (b) b.curve = curve.map((p) => [p[0], p[1]] as CurvePoint);
  }
  return next;
}

/** Set a single field of the socket transform at `arrayIndex` (used by gizmo drag-end + numeric inputs). */
export function setSocketTransform(
  ship: ShipConfig,
  arrayIndex: number,
  transform: { pos: [number, number, number]; rot?: [number, number, number]; scale?: number },
): ShipConfig {
  const next = cloneShip(ship);
  const s = next.sockets[arrayIndex];
  if (s) s.transform = { pos: transform.pos, ...(transform.rot ? { rot: transform.rot } : {}), ...(transform.scale !== undefined ? { scale: transform.scale } : {}) };
  return next;
}

/** Set the socket id at `arrayIndex` (duplicate ids are rejected by the schema on replace). */
export function setSocketId(ship: ShipConfig, arrayIndex: number, id: string): ShipConfig {
  const next = cloneShip(ship);
  const s = next.sockets[arrayIndex];
  if (s) s.id = id;
  return next;
}

/** Set the accepted module families of the hardpoint socket at `arrayIndex`. */
export function setHardpointAccepts(
  ship: ShipConfig,
  arrayIndex: number,
  accepts: ModuleFamily[],
): ShipConfig {
  const next = cloneShip(ship);
  const s = next.sockets[arrayIndex];
  if (s?.kind === "hardpoint") s.accepts = accepts;
  return next;
}

/** A module reference (id + family) — the minimal module info fitting validation needs. */
export interface ModuleRef {
  id: string;
  family: string;
}

/** One incompatible `defaultFitting` slot: a hardpoint whose default module's family is not accepted. */
export interface FittingIssue {
  /** Hardpoint index (positional; also the `defaultFitting` index). */
  hpIndex: number;
  /** Hardpoint socket id, or "(orphaned)" when `defaultFitting` is longer than the hardpoint count. */
  socketId: string;
  moduleId: string;
  /** The module's family, if the module id is known. */
  moduleFamily?: string;
  /** Families the hardpoint accepts. */
  accepts: readonly string[];
}

/**
 * Relational check of `defaultFitting` against each hardpoint's `accepts`
 * (4.6 Finding 6). Mirrors the shared-side validation ConfigService is gaining
 * so the editor can flag which slot broke BEFORE `replace()` rejects it. A slot
 * is incompatible when its module's family is known and not in the hardpoint's
 * `accepts`, or when it has no matching hardpoint (orphaned entry). Unknown
 * module ids are left to ConfigService's dangling-reference check.
 */
export function incompatibleFittingSlots(ship: ShipConfig, modules: readonly ModuleRef[]): FittingIssue[] {
  const familyOf = new Map(modules.map((m) => [m.id, m.family]));
  const hardpoints = hardpointsOf(ship);
  const issues: FittingIssue[] = [];
  ship.defaultFitting.forEach((moduleId, i) => {
    const hp = hardpoints[i];
    if (!hp) {
      issues.push({ hpIndex: i, socketId: "(orphaned)", moduleId, accepts: [] });
      return;
    }
    const fam = familyOf.get(moduleId);
    if (fam !== undefined && !hp.accepts.includes(fam as ModuleFamily)) {
      issues.push({ hpIndex: i, socketId: hp.id, moduleId, moduleFamily: fam, accepts: hp.accepts });
    }
  });
  return issues;
}

/**
 * Produce a compatible ship by clearing incompatible `defaultFitting` slots
 * (one-click fix for Finding 6). Because `defaultFitting` is positional and
 * cannot hold gaps, this truncates the array just before the first incompatible
 * slot — clearing that slot and any positional defaults after it. The remaining
 * leading entries are all compatible, so `replace()` will accept the result.
 */
export function clearIncompatibleFitting(ship: ShipConfig, modules: readonly ModuleRef[]): ShipConfig {
  const issues = incompatibleFittingSlots(ship, modules);
  if (issues.length === 0) return ship;
  const firstBad = Math.min(...issues.map((x) => x.hpIndex));
  const next = cloneShip(ship);
  next.defaultFitting = next.defaultFitting.slice(0, firstBad);
  return next;
}

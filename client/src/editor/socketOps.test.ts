import { describe, expect, it } from "vitest";
import { hardpointsOf, shipSchema, type ShipConfig } from "@space-arena/shared";
import {
  addBinding,
  addSocket,
  clearIncompatibleFitting,
  deleteSocket,
  duplicateSocket,
  hardpointIndexOf,
  incompatibleFittingSlots,
  patchBinding,
  removeBinding,
  reorderHardpoint,
  setBindingCurve,
  setHardpointAccepts,
  uniqueSocketId,
  type CurvePoint,
  type ModuleRef,
} from "./socketOps.js";

const MODULES: ModuleRef[] = [
  { id: "module.laser-mk1", family: "laser" },
  { id: "module.missile-mk1", family: "missile" },
  { id: "module.shield-mk1", family: "shield" },
];

/** A minimal, schema-valid ship: 2 hardpoints, 1 emitter, matching defaultFitting. */
function makeShip(): ShipConfig {
  const ship: ShipConfig = {
    id: "ship.test",
    type: "ship",
    version: 1,
    name: "Test",
    class: "light",
    core: {
      hull: { base: 100, resists: { kinetic: 0.1, energy: 0.0 } },
      engine: { nominalSpeed: 30, accel: 20, turnRate: 3 },
      energy: { capacitor: 120, regen: 14 },
      heat: { capacity: 100, dissipation: 9, criticalDamagePerSec: 4 },
      efficiency: { energyDraw: 1, heatGen: 1 },
      sensors: { lockRange: 60, lockTimeSec: 1.5, coneDeg: 70 },
    },
    upgradeTracks: { hull: "upgrade.hull-std", engine: "upgrade.engine-std", energy: "upgrade.energy-std", heat: "upgrade.heat-std" },
    sockets: [
      { id: "hp-a", kind: "hardpoint", transform: { pos: [0, 0, 1] }, accepts: ["laser", "kinetic"] },
      { id: "hp-b", kind: "hardpoint", transform: { pos: [1, 0, 0] }, accepts: ["missile"] },
      {
        id: "eng",
        kind: "emitter",
        transform: { pos: [0, 0, -1] },
        effect: "fx.engine-trail",
        bindings: [{ source: "throttle", param: "emitRate", curve: [[0, 0], [1, 100]] }],
      },
    ],
    defaultFitting: ["module.laser-mk1", "module.missile-mk1"],
    render: { recipe: "procedural.arrowhead" },
    collider: { shape: "circle", radius: 1.4 },
  };
  // Guard: the fixture itself must be valid so mutation assertions are meaningful.
  expect(shipSchema.safeParse(ship).success).toBe(true);
  return ship;
}

const valid = (ship: ShipConfig): boolean => shipSchema.safeParse(ship).success;

describe("socketOps", () => {
  it("uniqueSocketId avoids collisions", () => {
    const used = new Set(["hp", "hp-2"]);
    expect(uniqueSocketId(used, "hp")).toBe("hp-3");
    expect(uniqueSocketId(used, "eng")).toBe("eng");
  });

  it("hardpointIndexOf skips emitter sockets", () => {
    const ship = makeShip();
    expect(hardpointIndexOf(ship, 0)).toBe(0);
    expect(hardpointIndexOf(ship, 1)).toBe(1);
    expect(hardpointIndexOf(ship, 2)).toBe(-1); // emitter
  });

  it("addSocket adds a schema-valid hardpoint and emitter", () => {
    const ship = makeShip();
    const withHp = addSocket(ship, "hardpoint");
    expect(valid(withHp)).toBe(true);
    expect(withHp.sockets).toHaveLength(4);
    expect(hardpointsOf(withHp)).toHaveLength(3);

    const withEmit = addSocket(ship, "emitter", "fx.engine-trail");
    expect(valid(withEmit)).toBe(true);
    expect(withEmit.sockets.at(-1)).toMatchObject({ kind: "emitter", effect: "fx.engine-trail" });
  });

  it("duplicateSocket clones a hardpoint (unique id) and keeps defaultFitting aligned", () => {
    const ship = makeShip();
    const dup = duplicateSocket(ship, 0);
    expect(valid(dup)).toBe(true);
    const ids = dup.sockets.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length); // unique
    expect(dup.sockets[1]!.id).toBe("hp-a-copy");
    // Original hp-a had module.laser-mk1 at index 0 → duplicate inherits it.
    expect(dup.defaultFitting).toEqual(["module.laser-mk1", "module.laser-mk1", "module.missile-mk1"]);
  });

  it("deleteSocket removes a hardpoint and its defaultFitting entry", () => {
    const ship = makeShip();
    const del = deleteSocket(ship, 0);
    expect(valid(del)).toBe(true);
    expect(hardpointsOf(del)).toHaveLength(1);
    expect(del.defaultFitting).toEqual(["module.missile-mk1"]);
  });

  it("reorderHardpoint permutes hardpoints + defaultFitting and returns a remap warning", () => {
    const ship = makeShip();
    const { ship: next, warning } = reorderHardpoint(ship, 0, 1);
    expect(valid(next)).toBe(true);
    expect(warning).toMatch(/remap/i);
    expect(hardpointsOf(next).map((h) => h.id)).toEqual(["hp-b", "hp-a"]);
    expect(next.defaultFitting).toEqual(["module.missile-mk1", "module.laser-mk1"]);
    // Emitter socket keeps its relative position (last).
    expect(next.sockets.at(-1)!.kind).toBe("emitter");
  });

  it("binding add/remove/patch stay schema-valid", () => {
    const ship = makeShip();
    const added = addBinding(ship, 2, "heatFraction", "emitRate");
    expect(valid(added)).toBe(true);
    const emitter = added.sockets[2]!;
    if (emitter.kind === "emitter") expect(emitter.bindings).toHaveLength(2);

    const patched = patchBinding(added, 2, 1, { source: "hullFraction" });
    const pe = patched.sockets[2]!;
    if (pe.kind === "emitter") expect(pe.bindings[1]!.source).toBe("hullFraction");

    const removed = removeBinding(patched, 2, 0);
    const re = removed.sockets[2]!;
    if (re.kind === "emitter") expect(re.bindings).toHaveLength(1);
    expect(valid(removed)).toBe(true);
  });

  it("incompatibleFittingSlots flags a default whose family is not accepted", () => {
    const ship = makeShip();
    // hp-a accepts laser+kinetic, default is module.laser-mk1 → compatible.
    expect(incompatibleFittingSlots(ship, MODULES)).toEqual([]);
    // Narrow hp-a to shield-only → its laser default becomes incompatible.
    const narrowed = setHardpointAccepts(ship, 0, ["shield"]);
    const issues = incompatibleFittingSlots(narrowed, MODULES);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ hpIndex: 0, socketId: "hp-a", moduleId: "module.laser-mk1", moduleFamily: "laser" });
    expect(issues[0]!.accepts).toEqual(["shield"]);
  });

  it("incompatibleFittingSlots flags orphaned entries beyond the hardpoint count", () => {
    const ship = makeShip();
    const extra = structuredClone(ship);
    extra.defaultFitting = ["module.laser-mk1", "module.missile-mk1", "module.shield-mk1"]; // 3 defaults, 2 hardpoints
    const issues = incompatibleFittingSlots(extra, MODULES);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ hpIndex: 2, socketId: "(orphaned)" });
  });

  it("clearIncompatibleFitting truncates before the first incompatible slot and stays schema-valid", () => {
    const ship = setHardpointAccepts(makeShip(), 0, ["shield"]); // slot #0 now incompatible
    const fixed = clearIncompatibleFitting(ship, MODULES);
    expect(valid(fixed)).toBe(true);
    expect(fixed.defaultFitting).toEqual([]); // first-bad = 0 → everything cleared
    expect(incompatibleFittingSlots(fixed, MODULES)).toEqual([]);
    // A compatible ship is returned unchanged.
    expect(clearIncompatibleFitting(makeShip(), MODULES).defaultFitting).toEqual(["module.laser-mk1", "module.missile-mk1"]);
  });

  it("setBindingCurve round-trips an edited curve through the schema", () => {
    const ship = makeShip();
    const newCurve: CurvePoint[] = [[0, 0], [0.5, 30], [1, 90]];
    const next = setBindingCurve(ship, 2, 0, newCurve);
    expect(valid(next)).toBe(true);
    const emitter = next.sockets[2]!;
    expect(emitter.kind).toBe("emitter");
    if (emitter.kind === "emitter") {
      expect(emitter.bindings[0]!.curve).toEqual(newCurve);
      // Round-trip: re-parse and confirm the curve survived structuredClone + zod.
      const parsed = shipSchema.parse(next);
      const parsedEmitter = parsed.sockets[2]!;
      if (parsedEmitter.kind === "emitter") expect(parsedEmitter.bindings[0]!.curve).toEqual(newCurve);
    }
  });
});

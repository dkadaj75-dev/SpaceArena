import { describe, expect, it } from "vitest";
import type { ModuleFamily, ShipConfig } from "@space-arena/shared";
import {
  buildHardpointMap,
  fittedModuleIdsOf,
  slotAccepts,
  slotsFromDefaultFitting,
  slotsFromHardpointMap,
  socketFor,
} from "./hangarFitting.js";

const ship: ShipConfig = {
  id: "ship.test",
  type: "ship",
  version: 1,
  name: "Test Ship",
  class: "light",
  core: {
    hull: { base: 100, resists: { kinetic: 0, energy: 0 } },
    engine: { nominalSpeed: 30, accel: 20, turnRate: 3 },
    power: { capacity: 15 },
    efficiency: { energyDraw: 1 },
    recharge: { multiplier: 1 },
    energyStore: { multiplier: 1 },
    sensors: { lockRange: 60, lockTimeSec: 1.5, coneDeg: 70 },
  },
  upgradeTracks: { hull: "upgrade.hull-std", engine: "upgrade.engine-std", energy: "upgrade.energy-std" },
  sockets: [
    { id: "hp-nose", kind: "hardpoint", transform: { pos: [0, 0, 1] }, accepts: ["laser", "kinetic"] },
    { id: "hp-core", kind: "hardpoint", transform: { pos: [0, 0, 0] }, accepts: ["shield"] },
    { id: "eng-l", kind: "emitter", transform: { pos: [0, 0, -1] }, effect: "fx.engine-trail", bindings: [] },
  ],
  defaultFitting: ["module.laser-mk1", "module.shield-mk1"],
  render: { recipe: "procedural.arrowhead", palette: { primary: "#123456" } },
  collider: { shape: "circle", radius: 1 },
};

describe("hangarFitting slot grid", () => {
  it("builds slots from defaultFitting positionally, skipping the emitter socket", () => {
    const slots = slotsFromDefaultFitting(ship);
    expect(slots).toHaveLength(2); // only hardpoint sockets, not the emitter
    expect(slots[0]).toMatchObject({ hardpointIndex: 0, socketId: "hp-nose", moduleId: "module.laser-mk1" });
    expect(slots[1]).toMatchObject({ hardpointIndex: 1, socketId: "hp-core", moduleId: "module.shield-mk1" });
  });

  it("builds slots from a hardpointMap, treating a missing index as empty", () => {
    const slots = slotsFromHardpointMap(ship, { "0": "module.kinetic-mk1" });
    expect(slots[0]!.moduleId).toBe("module.kinetic-mk1");
    expect(slots[1]!.moduleId).toBeNull();
  });

  it("round-trips slots -> hardpointMap -> slots", () => {
    const slots = slotsFromDefaultFitting(ship);
    const map = buildHardpointMap(slots);
    expect(map).toEqual({ "0": "module.laser-mk1", "1": "module.shield-mk1" });
    const roundTripped = slotsFromHardpointMap(ship, map);
    expect(roundTripped).toEqual(slots);
  });

  it("omits empty slots from the built hardpointMap", () => {
    const slots = slotsFromHardpointMap(ship, undefined);
    slots[1]!.moduleId = "module.shield-mk1"; // fit only the second slot
    expect(buildHardpointMap(slots)).toEqual({ "1": "module.shield-mk1" });
  });

  it("extracts fitted module ids in hardpoint order, nulls for empty slots", () => {
    const slots = slotsFromHardpointMap(ship, { "1": "module.shield-mk1" });
    expect(fittedModuleIdsOf(slots)).toEqual([null, "module.shield-mk1"]);
  });

  it("checks whether a slot accepts a module family", () => {
    const slots = slotsFromDefaultFitting(ship);
    expect(slotAccepts(slots[0]!, "laser")).toBe(true);
    expect(slotAccepts(slots[0]!, "shield")).toBe(false);
    expect(slotAccepts(slots[1]!, "shield")).toBe(true);
  });

  it("drops stale entries from a STORED loadout rather than showing an illegal fit", () => {
    // The shapes a loadout stored against an OLDER socket layout arrives in: an
    // entry past the end, and an entry whose family this slot refuses because
    // the indices shifted under it. Both must read as an empty slot — showing
    // them would put the module in the Hangar and then throw at spawn.
    const familyOf = (id: string): ModuleFamily | undefined =>
      id === "module.shield-mk1" ? "shield" : id === "module.laser-mk1" ? "laser" : undefined;
    const slots = slotsFromHardpointMap(
      ship,
      { "0": "module.shield-mk1", "1": "module.laser-mk1", "2": "module.laser-mk1" },
      familyOf,
    );
    expect(slots).toHaveLength(2); // the third entry has no socket at all
    expect(slots[0]!.moduleId).toBeNull(); // hp-nose refuses a shield
    expect(slots[1]!.moduleId).toBeNull(); // hp-core refuses a laser
  });

  it("keeps a stored loadout whose entries still fit, and a module the pack no longer ships is dropped", () => {
    const familyOf = (id: string): ModuleFamily | undefined => (id === "module.laser-mk1" ? "laser" : undefined);
    const slots = slotsFromHardpointMap(ship, { "0": "module.laser-mk1", "1": "module.deleted-mk9" }, familyOf);
    expect(slots[0]!.moduleId).toBe("module.laser-mk1");
    expect(slots[1]!.moduleId).toBeNull();
  });

  it("takes a map on trust when no family lookup is supplied (an in-memory map cannot have shifted)", () => {
    const slots = slotsFromHardpointMap(ship, { "0": "module.shield-mk1" });
    expect(slots[0]!.moduleId).toBe("module.shield-mk1");
  });

  it("looks up the hardpoint socket for a given index", () => {
    expect(socketFor(ship, 0)?.id).toBe("hp-nose");
    expect(socketFor(ship, 1)?.id).toBe("hp-core");
    expect(socketFor(ship, 5)).toBeUndefined();
  });
});

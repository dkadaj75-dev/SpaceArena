import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { hardpointsOf, shipSchema, type ShipConfig } from "@space-arena/shared";
import {
  canDeleteSocket, deleteSocket, duplicateSocket, fittedSlotIndexOf, roundMarkerValue,
  setSocketTransform, socketLabel, uniqueSocketId,
} from "./socketEditOps.js";

function repoFile(relative: string): string {
  for (const prefix of ["", "..", "../.."]) {
    const candidate = resolve(process.cwd(), prefix, relative);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`cannot locate ${relative} from ${process.cwd()}`);
}

function shippedShip(name = "interceptor"): ShipConfig {
  return shipSchema.parse(JSON.parse(readFileSync(repoFile(`content/ships/${name}.json`), "utf8")));
}

describe("uniqueSocketId", () => {
  it("returns the base when free and a deterministic suffix when not", () => {
    expect(uniqueSocketId(new Set(), "hp-a")).toBe("hp-a");
    expect(uniqueSocketId(new Set(["hp-a"]), "hp-a")).toBe("hp-a-2");
    expect(uniqueSocketId(new Set(["hp-a", "hp-a-2"]), "hp-a")).toBe("hp-a-3");
  });
});

describe("fittedSlotIndexOf", () => {
  it("counts internals too — they share the fitting's index space", () => {
    // The regression this replaces: the retired editor counted only
    // `kind: "hardpoint"`, which predates the systems bay. On the shipped
    // interceptor (hardpoint, hardpoint, internal×5, hardpoint, emitter×4) that
    // put the third hardpoint at fitted slot 2 instead of 7 — so a duplicate or
    // a delete rewrote the wrong `defaultFitting` entry.
    const ship = shippedShip();
    expect(ship.sockets.map((socket) => socket.kind)).toEqual([
      "hardpoint", "hardpoint", "internal", "internal", "internal", "internal", "internal", "hardpoint",
      "emitter", "emitter", "emitter", "emitter",
    ]);
    expect(fittedSlotIndexOf(ship, 0)).toBe(0);
    expect(fittedSlotIndexOf(ship, 6)).toBe(6);
    expect(fittedSlotIndexOf(ship, 7)).toBe(7);
    // Emitters take no fitting at all.
    expect(fittedSlotIndexOf(ship, 8)).toBe(-1);
    // And the count agrees with the shared helper the sim uses.
    expect(hardpointsOf(ship)).toHaveLength(8);
  });

  it("labels fittable sockets by slot and everything else by bare id", () => {
    const ship = shippedShip();
    expect(socketLabel(ship, 0)).toBe(`#0 ${ship.sockets[0]!.id}`);
    expect(socketLabel(ship, 8)).toBe(ship.sockets[8]!.id);
  });
});

describe("duplicateSocket", () => {
  it("inserts after the original with a unique id and keeps the fitting aligned", () => {
    const ship = shippedShip();
    const next = duplicateSocket(ship, 0);

    expect(next.sockets).toHaveLength(ship.sockets.length + 1);
    expect(next.sockets[1]!.id).toBe(`${ship.sockets[0]!.id}-copy`);
    // Slot 0's module is duplicated into the new slot 1; everything after shifts.
    expect(next.defaultFitting[0]).toBe(ship.defaultFitting[0]);
    expect(next.defaultFitting[1]).toBe(ship.defaultFitting[0]);
    expect(next.defaultFitting.slice(2)).toEqual(ship.defaultFitting.slice(1));
    expect(shipSchema.safeParse(next).success).toBe(true);
  });

  it("leaves the fitting alone for an emitter, which takes no slot", () => {
    const ship = shippedShip();
    const next = duplicateSocket(ship, 8);
    expect(next.defaultFitting).toEqual(ship.defaultFitting);
    expect(next.sockets).toHaveLength(ship.sockets.length + 1);
  });

  it("is a no-op on an index that names no socket", () => {
    const ship = shippedShip();
    expect(duplicateSocket(ship, 99)).toBe(ship);
  });
});

describe("deleteSocket", () => {
  it("drops the socket and its positional fitting entry", () => {
    const ship = shippedShip();
    const next = deleteSocket(ship, 2); // the first internal → fitted slot 2

    expect(next.sockets).toHaveLength(ship.sockets.length - 1);
    expect(next.sockets.find((socket) => socket.id === ship.sockets[2]!.id)).toBeUndefined();
    expect(next.defaultFitting).toEqual([...ship.defaultFitting.slice(0, 2), ...ship.defaultFitting.slice(3)]);
    expect(shipSchema.safeParse(next).success).toBe(true);
  });

  it("refuses to delete the last hardpoint instead of writing an invalid draft", () => {
    const ship = shippedShip();
    // Strip down to a single hardpoint; the schema requires at least one.
    const lean = shipSchema.parse({
      ...structuredClone(ship),
      sockets: [ship.sockets[0]!, ship.sockets[8]!],
      defaultFitting: [ship.defaultFitting[0]!],
    });
    expect(canDeleteSocket(lean, 0)).toBe(false);
    expect(deleteSocket(lean, 0)).toBe(lean);
    // The emitter beside it is still removable.
    expect(canDeleteSocket(lean, 1)).toBe(true);
    expect(deleteSocket(lean, 1).sockets).toHaveLength(1);
  });
});

describe("setSocketTransform", () => {
  it("writes pos, and omits rot/scale that carry no information", () => {
    const ship = shippedShip();
    const next = setSocketTransform(ship, 0, { pos: [1, 2, 3], rot: [0, 0, 0], scale: 1 });
    expect(next.sockets[0]!.transform).toEqual({ pos: [1, 2, 3] });
    // A socket that never authored `rot`/`scale` must not gain them (and so must
    // not dirty the draft) merely by being selected and released.
    expect(shipSchema.safeParse(next).success).toBe(true);
  });

  it("keeps a rotation or scale that is actually set", () => {
    const ship = shippedShip();
    const next = setSocketTransform(ship, 0, { pos: [0, 0, 0], rot: [0, 1.5, 0], scale: 2 });
    expect(next.sockets[0]!.transform).toEqual({ pos: [0, 0, 0], rot: [0, 1.5, 0], scale: 2 });
  });

  it("leaves the original untouched", () => {
    const ship = shippedShip();
    const before = structuredClone(ship.sockets[0]!.transform);
    setSocketTransform(ship, 0, { pos: [9, 9, 9] });
    expect(ship.sockets[0]!.transform).toEqual(before);
  });
});

describe("roundMarkerValue", () => {
  it("rounds float32 transform noise to four decimal places", () => {
    expect(roundMarkerValue(-0.4000000059604645)).toBe(-0.4);
    expect(roundMarkerValue(0.8294861316680908)).toBe(0.8295);
    expect(roundMarkerValue(-1.3632718324661255)).toBe(-1.3633);
  });
});

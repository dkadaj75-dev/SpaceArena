import { describe, expect, it } from "vitest";
import { hardpointsOf, emittersOf, shipSchema } from "./ship.js";
import { socketSchema } from "./socket.js";

const baseShip = {
  id: "ship.test",
  type: "ship" as const,
  version: 1,
  name: "Test",
  class: "light",
  core: {
    hull: { base: 80, resists: { kinetic: 0.1, energy: 0 } },
    engine: { nominalSpeed: 34, accel: 22, turnRate: 3 },
    energy: { capacitor: 120, regen: 14 },
    heat: { capacity: 100, dissipation: 9, criticalDamagePerSec: 4 },
  },
  upgradeTracks: { hull: "upgrade.hull-std", engine: "upgrade.engine-std", energy: "upgrade.energy-std", heat: "upgrade.heat-std" },
  defaultFitting: [],
  render: { recipe: "procedural.arrowhead" },
  collider: { shape: "circle" as const, radius: 1.4 },
};

const hp = (id: string, accepts: string[]) => ({ id, kind: "hardpoint", transform: { pos: [0, 0, 0] }, accepts });
const emitter = (id: string) => ({ id, kind: "emitter", transform: { pos: [0, 0, -1] }, effect: "fx.engine-trail", bindings: [] });

describe("socket schema + hardpointsOf", () => {
  it("derives the ordered hardpoint list (array order = hardpointIndex), skipping emitters", () => {
    const ship = shipSchema.parse({
      ...baseShip,
      sockets: [hp("a", ["laser"]), emitter("e"), hp("b", ["shield"]), hp("c", ["boost"])],
    });
    const hps = hardpointsOf(ship);
    expect(hps.map((h) => h.id)).toEqual(["a", "b", "c"]);
    expect(hps[1]!.accepts).toEqual(["shield"]); // index 1 → the shield hardpoint
    expect(emittersOf(ship).map((e) => e.id)).toEqual(["e"]);
  });

  it("rejects an unknown socket kind loudly", () => {
    const res = socketSchema.safeParse({ id: "x", kind: "wormhole", transform: { pos: [0, 0, 0] } });
    expect(res.success).toBe(false);
  });

  it("rejects duplicate socket ids", () => {
    const res = shipSchema.safeParse({ ...baseShip, sockets: [hp("dup", ["laser"]), hp("dup", ["shield"])] });
    expect(res.success).toBe(false);
  });

  it("rejects a ship with no hardpoint socket", () => {
    const res = shipSchema.safeParse({ ...baseShip, sockets: [emitter("e")] });
    expect(res.success).toBe(false);
  });

  it("defaults emitter bindings to an empty array", () => {
    const s = socketSchema.parse({ id: "e", kind: "emitter", transform: { pos: [0, 0, 0] }, effect: "fx.x" });
    expect(s.kind === "emitter" && s.bindings).toEqual([]);
  });
});

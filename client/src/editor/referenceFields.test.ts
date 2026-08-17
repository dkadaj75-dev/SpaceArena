import { describe, expect, it } from "vitest";
import { CONFIG_TYPES, collectReferences, type AnyConfig } from "@space-arena/shared";
import { REFERENCE_PATHS, referenceKey, referenceTypesFor } from "./referenceFields.js";

describe("referenceKey", () => {
  it("collapses array indices so one rule covers every element", () => {
    expect(referenceKey(["bots", "roster", "0", "profile"])).toBe("bots.roster.*.profile");
    expect(referenceKey(["defaultFitting", "12"])).toBe("defaultFitting.*");
    expect(referenceKey(["upgradeTracks", "hull"])).toBe("upgradeTracks.hull");
  });
});

describe("referenceTypesFor", () => {
  it("resolves nested and array-element references, not just top-level property names", () => {
    expect(referenceTypesFor("gamemode", ["bots", "roster", "3", "ship"])).toEqual(["ship"]);
    expect(referenceTypesFor("gamemode", ["bots", "shipPool", "0"])).toEqual(["ship"]);
    expect(referenceTypesFor("arena", ["propPlacements", "7", "propId"])).toEqual(["prop"]);
    expect(referenceTypesFor("ship", ["sockets", "2", "effect"])).toEqual(["effect"]);
    expect(referenceTypesFor("asteroid", ["states", "0", "onEnter", "1"])).toEqual(["action"]);
  });

  it("scopes rules to the owning config type", () => {
    // `arena` means a gamemode's default arena, but a tutorial has one too and
    // a ship has none — the same leaf name must not leak across types.
    expect(referenceTypesFor("gamemode", ["defaultArena"])).toEqual(["arena"]);
    expect(referenceTypesFor("tutorial", ["arena"])).toEqual(["arena"]);
    expect(referenceTypesFor("ship", ["arena"])).toBeNull();
    expect(referenceTypesFor(undefined, ["defaultArena"])).toBeNull();
  });

  it("reports both catalogues for a polymorphic reference", () => {
    expect(referenceTypesFor("cosmetic", ["target"])).toEqual(["ship", "module"]);
  });

  it("lets a caller describe a shape the shipped table does not know", () => {
    expect(referenceTypesFor("ship", ["someField"], { someField: "module" })).toEqual(["module"]);
  });
});

describe("REFERENCE_PATHS coverage", () => {
  it("names only real config types on both sides of every rule", () => {
    for (const [owner, rules] of Object.entries(REFERENCE_PATHS)) {
      expect(CONFIG_TYPES).toContain(owner);
      for (const expects of Object.values(rules)) {
        for (const type of typeof expects === "string" ? [expects] : expects) expect(CONFIG_TYPES).toContain(type);
      }
    }
  });

  it("covers every reference the pack loader itself enforces", () => {
    // `collectReferences` is the authority on what a dangling id breaks; each of
    // its paths must have a picker, or a designer is left typing ids by hand.
    const samples: AnyConfig[] = [
      {
        id: "ship.x", type: "ship", version: 1, class: "interceptor",
        core: {
          hull: { base: 1, resists: { kinetic: 0, energy: 0 } },
          engine: { nominalSpeed: 1, accel: 1, turnRate: 1 },
          cooling: { multiplier: 1 }, recharge: { multiplier: 1 },
          heatStore: { multiplier: 1 }, energyStore: { multiplier: 1 },
          power: { capacity: 0 }, efficiency: { energyDraw: 0, heatGen: 0 },
          sensors: { lockRange: 1, lockTimeSec: 1, coneDeg: 1 },
        },
        upgradeTracks: { hull: "upgrade.h", engine: "upgrade.e", energy: "upgrade.n", heat: "upgrade.t" },
        sockets: [{ id: "em", kind: "emitter", effect: "fx.trail", bindings: [], transform: { pos: [0, 0, 0] } }],
        defaultFitting: ["module.a"], render: { recipe: "r" }, collider: { shape: "circle", radius: 1 },
      },
      { id: "module.x", type: "module", version: 1, onFire: ["action.a"], onOverheat: ["action.b"], onActivate: ["action.c"], onDeactivate: ["action.d"] },
      {
        id: "arena.x", type: "arena", version: 1, bounds: { shape: "sphere", radius: 10 },
        asteroidPlacements: [{ asteroidId: "asteroid.a", position: { x: 0, z: 0 } }],
        propPlacements: [{ propId: "prop.a", position: { x: 0, z: 0 } }],
        spawnPoints: [{ id: "s", team: 0, position: { x: 0, z: 0 }, heading: 0 }],
        render: { boundaryShield: { warningNotification: "notification.n" } },
      },
      { id: "event.x", type: "event", version: 1, actions: ["action.a"] },
      { id: "notification.x", type: "notification", version: 1, triggerEvent: "event.e" },
      {
        id: "gamemode.x", type: "gamemode", version: 1, defaultArena: "arena.a",
        bots: { defaultProfile: "bot.p", defaultShip: "ship.s", roster: [{ profile: "bot.q", ship: "ship.t", team: 0 }] },
      },
      {
        id: "tutorial.x", type: "tutorial", version: 1, gamemode: "gamemode.g", arena: "arena.a",
        pilot: { ship: "ship.s", fitting: ["module.m"] },
        steps: [{ spawn: { ship: "ship.s", profile: "bot.p", fitting: ["module.m"] } }],
      },
      { id: "cosmetic.x", type: "cosmetic", version: 1, target: "ship.s" },
      { id: "theme.x", type: "theme", version: 1, hud: { flight: { fire: { blockedNotification: "notification.n" } } } },
    ] as unknown as AnyConfig[];

    const uncovered: string[] = [];
    for (const config of samples) {
      for (const ref of collectReferences(config)) {
        // collectReferences reports `a[0].b`; the form generator walks `a.0.b`.
        const path = ref.path.replace(/\[(\d+)]/g, ".$1").split(".");
        const types = referenceTypesFor(config.type, path);
        if (!types?.includes(ref.expects)) uncovered.push(`${config.type}: ${ref.path} → ${ref.expects}`);
      }
    }
    // `action.params.notification` lives in a free-form record and renders as
    // the JSON escape hatch, so it is knowingly outside the picker's reach.
    expect(uncovered).toEqual([]);
  });
});

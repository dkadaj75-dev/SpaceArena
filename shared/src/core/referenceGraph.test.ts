import { describe, expect, it } from "vitest";

import { collectReferences, type AnyConfig } from "../schemas/index.js";
import { loadTestConfigs } from "../sim/testutil.js";
import { ConfigService, type ConfigError } from "./ConfigService.js";

/**
 * ROADMAP §11 6.1 — "reference resolution (dangling refs)".
 *
 * `ConfigService.test.ts` already proves the mechanism on ONE edge
 * (`arena.asteroidPlacements[i].asteroidId`, load + replace). This file proves it
 * on EVERY reference edge `collectReferences` knows about, so adding a new
 * cross-reference to a schema without teaching the resolver about it shows up as
 * a failure here rather than as a runtime crash on a bad content pack.
 */

// --------------------------------------------------------------------------
// A tiny but complete in-memory content pack exercising every reference edge
// --------------------------------------------------------------------------

const upgradeOf = (id: string, track: string) => ({
  id,
  type: "upgrade",
  version: 1,
  track,
  levels: [{ level: 1, price: 0 }],
});

const moduleOf = (id: string, family: string, hooks: Record<string, string[]> = {}) => ({
  id,
  type: "module",
  version: 1,
  family,
  level: 1,
  activation: { deployTime: 0, retractTime: 0 },
  ui: { icon: "i", label: "l" },
  price: 0,
  requiresLevel: 1,
  ...hooks,
});

/** Every file of the pack, keyed by the path the manifest lists it under. */
function pack(): Record<string, Record<string, unknown>> {
  return {
    "manifest.json": {
      id: "manifest.ref",
      type: "manifest",
      version: 1,
      files: [
        "fx.json",
        "u-hull.json",
        "u-engine.json",
        "u-energy.json",
        "m-laser.json",
        "m-shield.json",
        "ship.json",
        "asteroid.json",
        "arena.json",
        "notification.json",
        "action-sound.json",
        "action-notify.json",
        "event.json",
        "bot.json",
        "gamemode.json",
      ],
    },
    "fx.json": {
      id: "fx.trail",
      type: "effect",
      version: 1,
      base: {
        capacity: 100,
        emitRate: 20,
        lifeMin: 0.1,
        lifeMax: 0.3,
        sizeMin: 0.1,
        sizeMax: 0.2,
        speedMin: 1,
        speedMax: 2,
        color1: "#fff",
        color2: "#000",
      },
      params: ["emitRate"],
    },
    "u-hull.json": upgradeOf("upgrade.hull", "hull"),
    "u-engine.json": upgradeOf("upgrade.engine", "engine"),
    "u-energy.json": upgradeOf("upgrade.energy", "energy"),
    "m-laser.json": moduleOf("module.laserx", "laser", {
      onFire: ["action.sound"],
    }),
    "m-shield.json": moduleOf("module.shieldx", "shield", {
      onActivate: ["action.sound"],
      onDeactivate: ["action.sound"],
    }),
    "ship.json": {
      id: "ship.ref",
      type: "ship",
      version: 1,
      class: "light",
      core: {
        hull: { base: 80, resists: { kinetic: 0.1, energy: 0 } },
        engine: { nominalSpeed: 34, accel: 22, turnRate: 3 },
        sensors: { lockRange: 60, lockTimeSec: 1.5, coneDeg: 70 },
      },
      upgradeTracks: {
        hull: "upgrade.hull",
        engine: "upgrade.engine",
        energy: "upgrade.energy",
      },
      sockets: [
        { id: "hp0", kind: "hardpoint", transform: { pos: [0, 0, 1] }, accepts: ["laser"] },
        { id: "hp1", kind: "hardpoint", transform: { pos: [0, 0, -1] }, accepts: ["shield"] },
        { id: "e0", kind: "emitter", transform: { pos: [0, 0, -2] }, effect: "fx.trail", bindings: [] },
      ],
      defaultFitting: ["module.laserx", "module.shieldx"],
      render: { recipe: "procedural.arrowhead" },
      collider: { shape: "circle", radius: 1.4 },
    },
    "asteroid.json": {
      id: "asteroid.rock",
      type: "asteroid",
      version: 1,
      radius: 3,
      destructible: true,
      impactDamage: 5,
      render: { recipe: "procedural.rock" },
    },
    "arena.json": {
      id: "arena.ref",
      type: "arena",
      version: 1,
      bounds: { shape: "sphere", radius: 50 },
      asteroidPlacements: [{ asteroidId: "asteroid.rock", position: { x: 0, z: 0 } }],
      spawnPoints: [{ id: "s1", team: 0, position: { x: -10, z: 0 }, heading: 0 }],
      render: {
        skybox: { texture: "skyboxes/ref.webp", intensity: 0.8, tint: "#ffffff" },
        boundaryShield: {
          baseOpacity: 0.02,
          glowStartDistance: 20,
          redTransitionDistance: 8,
          warnDistance: 12,
          blueColor: "#39bfff",
          redColor: "#ff405c",
          hexDensity: 24,
          hexLineWidth: 0.012,
          warningNotification: "notification.boundary",
        },
      },
    },
    "notification.json": {
      id: "notification.boundary",
      type: "notification",
      version: 1,
      text: "Turn back",
      style: "warning",
      durationMs: 2000,
      triggerEvent: "event.boundary",
    },
    "action-sound.json": { id: "action.sound", type: "action", version: 1, kind: "play_sound", params: { sound: "beep" } },
    "action-notify.json": {
      id: "action.notify",
      type: "action",
      version: 1,
      kind: "show_notification",
      params: { notification: "notification.boundary" },
    },
    "event.json": { id: "event.boundary", type: "event", version: 1, trigger: "on_shield_down", actions: ["action.notify", "action.sound"] },
    "bot.json": {
      id: "bot.ref",
      type: "botprofile",
      version: 1,
      decisionIntervalMs: 400,
      orderJitterMs: 0,
      preferredRange: [10, 20],
      behaviors: { engage: { baseWeight: 1 } },
      moduleDiscipline: { energyReserve: 0.1, shieldOnlyWhenEngaged: false },
    },
    "gamemode.json": {
      id: "gamemode.ref",
      type: "gamemode",
      version: 1,
      teams: "1v1",
      defaultArena: "arena.ref",
      winCondition: { type: "destroyTargets", count: 1 },
      respawn: { enabled: false, delay: 0 },
      boundaryRule: { type: "warning" },
      rewards: { win: 0, loss: 0, perKill: 0 },
      bots: {
        defaultProfile: "bot.ref",
        defaultShip: "ship.ref",
        roster: [{ profile: "bot.ref", ship: "ship.ref", team: 1 }],
      },
    },
  };
}

function memLoader(files: Record<string, unknown>) {
  return (path: string): Promise<unknown> =>
    path in files ? Promise.resolve(files[path]) : Promise.reject(new Error(`not found: ${path}`));
}

/** Load a pack after applying `mutate` to it, and return the load errors. */
async function loadWith(mutate: (files: Record<string, Record<string, unknown>>) => void): Promise<{ ok: boolean; errors: ConfigError[] }> {
  const files = pack();
  mutate(files);
  const svc = new ConfigService(memLoader(files));
  const result = await svc.load("manifest.json");
  return { ok: result.ok, errors: result.errors };
}

/** Assert the load failed with exactly one dangling-reference error at `path`. */
async function expectDangling(
  path: string,
  missingId: string,
  mutate: (files: Record<string, Record<string, unknown>>) => void,
): Promise<void> {
  const { ok, errors } = await loadWith(mutate);
  expect(ok).toBe(false);
  const dangling = errors.filter((e) => e.message.includes("dangling reference"));
  expect(dangling.map((e) => e.path)).toEqual([path]);
  expect(dangling[0]!.message).toContain(`"${missingId}"`);
}

// --------------------------------------------------------------------------

describe("reference resolution — the reference-clean baseline", () => {
  it("loads a pack whose every cross-reference resolves", async () => {
    const svc = new ConfigService(memLoader(pack()));
    const result = await svc.load("manifest.json");
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.counts).toMatchObject({ ship: 1, module: 2, upgrade: 3, arena: 1, gamemode: 1 });
  });
});

describe("reference resolution — ship edges", () => {
  it("flags a dangling upgrade track", async () => {
    await expectDangling("upgradeTracks.energy", "upgrade.ghost", (f) => {
      (f["ship.json"]!["upgradeTracks"] as Record<string, string>)["energy"] = "upgrade.ghost";
    });
  });

  it("flags a dangling defaultFitting entry at its index", async () => {
    await expectDangling("defaultFitting[1]", "module.ghost", (f) => {
      f["ship.json"]!["defaultFitting"] = ["module.laserx", "module.ghost"];
    });
  });

  it("flags a dangling emitter effect at its socket index", async () => {
    await expectDangling("sockets[2].effect", "fx.ghost", (f) => {
      (f["ship.json"]!["sockets"] as Array<Record<string, unknown>>)[2]!["effect"] = "fx.ghost";
    });
  });
});

describe("reference resolution — module action hooks", () => {
  it.each([
    ["onFire", "m-laser.json"],
    ["onActivate", "m-shield.json"],
    ["onDeactivate", "m-shield.json"],
  ])("flags a dangling %s hook", async (hook, file) => {
    await expectDangling(`${hook}[0]`, "action.ghost", (f) => {
      f[file]![hook] = ["action.ghost"];
    });
  });
});

describe("reference resolution — arena / action / event / notification edges", () => {
  it("flags a dangling asteroid placement", async () => {
    await expectDangling("asteroidPlacements[0].asteroidId", "asteroid.ghost", (f) => {
      f["arena.json"]!["asteroidPlacements"] = [{ asteroidId: "asteroid.ghost", position: { x: 0, z: 0 } }];
    });
  });

  it("flags a dangling boundary warning notification", async () => {
    await expectDangling(
      "render.boundaryShield.warningNotification",
      "notification.ghost",
      (f) => {
        const render = f["arena.json"]!["render"] as {
          boundaryShield: Record<string, unknown>;
        };
        render.boundaryShield["warningNotification"] = "notification.ghost";
      },
    );
  });

  it("flags a dangling notification id inside an action's free-form params", async () => {
    await expectDangling("params.notification", "notification.ghost", (f) => {
      f["action-notify.json"]!["params"] = { notification: "notification.ghost" };
    });
  });

  it("flags a dangling action in an event's action list, at its index", async () => {
    await expectDangling("actions[1]", "action.ghost", (f) => {
      f["event.json"]!["actions"] = ["action.notify", "action.ghost"];
    });
  });

  it("flags a dangling triggerEvent on a notification", async () => {
    await expectDangling("triggerEvent", "event.ghost", (f) => {
      f["notification.json"]!["triggerEvent"] = "event.ghost";
    });
  });

  it("ignores non-string params (a numeric `notification` is not a reference)", async () => {
    const { ok } = await loadWith((f) => {
      f["action-notify.json"]!["params"] = { notification: 42 };
    });
    expect(ok).toBe(true);
  });
});

describe("reference resolution — gamemode bots graph (5.1)", () => {
  it("flags a dangling defaultArena", async () => {
    await expectDangling("defaultArena", "arena.ghost", (f) => {
      f["gamemode.json"]!["defaultArena"] = "arena.ghost";
    });
  });

  it.each([
    ["bots.defaultProfile", "defaultProfile", "bot.ghost"],
    ["bots.defaultShip", "defaultShip", "ship.ghost"],
  ])("flags a dangling %s", async (path, key, ghost) => {
    await expectDangling(path, ghost, (f) => {
      (f["gamemode.json"]!["bots"] as Record<string, unknown>)[key] = ghost;
    });
  });

  it("flags dangling roster entries at their slot index", async () => {
    await expectDangling("bots.roster[1].profile", "bot.ghost", (f) => {
      (f["gamemode.json"]!["bots"] as Record<string, unknown>)["roster"] = [
        { profile: "bot.ref", team: 1 },
        { profile: "bot.ghost", team: 1 },
      ];
    });
    await expectDangling("bots.roster[0].ship", "ship.ghost", (f) => {
      (f["gamemode.json"]!["bots"] as Record<string, unknown>)["roster"] = [{ profile: "bot.ref", ship: "ship.ghost", team: 1 }];
    });
  });

  it("reports every dangling edge at once rather than stopping at the first", async () => {
    const { ok, errors } = await loadWith((f) => {
      f["gamemode.json"]!["defaultArena"] = "arena.ghost";
      (f["gamemode.json"]!["bots"] as Record<string, unknown>)["defaultProfile"] = "bot.ghost";
      f["ship.json"]!["defaultFitting"] = ["module.ghost", "module.shieldx"];
    });
    expect(ok).toBe(false);
    const paths = errors.filter((e) => e.message.includes("dangling reference")).map((e) => e.path).sort();
    expect(paths).toEqual(["bots.defaultProfile", "defaultArena", "defaultFitting[0]"]);
  });
});

describe("reference resolution — replace() re-checks the outgoing edges", () => {
  it("rejects a hot-reloaded gamemode whose bot roster points at a ghost profile", async () => {
    const svc = new ConfigService(memLoader(pack()));
    expect((await svc.load("manifest.json")).ok).toBe(true);

    const before = svc.get("gamemode", "gamemode.ref");
    const res = svc.replace({
      ...(pack()["gamemode.json"] as Record<string, unknown>),
      bots: { defaultProfile: "bot.ghost", roster: [{ profile: "bot.ref", team: 1 }] },
    });
    expect(res.ok).toBe(false);
    expect(res.errors[0]?.path).toBe("bots.defaultProfile");
    expect(svc.get("gamemode", "gamemode.ref")).toBe(before); // registry untouched
  });

  it("accepts a hot-reloaded config whose new edges all resolve", async () => {
    const svc = new ConfigService(memLoader(pack()));
    await svc.load("manifest.json");
    const res = svc.replace({
      ...(pack()["m-laser.json"] as Record<string, unknown>),
      onFire: ["action.notify"],
    });
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
  });
});

// --------------------------------------------------------------------------
// Type-checked references: an id that EXISTS but is the wrong kind of config
// must be a load/replace error, not a silent runtime `undefined` (e.g.
// resolveShipStats doing get("upgrade", "module.laser-mk1")).
// --------------------------------------------------------------------------

/** Assert the load failed with exactly one type-mismatch error at `path`. */
async function expectTypeMismatch(
  path: string,
  wrongId: string,
  actualType: string,
  expectedType: string,
  mutate: (files: Record<string, Record<string, unknown>>) => void,
): Promise<void> {
  const { ok, errors } = await loadWith(mutate);
  expect(ok).toBe(false);
  const mismatches = errors.filter((e) => e.message.includes("reference type mismatch"));
  expect(mismatches.map((e) => e.path)).toEqual([path]);
  expect(mismatches[0]!.message).toContain(`"${wrongId}" is a ${actualType} config, expected ${expectedType}`);
}

describe("reference resolution — wrong-type references are load errors", () => {
  it("flags a ship upgrade track pointing at a module", async () => {
    await expectTypeMismatch("upgradeTracks.hull", "module.laserx", "module", "upgrade", (f) => {
      (f["ship.json"]!["upgradeTracks"] as Record<string, string>)["hull"] = "module.laserx";
    });
  });

  it("flags a defaultFitting entry pointing at an upgrade", async () => {
    await expectTypeMismatch("defaultFitting[0]", "upgrade.hull", "upgrade", "module", (f) => {
      f["ship.json"]!["defaultFitting"] = ["upgrade.hull"];
    });
  });

  it("flags an emitter socket pointing at an action instead of an effect", async () => {
    await expectTypeMismatch("sockets[2].effect", "action.sound", "action", "effect", (f) => {
      (f["ship.json"]!["sockets"] as Array<Record<string, unknown>>)[2]!["effect"] = "action.sound";
    });
  });

  it("flags a gamemode bot profile pointing at a ship", async () => {
    await expectTypeMismatch("bots.defaultProfile", "ship.ref", "ship", "botprofile", (f) => {
      (f["gamemode.json"]!["bots"] as Record<string, unknown>)["defaultProfile"] = "ship.ref";
    });
  });

  it("flags a bot roster ship slot pointing at a botprofile", async () => {
    await expectTypeMismatch("bots.roster[0].ship", "bot.ref", "botprofile", "ship", (f) => {
      const bots = f["gamemode.json"]!["bots"] as { roster: Array<Record<string, unknown>> };
      bots.roster[0]!["ship"] = "bot.ref";
    });
  });

  it("flags an event action pointing at a notification", async () => {
    await expectTypeMismatch("actions[0]", "notification.boundary", "notification", "action", (f) => {
      f["event.json"]!["actions"] = ["notification.boundary"];
    });
  });

  it("replace() rejects a wrong-type edge against the live registry", async () => {
    const svc = new ConfigService(memLoader(pack()));
    expect((await svc.load("manifest.json")).ok).toBe(true);

    const before = svc.get("module", "module.laserx");
    const res = svc.replace({
      ...(pack()["m-laser.json"] as Record<string, unknown>),
      onFire: ["notification.boundary"],
    });
    expect(res.ok).toBe(false);
    expect(res.errors[0]?.path).toBe("onFire[0]");
    expect(res.errors[0]?.message).toContain('"notification.boundary" is a notification config, expected action');
    expect(svc.get("module", "module.laserx")).toBe(before);
  });
});

describe("reference resolution — the shipped content pack", () => {
  it("has no unresolved or wrong-type reference anywhere in content/", async () => {
    const configs = await loadTestConfigs();
    const problems: string[] = [];
    for (const type of ["ship", "module", "arena", "action", "event", "notification", "gamemode"] as const) {
      for (const config of configs.getAll<AnyConfig>(type)) {
        for (const ref of collectReferences(config)) {
          const actual = configs.typeOf(ref.id);
          if (!actual) problems.push(`${config.id} → ${ref.path} = ${ref.id} (missing)`);
          else if (actual !== ref.expects) problems.push(`${config.id} → ${ref.path} = ${ref.id} (${actual}, expected ${ref.expects})`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});

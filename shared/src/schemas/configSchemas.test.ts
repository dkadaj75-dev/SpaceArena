import { describe, expect, it } from "vitest";

import {
  COMBAT_MULT_MAX,
  COMBAT_MULT_MIN,
  CONFIG_SCHEMAS,
  CONFIG_TYPES,
  collectReferences,
  collectRelationalErrors,
  manifestSchema,
  PURSUIT_ZOOM_MAX,
  PURSUIT_ZOOM_MIN,
  validateConfig,
  type AnyConfig,
  type ConfigType,
} from "./index.js";
import { QUALITY_TIERS } from "./quality.js";
import { encodeFloat32Array, encodeUint32Array } from "../collision/base64.js";

/**
 * ROADMAP §11 6.1 — "all schemas (valid/invalid/edge fixtures)".
 *
 * Structure:
 *  1. `VALID` holds one canonical, minimal-but-complete fixture per config type.
 *     A coverage guard asserts the map stays in lockstep with {@link CONFIG_TYPES},
 *     so adding a schema without a fixture fails here rather than silently
 *     shipping untested.
 *  2. Generic laws every config obeys (base shape, `type` discrimination) run as
 *     a table over that map.
 *  3. Per-type `describe`s cover the invalid + edge cases specific to each schema.
 *
 * Deliberately NOT duplicated here (already covered elsewhere, kept green):
 *  - ship socket graph ordering / duplicate socket ids  → `socket.test.ts`
 *  - theme hud cluster + orientation + haptics blocks   → `client/.../ThemeEditor.test.ts`
 *  - `ship.defaultFitting` vs hardpoints (relational)   → `core/ConfigService.test.ts`
 *  - dangling-reference resolution end to end           → `core/referenceGraph.test.ts`
 */

// --------------------------------------------------------------------------
// 1. Canonical valid fixtures
// --------------------------------------------------------------------------

/** Deep-ish clone so a mutation in one test can never leak into another. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const ship = {
  id: "ship.fixture",
  type: "ship",
  version: 1,
  name: "Fixture",
  class: "light",
  core: {
    hull: { base: 80, resists: { kinetic: 0.1, energy: 0 } },
    engine: { nominalSpeed: 34, accel: 22, turnRate: 3 },
    sensors: { lockRange: 60, lockTimeSec: 1.5, coneDeg: 70 },
  },
  upgradeTracks: {
    hull: "upgrade.hull-std",
    engine: "upgrade.engine-std",
    energy: "upgrade.energy-std",
  },
  sockets: [
    { id: "hp-nose", kind: "hardpoint", transform: { pos: [0, 0, 1.8] }, accepts: ["laser", "kinetic"] },
    { id: "hp-core", kind: "hardpoint", transform: { pos: [0, 0.3, 0] }, accepts: ["shield"] },
    {
      id: "eng-l",
      kind: "emitter",
      transform: { pos: [-0.4, 0, -1.9] },
      effect: "fx.engine-trail",
      bindings: [{ source: "throttle", param: "emitRate", curve: [[0, 0], [1, 120]] }],
    },
  ],
  defaultFitting: ["module.fixture-laser", "module.fixture-shield"],
  render: { recipe: "procedural.arrowhead" },
  collider: { shape: "circle", radius: 1.4 },
};

const module_ = {
  id: "module.fixture-laser",
  type: "module",
  version: 1,
  family: "laser",
  level: 1,
  name: "Fixture Laser",
  activation: { deployTime: 1.5, retractTime: 1 },
  fire: {
    mode: "held",
    range: 38,
    cycleTime: 0.4,
    damage: 7,
    damageType: "energy",
    requiresLineOfSight: true,
    projectile: null,
  },
  onFire: ["action.fixture-sound"],
  ui: { icon: "[ICON: laser]", label: "Laser" },
  price: 0,
  requiresLevel: 1,
};

const effect = {
  id: "fx.fixture",
  type: "effect",
  version: 1,
  base: {
    capacity: 200,
    emitRate: 60,
    lifeMin: 0.2,
    lifeMax: 0.6,
    sizeMin: 0.1,
    sizeMax: 0.4,
    speedMin: 1,
    speedMax: 4,
    color1: "#ffffff",
    color2: "#000000",
  },
  params: ["emitRate", "sizeMax"],
};

const upgrade = {
  id: "upgrade.fixture",
  type: "upgrade",
  version: 1,
  track: "hull",
  levels: [
    { level: 1, price: 0 },
    { level: 2, price: 100, add: { "hull.base": 15 } },
    { level: 3, price: 250, add: { "hull.base": 35 }, mul: { "hull.base": 1.05 } },
  ],
};

const arena = {
  id: "arena.fixture",
  type: "arena",
  version: 1,
  bounds: { shape: "sphere", radius: 90 },
  asteroidPlacements: [{ asteroidId: "asteroid.fixture", position: { x: 10, z: -4 } }],
  spawnPoints: [{ id: "s0", team: 0, position: { x: -30, z: 0 }, heading: 0 }],
  render: {
    skybox: { texture: "skyboxes/fixture.webp", intensity: 0.8, tint: "#ffffff" },
    boundaryShield: {
      baseOpacity: 0.02,
      glowStartDistance: 30,
      redTransitionDistance: 10,
      warnDistance: 20,
      blueColor: "#39bfff",
      redColor: "#ff405c",
      hexDensity: 30,
      hexLineWidth: 0.012,
      warningNotification: "notification.fixture",
    },
  },
};

const asteroid = {
  id: "asteroid.fixture",
  type: "asteroid",
  version: 1,
  radius: 3.5,
  destructible: true,
  impactDamage: 6,
  render: { recipe: "procedural.rock" },
};

const prop = {
  id: "prop.fixture",
  type: "prop",
  version: 1,
  category: "structure",
  impactDamage: 5,
  render: { recipe: "model.static", model: "props/fixture.glb" },
  collision: {
    positions: encodeFloat32Array(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])),
    indices: encodeUint32Array(new Uint32Array([0, 1, 2])),
    bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 } },
  },
};

const gamemode = {
  id: "gamemode.fixture",
  type: "gamemode",
  version: 1,
  teams: "1v1",
  winCondition: { type: "destroyTargets", count: 3 },
  respawn: { enabled: true, delay: 3 },
  boundaryRule: { type: "warning", graceSeconds: 3 },
  rewards: { win: 100, loss: 25, perKill: 10 },
};

const camera = {
  id: "camera.fixture",
  type: "camera",
  version: 1,
  alpha: { default: 0 },
  beta: { min: 0.6, max: 1.1, default: 0.9 },
  radius: { min: 30, max: 90, default: 55 },
  followLag: 0.2,
};

const tuning = {
  id: "tuning.fixture",
  type: "tuning",
  version: 1,
  targetingPolicy: "nearest",
  globalDamageMult: 1,
};

const action = {
  id: "action.fixture-sound",
  type: "action",
  version: 1,
  kind: "play_sound",
  params: { sound: "laser_fire" },
};

const event = {
  id: "event.fixture",
  type: "event",
  version: 1,
  trigger: "on_shield_down",
  actions: ["action.fixture-sound"],
};

const notification = {
  id: "notification.fixture",
  type: "notification",
  version: 1,
  text: "Shield down!",
  style: "warning",
  durationMs: 2500,
};

const theme = {
  id: "theme.fixture",
  type: "theme",
  version: 1,
  colors: { "--hud-primary": "#57d8ff" },
};

const progression = {
  id: "progression.fixture",
  type: "progression",
  version: 1,
  xpCurve: [0, 100, 250],
  rewards: { perKill: 10, win: 100, loss: 25 },
};

const botprofile = {
  id: "bot.fixture",
  type: "botprofile",
  version: 1,
  decisionIntervalMs: 400,
  orderJitterMs: 80,
  preferredRange: [18, 32],
  behaviors: { engage: { baseWeight: 1, doubleTapBoostChance: 0.3 } },
  moduleDiscipline: {
    energyReserve: 0.15,
    shieldOnlyWhenEngaged: true,
  },
};

const quality = {
  id: "quality.fixture",
  type: "quality",
  version: 1,
  tier: "med",
  probe: { minCores: 4, minMemoryGb: 4, allowMobile: true },
  autoTier: { sampleAfterMs: 2000, sampleWindowMs: 3000, demoteBelowFps: 25, promoteAboveFps: 55 },
  render: { hardwareScalingMultiplier: 1, maxDevicePixelRatio: 2, freezeStatics: true },
  glow: { enabled: true, intensity: 0.6 },
  particles: { enabled: true, budgetMultiplier: 0.7, maxEmitterCapacity: 400 },
  asteroids: { lodMediumDistance: 60, lodLowDistance: 120, lodCullDistance: 0 },
  projectiles: { useInstances: true },
  scene: {
    skyboxEnabled: true,
    boundaryShieldShader: true,
    starfieldPoints: 1500,
    spawnMarkers: true,
  },
};

const cosmetic = {
  id: "cosmetic.paint-fixture",
  type: "cosmetic",
  version: 1,
  name: "Fixture Paint",
  kind: "paint",
  price: 0,
  target: "ship.fixture-hull",
  elements: {
    body: { color: "#112233", finish: { gloss: 0.7 } },
    wings: { texture: "texture.fixture-plate", color: "#445566" },
    propulsion: { effect: "fx.fixture-trail" },
  },
};

const texture = {
  id: "texture.fixture-plate",
  type: "texture",
  version: 1,
  name: "Fixture Plate",
  source: "textures/fixture-plate.jpg",
  scale: 3,
};

const tutorial = {
  id: "tutorial.fixture",
  type: "tutorial",
  version: 1,
  gamemode: "gamemode.fixture-mode",
  pilot: { ship: "ship.fixture-hull", fitting: ["module.fixture-laser"] },
  completeToast: "Done.",
  steps: [
    {
      id: "throttle",
      stage: "flight",
      title: "THROTTLE",
      text: "Push the lever up.",
      condition: { kind: "throttle-above", value: 0.5 },
    },
  ],
};

/** One canonical valid fixture per content type. Keys MUST cover CONFIG_TYPES. */
const VALID: Record<ConfigType, Record<string, unknown>> = {
  ship,
  module: module_,
  effect,
  upgrade,
  arena,
  asteroid,
  gamemode,
  camera,
  tuning,
  action,
  event,
  notification,
  theme,
  progression,
  prop,
  botprofile,
  quality,
  cosmetic,
  texture,
  tutorial,
};

/** Parse `fixture` with the schema registered for `type`. */
function parses(type: ConfigType, fixture: unknown): boolean {
  return CONFIG_SCHEMAS[type].safeParse(fixture).success;
}

/** Apply `mutate` to a clone of the canonical fixture and report parse success. */
function mutated(type: ConfigType, mutate: (draft: Record<string, unknown>) => void): boolean {
  const draft = clone(VALID[type]);
  mutate(draft);
  return parses(type, draft);
}

// --------------------------------------------------------------------------
// 2. Generic laws — every schema, driven off the fixture table
// --------------------------------------------------------------------------

describe("schema fixture coverage", () => {
  it("has a valid fixture for every registered config type", () => {
    expect(Object.keys(VALID).sort()).toEqual([...CONFIG_TYPES].sort());
  });

  it("registers exactly the types in the AnyConfig union (manifest excluded)", () => {
    expect(CONFIG_TYPES).not.toContain("manifest" as ConfigType);
    expect(CONFIG_TYPES.length).toBe(Object.keys(CONFIG_SCHEMAS).length);
  });
});

describe.each(CONFIG_TYPES)("%s schema — base laws", (type) => {
  it("accepts the canonical fixture through validateConfig", () => {
    const result = validateConfig(clone(VALID[type]));
    expect(result.success).toBe(true);
    expect(result.type).toBe(type);
  });

  it("rejects ids that break the `type.slug` convention", () => {
    for (const bad of ["nodot", "Ship.Fixture", "ship.", ".fixture", "ship.-lead", "1ship.x", ""]) {
      expect(mutated(type, (d) => (d["id"] = bad))).toBe(false);
    }
  });

  it("rejects a non-positive or fractional version", () => {
    expect(mutated(type, (d) => (d["version"] = 0))).toBe(false);
    expect(mutated(type, (d) => (d["version"] = -1))).toBe(false);
    expect(mutated(type, (d) => (d["version"] = 1.5))).toBe(false);
  });

  it("rejects a missing/foreign type literal", () => {
    expect(mutated(type, (d) => delete d["type"])).toBe(false);
    const foreign: ConfigType = type === "ship" ? "module" : "ship";
    expect(mutated(type, (d) => (d["type"] = foreign))).toBe(false);
  });

  it("accepts the optional `name` and tolerates its absence", () => {
    expect(mutated(type, (d) => delete d["name"])).toBe(true);
    expect(mutated(type, (d) => (d["name"] = "Renamed"))).toBe(true);
    expect(mutated(type, (d) => (d["name"] = 7))).toBe(false);
  });
});

describe("validateConfig dispatcher", () => {
  it("refuses non-objects", () => {
    for (const bad of [null, undefined, 42, "ship", true, [ship]]) {
      const r = validateConfig(bad);
      expect(r.success).toBe(false);
      expect(r.type).toBeNull();
    }
  });

  it("refuses an unknown or missing type discriminator with a readable message", () => {
    const unknown = validateConfig({ id: "x.y", type: "wormhole", version: 1 });
    expect(unknown.success).toBe(false);
    expect(unknown.success === false && unknown.message).toContain("unknown or missing config type");

    const missing = validateConfig({ id: "x.y", version: 1 });
    expect(missing.success).toBe(false);
  });

  it("returns the zod error (not a message) for a type-known but malformed config", () => {
    const r = validateConfig({ ...clone(camera), followLag: 9 });
    expect(r.success).toBe(false);
    expect(r.success === false && r.type).toBe("camera");
    expect(r.success === false && r.error?.issues.length).toBeGreaterThan(0);
  });
});

// --------------------------------------------------------------------------
// 3. Per-type invalid + edge cases
// --------------------------------------------------------------------------

describe("ship schema", () => {
  it("rejects non-positive core stats", () => {
    expect(mutated("ship", (d) => ((d["core"] as Record<string, Record<string, number>>)["hull"]!["base"] = 0))).toBe(false);
    expect(
      mutated("ship", (d) => {
        const core = d["core"] as Record<string, Record<string, number>>;
        core["engine"]!["nominalSpeed"] = -1;
      }),
    ).toBe(false);
    // Hull-wide energy levers are MULTIPLIERS since 2026-08-07: zero would mean
    // "this hull never refills a tank", which is not a legal hull.
    expect(
      mutated("ship", (d) => {
        const core = d["core"] as Record<string, Record<string, number>>;
        core["energyStore"] = { multiplier: -1 };
      }),
    ).toBe(false);
  });

  it("requires a positive sensor suite (FLIGHT.md §2 lock stats)", () => {
    const sensors = (d: Record<string, unknown>) =>
      (d["core"] as { sensors: Record<string, number> }).sensors;
    expect(parses("ship", clone(ship))).toBe(true);
    expect(mutated("ship", (d) => delete (d["core"] as Record<string, unknown>)["sensors"])).toBe(false);
    for (const key of ["lockRange", "lockTimeSec", "coneDeg"]) {
      expect(mutated("ship", (d) => (sensors(d)[key] = 0))).toBe(false);
      expect(mutated("ship", (d) => (sensors(d)[key] = -1))).toBe(false);
      expect(mutated("ship", (d) => delete sensors(d)[key])).toBe(false);
    }
    // Fractional values are legal: lock time and cone width are continuous knobs.
    expect(mutated("ship", (d) => (sensors(d)["lockTimeSec"] = 0.75))).toBe(true);
    expect(mutated("ship", (d) => (sensors(d)["coneDeg"] = 42.5))).toBe(true);
  });

  it("caps resists at 0.95 and floors them at 0", () => {
    const setResist = (v: number) => (d: Record<string, unknown>) => {
      const core = d["core"] as { hull: { resists: Record<string, number> } };
      core.hull.resists["kinetic"] = v;
    };
    expect(mutated("ship", setResist(0.95))).toBe(true);
    expect(mutated("ship", setResist(0))).toBe(true);
    expect(mutated("ship", setResist(0.96))).toBe(false);
    expect(mutated("ship", setResist(-0.01))).toBe(false);
  });

  it("requires all three upgrade tracks", () => {
    for (const track of ["hull", "engine", "energy"]) {
      expect(mutated("ship", (d) => delete (d["upgradeTracks"] as Record<string, unknown>)[track])).toBe(false);
    }
  });

  it("refuses a hull with more fittable sockets than the trigger mask can address", () => {
    // 16 bits on the wire, so slot 16 has no bit to fire it with. A hull that
    // built and flew with an untriggerable gun is exactly the failure this
    // stops, and it has to stop it at load.
    const socket = (i: number) => ({
      id: `hp-${i}`,
      kind: "hardpoint",
      transform: { pos: [0, 0, i] },
      accepts: ["laser"],
    });
    const withSockets = (n: number) => (d: Record<string, unknown>) => {
      d["sockets"] = Array.from({ length: n }, (_, i) => socket(i));
      d["defaultFitting"] = [];
    };
    expect(mutated("ship", withSockets(16))).toBe(true);
    expect(mutated("ship", withSockets(17))).toBe(false);
  });

  it("requires at least one socket and rejects zero-radius colliders", () => {
    expect(mutated("ship", (d) => (d["sockets"] = []))).toBe(false);
    expect(mutated("ship", (d) => ((d["collider"] as Record<string, number>)["radius"] = 0))).toBe(false);
  });

  it("accepts an empty defaultFitting and a GLB render override (edge)", () => {
    expect(mutated("ship", (d) => (d["defaultFitting"] = []))).toBe(true);
    expect(
      mutated("ship", (d) => {
        d["render"] = { recipe: "procedural.arrowhead", model: "ships/LShip01.glb", modelScale: 1.2, modelRotationY: Math.PI };
      }),
    ).toBe(true);
    expect(
      mutated("ship", (d) => {
        d["render"] = { recipe: "procedural.arrowhead", modelScale: 0 };
      }),
    ).toBe(false);
  });

  it("takes a pursuit zoom inside the authorable band and rejects one outside it", () => {
    const withZoom = (pursuitZoom: unknown) => (d: Record<string, unknown>) => {
      d["render"] = { recipe: "procedural.arrowhead", model: "ships/LShip01.glb", modelScale: 1.2, pursuitZoom };
    };
    expect(mutated("ship", withZoom(PURSUIT_ZOOM_MIN))).toBe(true);
    expect(mutated("ship", withZoom(PURSUIT_ZOOM_MAX))).toBe(true);
    expect(mutated("ship", withZoom(PURSUIT_ZOOM_MIN - 0.01))).toBe(false);
    expect(mutated("ship", withZoom(PURSUIT_ZOOM_MAX + 0.01))).toBe(false);
  });

  it("takes a partial combat role profile and holds every knob in the band", () => {
    const withCombat = (combat: unknown) => (d: Record<string, unknown>) => {
      (d["core"] as Record<string, unknown>)["combat"] = combat;
    };
    // Absent entirely, and every sub-block optional: a hull states only the
    // knobs it has an opinion about.
    expect(mutated("ship", withCombat(undefined))).toBe(true);
    expect(mutated("ship", withCombat({}))).toBe(true);
    expect(mutated("ship", withCombat({ damageOutput: { kinetic: 1.5 } }))).toBe(true);
    expect(mutated("ship", withCombat({ rateOfFire: { hybrid: COMBAT_MULT_MAX }, shieldEfficiency: COMBAT_MULT_MIN }))).toBe(true);

    expect(mutated("ship", withCombat({ damageOutput: { kinetic: COMBAT_MULT_MAX + 0.01 } }))).toBe(false);
    expect(mutated("ship", withCombat({ rateOfFire: { energy: COMBAT_MULT_MIN - 0.01 } }))).toBe(false);
    expect(mutated("ship", withCombat({ shieldEfficiency: 0 }))).toBe(false);
    // Strict blocks: `hybrid` is a rate-of-fire bucket only — a composite type
    // has no damage of its own, so an authored hybrid OUTPUT is a mistake.
    expect(mutated("ship", withCombat({ damageOutput: { hybrid: 2 } }))).toBe(false);
    expect(mutated("ship", withCombat({ shieldRegen: 2 }))).toBe(false);
  });

  it("rejects an emitter binding on an unknown signal or an empty curve", () => {
    const patchBinding = (binding: unknown) => (d: Record<string, unknown>) => {
      const sockets = d["sockets"] as Array<Record<string, unknown>>;
      sockets[2]!["bindings"] = [binding];
    };
    expect(mutated("ship", patchBinding({ source: "warpCharge", param: "emitRate", curve: [[0, 0]] }))).toBe(false);
    expect(mutated("ship", patchBinding({ source: "throttle", param: "", curve: [[0, 0]] }))).toBe(false);
    expect(mutated("ship", patchBinding({ source: "throttle", param: "emitRate", curve: [] }))).toBe(false);
  });
});

describe("module schema", () => {
  it("rejects an unknown family and a non-positive level", () => {
    expect(mutated("module", (d) => (d["family"] = "tractor"))).toBe(false);
    expect(mutated("module", (d) => (d["level"] = 0))).toBe(false);
    expect(mutated("module", (d) => (d["level"] = 1.5))).toBe(false);
  });

  it("rejects negative activation, and refuses to price a weapon in energy", () => {
    expect(mutated("module", (d) => ((d["activation"] as Record<string, number>)["deployTime"] = -0.1))).toBe(false);
    // A weapon is limited by `fire.cycleTime` and by nothing else (heat deleted
    // 2026-08-20), so an energy block on one is an authoring mistake.
    expect(
      mutated("module", (d) => (d["energy"] = { capacity: 10, rechargePerSec: 1, drawPerSec: 1 })),
    ).toBe(false);
  });

  it("accepts instant activation (0s deploy + retract) as an edge", () => {
    expect(mutated("module", (d) => (d["activation"] = { deployTime: 0, retractTime: 0 }))).toBe(true);
  });

  it("treats `fire.projectile: null` as hitscan and validates travelling ordnance", () => {
    expect(parses("module", clone(module_))).toBe(true); // projectile: null
    expect(
      mutated("module", (d) => {
        (d["fire"] as Record<string, unknown>)["projectile"] = { speed: 40, turnRate: 2.2, lifetime: 4 };
      }),
    ).toBe(true);
    expect(
      mutated("module", (d) => {
        (d["fire"] as Record<string, unknown>)["projectile"] = { speed: 0, lifetime: 4 };
      }),
    ).toBe(false);
    expect(
      mutated("module", (d) => {
        (d["fire"] as Record<string, unknown>)["projectile"] = { speed: 40, lifetime: 0 };
      }),
    ).toBe(false);
  });

  it("rejects an unknown fire mode, damage type or non-positive range/cycle", () => {
    const patchFire = (patch: Record<string, unknown>) => (d: Record<string, unknown>) => {
      d["fire"] = { ...(d["fire"] as Record<string, unknown>), ...patch };
    };
    expect(mutated("module", patchFire({ mode: "manual" }))).toBe(false);
    expect(mutated("module", patchFire({ mode: "autoTarget" }))).toBe(false);
    expect(mutated("module", patchFire({ mode: "semi" }))).toBe(true);
    expect(mutated("module", patchFire({ damageType: "plasma" }))).toBe(false);
    expect(mutated("module", patchFire({ range: 0 }))).toBe(false);
    expect(mutated("module", patchFire({ cycleTime: 0 }))).toBe(false);
    expect(mutated("module", patchFire({ damage: 0 }))).toBe(true); // 0 damage is legal (utility beam)
  });

  it("validates discrete-weapon clips and their bounds", () => {
    const clip = (value: unknown) => (d: Record<string, unknown>) => {
      (d["fire"] as Record<string, unknown>)["clip"] = value;
    };
    expect(mutated("module", clip({ size: 20, reloadSec: 1 }))).toBe(true);
    expect(mutated("module", clip({ size: 50, reloadSec: 3 }))).toBe(true);
    expect(mutated("module", clip({ size: 19, reloadSec: 2 }))).toBe(false);
    expect(mutated("module", clip({ size: 20.5, reloadSec: 2 }))).toBe(false);
    expect(mutated("module", clip({ size: 30, reloadSec: 3.1 }))).toBe(false);
    expect(mutated("module", (d) => {
      (d["fire"] as Record<string, unknown>)["mode"] = "continuous";
      (d["fire"] as Record<string, unknown>)["clip"] = { size: 30, reloadSec: 2 };
    })).toBe(false);
  });

  it("accepts `continuous` only as a hitscan channel, and still requires a cycleTime", () => {
    const patchFire = (patch: Record<string, unknown>) => (d: Record<string, unknown>) => {
      d["fire"] = { ...(d["fire"] as Record<string, unknown>), ...patch };
    };
    // The fixture is `projectile: null`, so `continuous` is legal.
    expect(mutated("module", patchFire({ mode: "continuous" }))).toBe(true);
    // A channel has no discrete shot to launch ordnance with — refined away.
    expect(
      mutated("module", patchFire({ mode: "continuous", projectile: { speed: 40, lifetime: 4 } })),
    ).toBe(false);
    // `cycleTime` is semantically ignored for a channel but stays REQUIRED and
    // positive, so the field remains a plain number for SchemaFormGen and for
    // every consumer that reads it.
    expect(
      mutated("module", (d) => {
        const fire: Record<string, unknown> = { ...(d["fire"] as Record<string, unknown>), mode: "continuous" };
        delete fire["cycleTime"];
        d["fire"] = fire;
      }),
    ).toBe(false);
  });

  it("validates the mitigation and boost blocks", () => {
    const withBlock = (key: string, value: unknown) => (d: Record<string, unknown>) => {
      delete d["fire"];
      d[key] = value;
    };
    // A shield's reserve IS an energy tank, so mitigation requires one.
    const withShield = (mitigation: unknown) => (d: Record<string, unknown>) => {
      delete d["fire"];
      d["energy"] = { capacity: 40, rechargePerSec: 4, drawPerSec: 4 };
      d["mitigation"] = mitigation;
    };
    expect(mutated("module", withShield({ damageReduction: 0.5, coversFamilies: ["kinetic", "energy"] }))).toBe(true);
    expect(mutated("module", withShield({ damageReduction: 1 }))).toBe(true);
    expect(mutated("module", withShield({ damageReduction: 1.01 }))).toBe(false);
    expect(mutated("module", withShield({ damageReduction: 0.5, coversFamilies: ["thermal"] }))).toBe(false);
    expect(mutated("module", withBlock("mitigation", { damageReduction: 0.5 }))).toBe(false); // no tank
    // The collapse cooldown is designer-tunable but RANGE-BOUND (2026-08-18):
    // under 5 s a collapse is a stutter the pilot taps through, over 15 s it
    // removes the module for the rest of the fight. The schema is where that
    // judgement lives, so an out-of-range author fails at content-load time
    // rather than shipping a shield nobody can play around.
    expect(mutated("module", withShield({ damageReduction: 0.5, collapseCooldownSec: 5 }))).toBe(true);
    expect(mutated("module", withShield({ damageReduction: 0.5, collapseCooldownSec: 15 }))).toBe(true);
    expect(mutated("module", withShield({ damageReduction: 0.5, collapseCooldownSec: 4.9 }))).toBe(false);
    expect(mutated("module", withShield({ damageReduction: 0.5, collapseCooldownSec: 15.1 }))).toBe(false);
    // Omitting it is legal and lands on the shipped 8 s, so an existing shield
    // needs no edit to acquire the rule.
    const defaulted = clone(VALID["module"]) as Record<string, unknown>;
    withShield({ damageReduction: 0.5 })(defaulted);
    const parsed = CONFIG_SCHEMAS["module"].safeParse(defaulted);
    expect(parsed.success).toBe(true);
    expect(
      parsed.success ? (parsed.data as { mitigation?: { collapseCooldownSec: number } }).mitigation : undefined,
    ).toMatchObject({ collapseCooldownSec: 8 });
    // A boost block belongs to the ENGINE that provides it (2026-07-31), so the
    // family has to move with it.
    const withBoost = (boost: unknown) => (d: Record<string, unknown>) => {
      delete d["fire"];
      d["family"] = "engine";
      d["activation"] = { deployTime: 0, retractTime: 0 };
      d["energy"] = { capacity: 60, rechargePerSec: 8, drawPerSec: 20 };
      d["boost"] = boost;
    };
    expect(mutated("module", withBoost({ speedMult: 1.8 }))).toBe(true);
    expect(mutated("module", withBoost({ speedMult: 0.9 }))).toBe(false); // must be ≥ 1
    // …and stays refused on a family that cannot provide one.
    expect(mutated("module", withBlock("boost", { speedMult: 1.8 }))).toBe(false);
  });

  it("validates passive stat ops (utility modules)", () => {
    const withPassives = (passives: unknown) => (d: Record<string, unknown>) => (d["passives"] = passives);
    expect(mutated("module", withPassives([{ target: "energyStore.multiplier", op: "mul", value: 1.3 }]))).toBe(true);
    expect(mutated("module", withPassives([{ target: "core.recharge.multiplier", op: "mul", value: 1.1 }]))).toBe(true);
    expect(mutated("module", withPassives([{ target: "recharge.multiplier", op: "sub", value: 1 }]))).toBe(false);
    expect(mutated("module", withPassives([{ target: "", op: "add", value: 1 }]))).toBe(false);
    expect(mutated("module", withPassives([]))).toBe(true);
  });

  it("rejects a fractional price or a non-positive requiresLevel", () => {
    expect(mutated("module", (d) => (d["price"] = 10.5))).toBe(false);
    expect(mutated("module", (d) => (d["price"] = -1))).toBe(false);
    expect(mutated("module", (d) => (d["requiresLevel"] = 0))).toBe(false);
  });

  it("accepts a 1-12 character HUD short name and rejects empty or oversized values", () => {
    expect(mutated("module", (d) => ((d["ui"] as Record<string, unknown>)["shortName"] = "Laser Mk1"))).toBe(true);
    expect(mutated("module", (d) => ((d["ui"] as Record<string, unknown>)["shortName"] = ""))).toBe(false);
    expect(mutated("module", (d) => ((d["ui"] as Record<string, unknown>)["shortName"] = "ThirteenChars!"))).toBe(false);
  });
});

describe("effect schema", () => {
  it("requires a positive capacity and a params list", () => {
    expect(mutated("effect", (d) => ((d["base"] as Record<string, number>)["capacity"] = 0))).toBe(false);
    expect(mutated("effect", (d) => ((d["base"] as Record<string, number>)["capacity"] = 10.5))).toBe(false);
    expect(mutated("effect", (d) => delete d["params"])).toBe(false);
    expect(mutated("effect", (d) => (d["params"] = []))).toBe(true); // nothing bindable is legal
  });

  it("accepts optional direction/gravity and a sound id (edge)", () => {
    expect(
      mutated("effect", (d) => {
        const base = d["base"] as Record<string, unknown>;
        base["direction"] = [0, 1, 0];
        base["gravity"] = -2;
        d["sound"] = "[SOUND: explosion_ship]";
      }),
    ).toBe(true);
    expect(mutated("effect", (d) => (d["sound"] = ""))).toBe(false);
    expect(mutated("effect", (d) => ((d["base"] as Record<string, unknown>)["direction"] = [0, 1]))).toBe(false);
  });
});

describe("upgrade schema", () => {
  it("rejects an unknown track and an empty level list", () => {
    expect(mutated("upgrade", (d) => (d["track"] = "shields"))).toBe(false);
    expect(mutated("upgrade", (d) => (d["levels"] = []))).toBe(false);
  });

  it("rejects non-positive level numbers and negative/fractional prices", () => {
    expect(mutated("upgrade", (d) => (d["levels"] = [{ level: 0, price: 0 }]))).toBe(false);
    expect(mutated("upgrade", (d) => (d["levels"] = [{ level: 1, price: -1 }]))).toBe(false);
    expect(mutated("upgrade", (d) => (d["levels"] = [{ level: 1, price: 1.5 }]))).toBe(false);
  });

  it("accepts add-only, mul-only and combined level ops (edge)", () => {
    expect(mutated("upgrade", (d) => (d["levels"] = [{ level: 1, price: 0, add: { "hull.base": 10 } }]))).toBe(true);
    expect(mutated("upgrade", (d) => (d["levels"] = [{ level: 1, price: 0, mul: { "hull.base": 1.1 } }]))).toBe(true);
    expect(mutated("upgrade", (d) => (d["levels"] = [{ level: 1, price: 0, add: {}, mul: {} }]))).toBe(true);
    expect(mutated("upgrade", (d) => (d["levels"] = [{ level: 1, price: 0, add: { "hull.base": "x" } }]))).toBe(false);
  });
});

describe("arena schema", () => {
  it("accepts both bounds shapes and rejects unknown/degenerate ones", () => {
    expect(
      mutated("arena", (d) => (d["bounds"] = { shape: "rect", width: 120, height: 80, verticalExtent: 60 })),
    ).toBe(true);
    expect(mutated("arena", (d) => (d["bounds"] = { shape: "rect", width: 120, height: 80 }))).toBe(false);
    expect(mutated("arena", (d) => (d["bounds"] = { shape: "sphere", radius: 0 }))).toBe(false);
    expect(mutated("arena", (d) => (d["bounds"] = { shape: "hex", radius: 90 }))).toBe(false);
    expect(mutated("arena", (d) => (d["bounds"] = { shape: "rect", width: 120 }))).toBe(false);
    // `circle` is RETIRED, not deprecated (BUBBLE.md): an arena still authored
    // flat must fail loudly rather than silently losing its bounds.
    expect(mutated("arena", (d) => (d["bounds"] = { shape: "circle", radius: 90 }))).toBe(false);
  });

  it("accepts a sphere floor in (-radius, 0] and rejects unsupported planes", () => {
    expect(mutated("arena", (d) => (d["bounds"] = { shape: "sphere", radius: 90, floorY: -30 }))).toBe(true);
    expect(mutated("arena", (d) => (d["bounds"] = { shape: "sphere", radius: 90, floorY: 0 }))).toBe(true);
    expect(mutated("arena", (d) => (d["bounds"] = { shape: "sphere", radius: 90, floorY: -90 }))).toBe(false);
    expect(mutated("arena", (d) => (d["bounds"] = { shape: "sphere", radius: 90, floorY: -91 }))).toBe(false);
    expect(mutated("arena", (d) => (d["bounds"] = { shape: "sphere", radius: 90, floorY: 1 }))).toBe(false);
  });

  it("rejects a spawn below a sphere floor", () => {
    expect(
      mutated("arena", (d) => {
        d["bounds"] = { shape: "sphere", radius: 90, floorY: -30 };
        d["spawnPoints"] = [{ id: "s0", team: 0, position: { x: 0, y: -30, z: 0 }, heading: 0 }];
      }),
    ).toBe(true);
    expect(
      mutated("arena", (d) => {
        d["bounds"] = { shape: "sphere", radius: 90, floorY: -30 };
        d["spawnPoints"] = [{ id: "s0", team: 0, position: { x: 0, y: -30.01, z: 0 }, heading: 0 }];
      }),
    ).toBe(false);
  });

  it("takes optional y on placements and spawns, and an optional spawn pitch", () => {
    expect(
      mutated("arena", (d) => {
        d["asteroidPlacements"] = [{ asteroidId: "asteroid.fixture", position: { x: 10, y: -18, z: -4 } }];
        d["spawnPoints"] = [{ id: "s0", team: 0, position: { x: -30, y: 24, z: 0 }, heading: 0, pitch: -0.4 }];
      }),
    ).toBe(true);
    // Omitted everywhere is the flat arena that shipped before the bubble.
    expect(
      mutated("arena", (d) => {
        d["spawnPoints"] = [{ id: "s0", team: 0, position: { x: -30, z: 0 }, heading: 0 }];
      }),
    ).toBe(true);
    expect(
      mutated("arena", (d) => {
        d["spawnPoints"] = [{ id: "s0", team: 0, position: { x: -30, y: "high", z: 0 }, heading: 0 }];
      }),
    ).toBe(false);
    for (const pitch of [-Math.PI / 2, Math.PI / 2, -4, 4]) {
      expect(
        mutated("arena", (d) => {
          (d["spawnPoints"] as Array<Record<string, unknown>>)[0]!["pitch"] = pitch;
        }),
      ).toBe(false);
    }
  });

  /**
   * `render.skybox.sun` promotes the star PAINTED INTO the panorama to the
   * arena's key light, so its direction is authored data that has to match the
   * artwork. The unit-length check exists to catch a typo in that vector.
   */
  it("accepts an authored painted-star sun and rejects a non-unit direction", () => {
    const withSun = (sun: unknown) => (d: Record<string, unknown>) => {
      const render = d["render"] as Record<string, unknown>;
      d["render"] = { ...render, skybox: { ...(render["skybox"] as Record<string, unknown>), sun } };
    };
    expect(mutated("arena", withSun({ dir: [0.777, 0.309, 0.55], color: "#ffecc8", intensity: 1.1 }))).toBe(true);
    expect(mutated("arena", withSun({ dir: [-0.677, -0.208, -0.706], color: "#dce4ff", intensity: 1 }))).toBe(true);
    // Absent is legal — an arena whose sky has no recognizable star keeps the
    // generic light rig.
    expect(mutated("arena", withSun(undefined))).toBe(true);
    // Not a unit vector: an author who typed 7.77 instead of 0.777 must be told.
    expect(mutated("arena", withSun({ dir: [7.77, 3.09, 5.5], color: "#fff", intensity: 1 }))).toBe(false);
    expect(mutated("arena", withSun({ dir: [0, 0, 0], color: "#fff", intensity: 1 }))).toBe(false);
    expect(mutated("arena", withSun({ dir: [1, 0, 0], color: "#fff", intensity: 0 }))).toBe(true);
    expect(mutated("arena", withSun({ dir: [1, 0, 0], color: "#fff", intensity: -1 }))).toBe(false);
    // Shape errors: wrong arity, missing colour.
    expect(mutated("arena", withSun({ dir: [1, 0], color: "#fff", intensity: 1 }))).toBe(false);
    expect(mutated("arena", withSun({ dir: [1, 0, 0], intensity: 1 }))).toBe(false);
    expect(mutated("arena", withSun({ dir: [1, 0, 0], color: "", intensity: 1 }))).toBe(false);
  });

  it("keeps bounds, projectile overshoot, and spawns inside the deci-wire envelope", () => {
    expect(mutated("arena", (d) => (d["bounds"] = { shape: "sphere", radius: 4000 }))).toBe(false);
    expect(mutated("arena", (d) => (d["bounds"] = { shape: "sphere", radius: 3076.7 }))).toBe(true);
    expect(
      mutated("arena", (d) => {
        d["spawnPoints"] = [{ id: "s0", team: 0, position: { x: 91, y: 0, z: 0 }, heading: 0 }];
      }),
    ).toBe(false);
    expect(
      mutated("arena", (d) => {
        d["bounds"] = { shape: "rect", width: 120, height: 80, verticalExtent: 60 };
        d["spawnPoints"] = [{ id: "s0", team: 0, position: { x: 0, y: 31, z: 0 }, heading: 0 }];
      }),
    ).toBe(false);
  });

  it("requires at least one spawn point with a non-negative integer team", () => {
    expect(mutated("arena", (d) => (d["spawnPoints"] = []))).toBe(false);
    expect(
      mutated("arena", (d) => {
        (d["spawnPoints"] as Array<Record<string, unknown>>)[0]!["team"] = -1;
      }),
    ).toBe(false);
    expect(
      mutated("arena", (d) => {
        (d["spawnPoints"] as Array<Record<string, unknown>>)[0]!["team"] = 1.5;
      }),
    ).toBe(false);
  });

  it("accepts an empty asteroid list, lighting, arena render knobs and zones (edge)", () => {
    expect(mutated("arena", (d) => (d["asteroidPlacements"] = []))).toBe(true);
    expect(
      mutated("arena", (d) => {
        d["lighting"] = { ambientColor: "#101820", ambientIntensity: 0.4, directionalIntensity: 1.2 };
        d["render"] = clone(arena.render);
        d["zones"] = [{ id: "z0", shape: "circle", position: { x: 0, z: 0 }, radius: 12 }];
      }),
    ).toBe(true);
    expect(
      mutated("arena", (d) => {
        d["zones"] = [{ id: "z0", shape: "circle", position: { x: 0, z: 0 }, radius: 0 }];
      }),
    ).toBe(false);
  });

  it("rejects a placement with a non-positive scale", () => {
    expect(
      mutated("arena", (d) => {
        (d["asteroidPlacements"] as Array<Record<string, unknown>>)[0]!["scale"] = 0;
      }),
    ).toBe(false);
  });

  it("validates boundary shield threshold ordering and opacity", () => {
    expect(
      mutated("arena", (d) => {
        (d["render"] as typeof arena.render).boundaryShield.baseOpacity = 1.1;
      }),
    ).toBe(false);
    expect(
      mutated("arena", (d) => {
        (d["render"] as typeof arena.render).boundaryShield.redTransitionDistance = 31;
      }),
    ).toBe(false);
    expect(
      mutated("arena", (d) => {
        (d["render"] as typeof arena.render).boundaryShield.warnDistance = 31;
      }),
    ).toBe(false);
  });
});

describe("asteroid schema", () => {
  it("requires a positive radius, a destructible flag and non-negative impact damage", () => {
    expect(mutated("asteroid", (d) => (d["radius"] = 0))).toBe(false);
    expect(mutated("asteroid", (d) => delete d["destructible"])).toBe(false);
    expect(mutated("asteroid", (d) => (d["impactDamage"] = -1))).toBe(false);
    expect(mutated("asteroid", (d) => (d["impactDamage"] = 0))).toBe(true);
  });

  it("accepts optional hp and per-state render overrides (edge)", () => {
    expect(mutated("asteroid", (d) => (d["hp"] = 40))).toBe(true);
    expect(mutated("asteroid", (d) => (d["hp"] = 0))).toBe(false);
    expect(
      mutated("asteroid", (d) => {
        d["states"] = [{ id: "cracked", render: { recipe: "procedural.rock-cracked" }, onEnter: ["action.fixture-sound"] }];
      }),
    ).toBe(true);
  });

  it("accepts an optional render spin range and rejects inverted or negative ranges", () => {
    const setSpin = (minDegPerSec: number, maxDegPerSec: number) =>
      mutated("asteroid", (d) => {
        (d["render"] as Record<string, unknown>)["spin"] = { minDegPerSec, maxDegPerSec };
      });
    expect(setSpin(2, 8)).toBe(true);
    expect(setSpin(8, 2)).toBe(false);
    expect(setSpin(-1, 2)).toBe(false);
  });
});

describe("gamemode schema", () => {
  it("defaults eliminationEndsMatch to true when omitted (edge)", () => {
    const parsed = CONFIG_SCHEMAS.gamemode.parse(clone(gamemode));
    expect(parsed.eliminationEndsMatch).toBe(true);
    const off = CONFIG_SCHEMAS.gamemode.parse({ ...clone(gamemode), eliminationEndsMatch: false });
    expect(off.eliminationEndsMatch).toBe(false);
  });

  it("accepts every win condition and rejects unknown/degenerate ones", () => {
    expect(mutated("gamemode", (d) => (d["winCondition"] = { type: "fragLimit", count: 5 }))).toBe(true);
    expect(mutated("gamemode", (d) => (d["winCondition"] = { type: "timeLimit", seconds: 180 }))).toBe(true);
    expect(mutated("gamemode", (d) => (d["winCondition"] = { type: "destroyTargets", count: 0 }))).toBe(false);
    expect(mutated("gamemode", (d) => (d["winCondition"] = { type: "timeLimit", seconds: 0 }))).toBe(false);
    expect(mutated("gamemode", (d) => (d["winCondition"] = { type: "lastStanding" }))).toBe(false);
  });

  it("accepts every boundary rule and rejects unknown/degenerate ones", () => {
    expect(mutated("gamemode", (d) => (d["boundaryRule"] = { type: "bounce", restitution: 1 }))).toBe(true);
    expect(mutated("gamemode", (d) => (d["boundaryRule"] = { type: "bounce" }))).toBe(true);
    expect(mutated("gamemode", (d) => (d["boundaryRule"] = { type: "damage", damagePerSec: 8 }))).toBe(true);
    expect(
      mutated("gamemode", (d) => {
        d["boundaryRule"] = { type: "damageAndBounce", damagePerSec: 8, restitution: 0.8 };
      }),
    ).toBe(true);
    expect(mutated("gamemode", (d) => (d["boundaryRule"] = { type: "bounce", restitution: 1.5 }))).toBe(false);
    expect(mutated("gamemode", (d) => (d["boundaryRule"] = { type: "damage", damagePerSec: -1 }))).toBe(false);
    expect(
      mutated("gamemode", (d) => {
        d["boundaryRule"] = { type: "damageAndBounce", damagePerSec: -1, restitution: 0.8 };
      }),
    ).toBe(false);
    expect(mutated("gamemode", (d) => (d["boundaryRule"] = { type: "teleport" }))).toBe(false);
  });

  it("rejects an unsupported team layout and fractional rewards", () => {
    expect(mutated("gamemode", (d) => (d["teams"] = "2v2"))).toBe(true);
    expect(mutated("gamemode", (d) => (d["teams"] = "10v10"))).toBe(true);
    expect(mutated("gamemode", (d) => (d["teams"] = "3v3"))).toBe(false);
    expect(mutated("gamemode", (d) => ((d["rewards"] as Record<string, number>)["win"] = 10.5))).toBe(false);
    expect(mutated("gamemode", (d) => ((d["rewards"] as Record<string, number>)["perKill"] = -1))).toBe(false);
  });

  it("validates the optional bots block (5.1 roster + backfill)", () => {
    const withBots = (bots: unknown) => (d: Record<string, unknown>) => (d["bots"] = bots);
    expect(parses("gamemode", clone(gamemode))).toBe(true); // bots omitted ⇒ no bots
    expect(mutated("gamemode", withBots({ defaultProfile: "bot.fixture" }))).toBe(true);
    expect(
      mutated(
        "gamemode",
        withBots({
          defaultProfile: "bot.fixture",
          defaultShip: "ship.fixture",
          backfillWaitMs: 15000,
          roster: [{ profile: "bot.fixture", ship: "ship.fixture", team: 1, count: 2 }],
        }),
      ),
    ).toBe(true);
    expect(mutated("gamemode", withBots({ roster: [] }))).toBe(false); // defaultProfile required
    expect(mutated("gamemode", withBots({ defaultProfile: "bot.fixture", backfillWaitMs: -1 }))).toBe(false);
    expect(mutated("gamemode", withBots({ defaultProfile: "bot.fixture", roster: [{ profile: "bot.fixture", team: -1 }] }))).toBe(false);
    expect(mutated("gamemode", withBots({ defaultProfile: "bot.fixture", roster: [{ profile: "bot.fixture", team: 1, count: 0 }] }))).toBe(false);
    expect(mutated("gamemode", withBots({ defaultProfile: "bot.fixture", roster: [{ team: 1 }] }))).toBe(false); // profile required
  });

  it("rejects a negative respawn delay", () => {
    expect(mutated("gamemode", (d) => (d["respawn"] = { enabled: false, delay: -1 }))).toBe(false);
    expect(mutated("gamemode", (d) => (d["respawn"] = { enabled: false, delay: 0 }))).toBe(true);
  });
});

describe("camera schema", () => {
  it("clamps followLag to 0..1", () => {
    expect(mutated("camera", (d) => (d["followLag"] = 0))).toBe(true);
    expect(mutated("camera", (d) => (d["followLag"] = 1))).toBe(true);
    expect(mutated("camera", (d) => (d["followLag"] = 1.01))).toBe(false);
    expect(mutated("camera", (d) => (d["followLag"] = -0.01))).toBe(false);
  });

  it("accepts a fully specified shake block (5.7) and rejects degenerate fields", () => {
    const shake = {
      enabled: true,
      hitAmplitude: 0.25,
      killAmplitude: 0.6,
      durationMs: 320,
      frequencyHz: 22,
      maxAmplitude: 0.9,
      damageReference: 20,
      minDamageScale: 0.25,
    };
    expect(mutated("camera", (d) => (d["shake"] = shake))).toBe(true);
    // Only the four core numbers are required; the rest are optional.
    expect(
      mutated("camera", (d) => {
        d["shake"] = { hitAmplitude: 0.25, killAmplitude: 0.6, durationMs: 320, frequencyHz: 22, maxAmplitude: 0.9 };
      }),
    ).toBe(true);
    expect(mutated("camera", (d) => (d["shake"] = { ...shake, durationMs: 0 }))).toBe(false);
    expect(mutated("camera", (d) => (d["shake"] = { ...shake, frequencyHz: 0 }))).toBe(false);
    expect(mutated("camera", (d) => (d["shake"] = { ...shake, hitAmplitude: -0.1 }))).toBe(false);
    expect(mutated("camera", (d) => (d["shake"] = { ...shake, damageReference: 0 }))).toBe(false);
    expect(mutated("camera", (d) => (d["shake"] = { ...shake, minDamageScale: 1.5 }))).toBe(false);
    expect(mutated("camera", (d) => (d["shake"] = { hitAmplitude: 0.25 }))).toBe(false); // partial block rejected
  });

  it("accepts an editor pan block and rejects a non-positive sensitivity", () => {
    expect(mutated("camera", (d) => (d["pan"] = { sensitivity: 1 }))).toBe(true);
    expect(mutated("camera", (d) => (d["pan"] = { sensitivity: 0 }))).toBe(false);
    expect(mutated("camera", (d) => (d["pan"] = { sensitivity: -1 }))).toBe(false);
  });

  it("keeps shake and pan optional (pre-5.7 packs still load)", () => {
    expect(parses("camera", clone(camera))).toBe(true);
  });
});

describe("tuning schema", () => {
  it("requires the core balance knobs to be sane", () => {
    expect(mutated("tuning", (d) => (d["globalDamageMult"] = 0))).toBe(false);
    expect(mutated("tuning", (d) => (d["targetingPolicy"] = "random"))).toBe(false);
    for (const policy of ["nearest", "lowestHp", "attacker"]) {
      expect(mutated("tuning", (d) => (d["targetingPolicy"] = policy))).toBe(true);
    }
  });

  /**
   * The match-start countdown. `0` MUST stay legal: it is how a test fixture (and
   * the e2e smoke's tick budget) opts out of the 3-second lead-in.
   */
  it("accepts a zero match countdown and rejects a negative one", () => {
    expect(mutated("tuning", (d) => (d["matchCountdownSec"] = 3))).toBe(true);
    expect(mutated("tuning", (d) => (d["matchCountdownSec"] = 0))).toBe(true);
    expect(mutated("tuning", (d) => (d["matchCountdownSec"] = 0.5))).toBe(true);
    expect(mutated("tuning", (d) => (d["matchCountdownSec"] = -1))).toBe(false);
    expect(mutated("tuning", (d) => (d["matchCountdownSec"] = "3"))).toBe(false);
    // Absent means the documented default (3 s), not "no countdown".
    expect(mutated("tuning", (d) => delete d["matchCountdownSec"])).toBe(true);
  });

  it("accepts the full optional knob surface and rejects fractional counters (edge)", () => {
    expect(
      mutated("tuning", (d) => {
        Object.assign(d, {
          matchCountdownSec: 3,
          dragCoefficient: 0.4,
          spatialCellSize: 8,
          impactSpeedThreshold: 6,
          impactDamageCooldown: 1,
          maxTicksPerFrame: 5,
          beamFadeMs: 120,
          projectilePoolSize: 48,
          netRenderDelayMs: 100,
          netCorrectionRate: 8,
          maxOrdersPerSec: 20,
          lockDecayMult: 1.5,
          pitchRateMult: 0.8,
          maxPitchRad: 1.4,
          featureFlags: { botDebug: true },
        });
      }),
    ).toBe(true);
    expect(mutated("tuning", (d) => (d["maxTicksPerFrame"] = 5.5))).toBe(false);
    // Pitch knobs (BUBBLE.md §A): a zero rate is a legal "no pitch" pack, a zero
    // clamp is not — it would make the axis exist and do nothing.
    expect(mutated("tuning", (d) => (d["pitchRateMult"] = 0))).toBe(true);
    expect(mutated("tuning", (d) => (d["pitchRateMult"] = -0.1))).toBe(false);
    expect(mutated("tuning", (d) => (d["maxPitchRad"] = 0))).toBe(false);
    expect(mutated("tuning", (d) => (d["maxPitchRad"] = Math.PI / 2))).toBe(false);
    expect(mutated("tuning", (d) => (d["maxPitchRad"] = Math.PI))).toBe(false);
    expect(mutated("tuning", (d) => (d["projectilePoolSize"] = 0))).toBe(false);
    expect(mutated("tuning", (d) => (d["featureFlags"] = { botDebug: "yes" }))).toBe(false);
  });

  it("keeps lockDecayMult optional but strictly positive (a 0 drain would freeze locks)", () => {
    expect(parses("tuning", clone(tuning))).toBe(true); // absent ⇒ code default 1.5
    expect(mutated("tuning", (d) => (d["lockDecayMult"] = 3))).toBe(true);
    expect(mutated("tuning", (d) => (d["lockDecayMult"] = 0))).toBe(false);
    expect(mutated("tuning", (d) => (d["lockDecayMult"] = -1))).toBe(false);
  });
});

describe("action / event / notification schemas", () => {
  it("rejects an unknown action kind and keeps params free-form", () => {
    expect(mutated("action", (d) => (d["kind"] = "teleport_player"))).toBe(false);
    expect(mutated("action", (d) => delete d["params"])).toBe(true);
    expect(mutated("action", (d) => (d["params"] = { anything: { nested: [1, 2, 3] } }))).toBe(true);
    expect(mutated("action", (d) => (d["params"] = []))).toBe(false);
    for (const kind of ["apply_damage", "spawn_entity", "apply_buff", "impulse", "play_sound", "show_notification", "change_asset_state", "grant_reward"]) {
      expect(mutated("action", (d) => (d["kind"] = kind))).toBe(true);
    }
  });

  it("rejects an unknown event trigger and allows an empty action list (edge)", () => {
    expect(mutated("event", (d) => (d["trigger"] = "on_lunch_break"))).toBe(false);
    expect(mutated("event", (d) => (d["actions"] = []))).toBe(true);
    expect(mutated("event", (d) => (d["actions"] = "action.fixture-sound"))).toBe(false);
  });

  it("rejects an unknown notification style and a non-positive duration", () => {
    for (const style of ["info", "warning", "critical", "success"]) {
      expect(mutated("notification", (d) => (d["style"] = style))).toBe(true);
    }
    expect(mutated("notification", (d) => (d["style"] = "shout"))).toBe(false);
    expect(mutated("notification", (d) => (d["durationMs"] = 0))).toBe(false);
    expect(mutated("notification", (d) => (d["triggerEvent"] = "event.fixture"))).toBe(true);
  });
});

describe("theme schema — 5.7/5.8 blocks", () => {
  /**
   * `hud.gauges` / `hud.gaugeWidthPx` described the lower-left gauge panel that
   * was retired when hull and shield moved to the centre vital arcs. Nothing
   * read them, so they were dropped from the schema rather than left generating
   * dead controls in the Theme editor. A theme file that still carries them
   * must keep loading: zod strips unknown keys instead of rejecting, and this
   * pins that so the removal can never turn into a parse failure on someone's
   * un-migrated pack.
   */
  it("tolerates retired knobs an un-migrated theme still carries", () => {
    expect(mutated("theme", (d) => (d["hud"] = { ...(d["hud"] as object), gaugeWidthPx: 999 }))).toBe(true);
    expect(
      mutated("theme", (d) => (d["hud"] = { ...(d["hud"] as object), gauges: { anchor: "top-right", showHull: true, segments: 8 } })),
    ).toBe(true);
    // …and they are stripped, not carried through into the parsed config.
    const draft = clone(VALID.theme);
    draft["hud"] = { scale: 1, gaugeWidthPx: 999 };
    const parsed = CONFIG_SCHEMAS.theme.parse(draft) as { hud?: Record<string, unknown> };
    expect("gaugeWidthPx" in (parsed.hud ?? {})).toBe(false);
  });

  it("requires colors and rejects non-string color values", () => {
    expect(mutated("theme", (d) => delete d["colors"])).toBe(false);
    expect(mutated("theme", (d) => (d["colors"] = {}))).toBe(true);
    expect(mutated("theme", (d) => (d["colors"] = { "--hud-primary": 255 }))).toBe(false);
  });

  it("accepts a full audio block and clamps its volumes", () => {
    const audio = {
      enabled: true,
      defaultMasterVolume: 0.8,
      defaultSfxVolume: 0.9,
      maxVoices: 16,
      retriggerGapMs: 40,
      cues: {
        playerDamaged: "hull_hit",
        shieldAbsorb: "[SOUND: shield_absorb]",
        playerKill: "kill",
        playerDeath: "death",
        boundaryWarning: "boundary",
        fireBlocked: "fire-blocked",
      },
    };
    expect(mutated("theme", (d) => (d["audio"] = audio))).toBe(true);
    expect(mutated("theme", (d) => (d["audio"] = {}))).toBe(true); // every field optional
    expect(mutated("theme", (d) => (d["audio"] = { ...audio, defaultMasterVolume: 1.5 }))).toBe(false);
    expect(mutated("theme", (d) => (d["audio"] = { ...audio, defaultSfxVolume: -0.1 }))).toBe(false);
    expect(mutated("theme", (d) => (d["audio"] = { ...audio, maxVoices: 0 }))).toBe(false);
    expect(mutated("theme", (d) => (d["audio"] = { ...audio, retriggerGapMs: -1 }))).toBe(false);
    expect(mutated("theme", (d) => (d["audio"] = { ...audio, cues: { playerKill: "" } }))).toBe(false);
  });

  it("accepts the FIRE control and blocked-pull haptics", () => {
    expect(
      mutated("theme", (d) => {
        d["hud"] = {
          flight: {
            fire: { anchor: "bottom-right", radiusPx: 34, offsetXPx: 24, offsetYPx: 34, icon: "FIRE", blockedNotification: "notification.fire-blocked" },
            reticle: { blockedText: "LOCK REQUIRED", blockedFlashMs: 500 },
          },
          portrait: { flight: { fire: { radiusPx: 34 } } },
          landscape: { flight: { fire: { radiusPx: 30 } } },
        };
        d["haptics"] = { enabled: true, fireBlockedPattern: [35, 35, 90] };
      }),
    ).toBe(true);
    expect(
      mutated("theme", (d) => {
        d["hud"] = { flight: { fire: { radiusPx: 0 } } };
      }),
    ).toBe(false);
    expect(
      mutated("theme", (d) => {
        d["hud"] = { flight: { reticle: { blockedFlashMs: 0 } } };
      }),
    ).toBe(false);

    const authored = CONFIG_SCHEMAS.theme.parse({
      ...clone(theme),
      hud: { flight: { fire: { blockedNotification: "notification.fire-blocked" } } },
    });
    expect(collectReferences(authored)).toContainEqual({
      path: "hud.flight.fire.blockedNotification",
      id: "notification.fire-blocked",
      expects: "notification",
    });
  });

  it("accepts a full juice block and rejects out-of-range shaping", () => {
    const juice = {
      hitFlash: { enabled: true, durationMs: 140, color: "#ffffff", scale: 1.2, intensity: 0.8, maxConcurrent: 8 },
      shieldRipple: { enabled: true, color: "#57d8ff", periodMs: 1200, radiusScale: 1.4, scaleWobble: 0.1, minAlpha: 0.1, maxAlpha: 0.5 },
      deploy: { extendDistance: 0.25, overshoot: 1.2, spinDegrees: 180 },
      explosions: { default: "fx.explosion-medium", asteroid: "fx.explosion-rock", byShipClass: { light: "fx.explosion-light" }, burstCount: 60, poolPerEffect: 3 },
    };
    expect(mutated("theme", (d) => (d["juice"] = juice))).toBe(true);
    expect(mutated("theme", (d) => (d["juice"] = {}))).toBe(true);
    expect(mutated("theme", (d) => (d["juice"] = { ...juice, hitFlash: { ...juice.hitFlash, intensity: 1.2 } }))).toBe(false);
    expect(mutated("theme", (d) => (d["juice"] = { ...juice, hitFlash: { ...juice.hitFlash, durationMs: 0 } }))).toBe(false);
    expect(mutated("theme", (d) => (d["juice"] = { ...juice, hitFlash: { ...juice.hitFlash, maxConcurrent: 1.5 } }))).toBe(false);
    expect(mutated("theme", (d) => (d["juice"] = { ...juice, shieldRipple: { ...juice.shieldRipple, scaleWobble: 1.5 } }))).toBe(false);
    expect(mutated("theme", (d) => (d["juice"] = { ...juice, deploy: { ...juice.deploy, overshoot: 3.5 } }))).toBe(false);
    expect(mutated("theme", (d) => (d["juice"] = { ...juice, deploy: { extendDistance: -1 } }))).toBe(false);
    expect(mutated("theme", (d) => (d["juice"] = { ...juice, explosions: { ...juice.explosions, burstCount: 0 } }))).toBe(false);
  });

  it("accepts a full menu block and rejects out-of-range backdrop/title values", () => {
    const menu = {
      colors: { base: "#05070c", panel: "#0d1520", primary: "#57d8ff", accent: "#ff9a3c", text: "#e8f4ff", muted: "#7d93a8", border: "#1d2b3a" },
      backdrop: { nebulaPrimary: "#0d5f7a", nebulaAccent: "#7a3d0d", nebulaOpacity: 0.6, starDensity: 0.5, vignette: 0.4 },
      title: { text: "ORION'S ARM", subtitle: "tactical duels", letterSpacingEm: 0.3, glow: 0.7 },
    };
    expect(mutated("theme", (d) => (d["menu"] = menu))).toBe(true);
    expect(mutated("theme", (d) => (d["menu"] = {}))).toBe(true);
    expect(mutated("theme", (d) => (d["menu"] = { ...menu, backdrop: { ...menu.backdrop, nebulaOpacity: 1.5 } }))).toBe(false);
    expect(mutated("theme", (d) => (d["menu"] = { ...menu, backdrop: { ...menu.backdrop, starDensity: -0.1 } }))).toBe(false);
    expect(mutated("theme", (d) => (d["menu"] = { ...menu, backdrop: { ...menu.backdrop, vignette: 2 } }))).toBe(false);
    expect(mutated("theme", (d) => (d["menu"] = { ...menu, title: { ...menu.title, letterSpacingEm: 2.5 } }))).toBe(false);
    expect(mutated("theme", (d) => (d["menu"] = { ...menu, title: { ...menu.title, glow: 1.2 } }))).toBe(false);
    expect(mutated("theme", (d) => (d["menu"] = { ...menu, colors: { base: 0 } }))).toBe(false);
    // Empty subtitle is meaningful (hides the tagline), not a validation error.
    expect(mutated("theme", (d) => (d["menu"] = { title: { subtitle: "" } }))).toBe(true);
  });
});

describe("progression schema", () => {
  it("requires a non-empty xp curve and integral credit rewards", () => {
    expect(mutated("progression", (d) => (d["xpCurve"] = []))).toBe(false);
    expect(mutated("progression", (d) => (d["xpCurve"] = [0]))).toBe(true);
    expect(mutated("progression", (d) => (d["xpCurve"] = [0, -100]))).toBe(false);
    expect(mutated("progression", (d) => ((d["rewards"] as Record<string, number>)["win"] = 10.5))).toBe(false);
  });

  it("defaults starterCredits to 0 and accepts an unlocks map (edge)", () => {
    const parsed = CONFIG_SCHEMAS.progression.parse(clone(progression));
    expect(parsed.starterCredits).toBe(0);
    expect(mutated("progression", (d) => (d["starterCredits"] = 500))).toBe(true);
    expect(mutated("progression", (d) => (d["starterCredits"] = -1))).toBe(false);
    expect(mutated("progression", (d) => (d["starterCredits"] = 1.5))).toBe(false);
    expect(mutated("progression", (d) => (d["unlocks"] = { "2": ["module.fixture-laser"], "3": [] }))).toBe(true);
    expect(mutated("progression", (d) => (d["unlocks"] = { "2": "module.fixture-laser" }))).toBe(false);
  });
});

describe("botprofile schema", () => {
  it("requires a positive decision interval and a two-element preferred range", () => {
    expect(mutated("botprofile", (d) => (d["decisionIntervalMs"] = 0))).toBe(false);
    expect(mutated("botprofile", (d) => (d["orderJitterMs"] = -1))).toBe(false);
    expect(mutated("botprofile", (d) => (d["preferredRange"] = [10]))).toBe(false);
    expect(mutated("botprofile", (d) => (d["preferredRange"] = [10, 20, 30]))).toBe(false);
    expect(mutated("botprofile", (d) => (d["preferredRange"] = [-1, 20]))).toBe(false);
  });

  it("clamps every moduleDiscipline fraction to 0..1", () => {
    const setDiscipline = (patch: Record<string, unknown>) => (d: Record<string, unknown>) => {
      d["moduleDiscipline"] = { ...(d["moduleDiscipline"] as Record<string, unknown>), ...patch };
    };
    expect(mutated("botprofile", setDiscipline({ energyReserve: -0.01 }))).toBe(false);
    expect(mutated("botprofile", setDiscipline({ energyReserve: 2 }))).toBe(false);
    expect(mutated("botprofile", setDiscipline({ shieldOnlyWhenEngaged: "yes" }))).toBe(false);
    expect(mutated("botprofile", (d) => delete d["moduleDiscipline"])).toBe(false);
  });

  it("accepts an optional fireDiscipline with four optional knobs", () => {
    expect(mutated("botprofile", (d) => (d["fireDiscipline"] = {}))).toBe(true);
    expect(
      mutated("botprofile", (d) => {
        d["fireDiscipline"] = {
          engageRangeMult: 1.1,
          minEnergyFraction: 0.2,
          burstSec: 1,
          pauseSec: 0.5,
        };
      }),
    ).toBe(true);
    expect(mutated("botprofile", (d) => (d["fireDiscipline"] = { minEnergyFraction: 1.01 }))).toBe(false);
    expect(mutated("botprofile", (d) => (d["fireDiscipline"] = { burstSec: -1 }))).toBe(false);
    expect(mutated("botprofile", (d) => delete d["fireDiscipline"])).toBe(true);
  });

  it("keeps per-behavior tunables open (catchall) but requires baseWeight (edge)", () => {
    expect(mutated("botprofile", (d) => (d["behaviors"] = { kite: { baseWeight: 0, anythingElse: [1, 2] } }))).toBe(true);
    expect(mutated("botprofile", (d) => (d["behaviors"] = {}))).toBe(true);
    expect(mutated("botprofile", (d) => (d["behaviors"] = { kite: { doubleTapBoostChance: 0.5 } }))).toBe(false);
    expect(mutated("botprofile", (d) => (d["behaviors"] = { kite: { baseWeight: -1 } }))).toBe(false);
  });
});

describe("quality schema (5.6)", () => {
  it("rejects an unknown tier and accepts each known one", () => {
    for (const tier of QUALITY_TIERS) {
      expect(mutated("quality", (d) => (d["tier"] = tier))).toBe(true);
    }
    expect(mutated("quality", (d) => (d["tier"] = "cinematic"))).toBe(false);
  });

  it("bounds the render scaling knobs to 0.5..4", () => {
    const setRender = (patch: Record<string, unknown>) => (d: Record<string, unknown>) => {
      d["render"] = { ...(d["render"] as Record<string, unknown>), ...patch };
    };
    expect(mutated("quality", setRender({ hardwareScalingMultiplier: 0.5 }))).toBe(true);
    expect(mutated("quality", setRender({ hardwareScalingMultiplier: 4 }))).toBe(true);
    expect(mutated("quality", setRender({ hardwareScalingMultiplier: 0.49 }))).toBe(false);
    expect(mutated("quality", setRender({ hardwareScalingMultiplier: 4.01 }))).toBe(false);
    expect(mutated("quality", setRender({ maxDevicePixelRatio: 0.2 }))).toBe(false);
    expect(mutated("quality", setRender({ freezeStatics: "yes" }))).toBe(false);
  });

  it("validates the probe / autoTier / particle budget blocks", () => {
    const set = (key: string, patch: Record<string, unknown>) => (d: Record<string, unknown>) => {
      d[key] = { ...(d[key] as Record<string, unknown>), ...patch };
    };
    expect(mutated("quality", set("probe", { minCores: 0, minMemoryGb: 0, allowMobile: false }))).toBe(true);
    expect(mutated("quality", set("probe", { minCores: -1 }))).toBe(false);
    expect(mutated("quality", set("probe", { minCores: 2.5 }))).toBe(false);
    expect(mutated("quality", set("autoTier", { sampleAfterMs: 0 }))).toBe(true); // no warm-up is legal
    expect(mutated("quality", set("autoTier", { sampleWindowMs: 0 }))).toBe(false);
    expect(mutated("quality", set("autoTier", { demoteBelowFps: 0, promoteAboveFps: 0 }))).toBe(true); // never adjust
    expect(mutated("quality", set("particles", { budgetMultiplier: 0 }))).toBe(true);
    expect(mutated("quality", set("particles", { budgetMultiplier: 1.25 }))).toBe(true);
    expect(mutated("quality", set("particles", { budgetMultiplier: 1.26 }))).toBe(false);
    expect(mutated("quality", set("particles", { maxEmitterCapacity: -1 }))).toBe(false);
  });

  it("treats 0 LOD/cull distances as 'disabled' and rejects negatives (edge)", () => {
    const setAsteroids = (patch: Record<string, unknown>) => (d: Record<string, unknown>) => {
      d["asteroids"] = { ...(d["asteroids"] as Record<string, unknown>), ...patch };
    };
    expect(mutated("quality", setAsteroids({ lodMediumDistance: 0, lodLowDistance: 0, lodCullDistance: 0 }))).toBe(true);
    expect(mutated("quality", setAsteroids({ lodLowDistance: -1 }))).toBe(false);
    expect(mutated("quality", (d) => ((d["glow"] as Record<string, unknown>)["blurKernelSize"] = 0))).toBe(false);
    expect(mutated("quality", (d) => ((d["glow"] as Record<string, unknown>)["blurKernelSize"] = 32))).toBe(true);
    expect(mutated("quality", (d) => ((d["scene"] as Record<string, unknown>)["starfieldPoints"] = 1500.5))).toBe(false);
    expect(mutated("quality", (d) => ((d["scene"] as Record<string, unknown>)["starfieldPoints"] = 0))).toBe(true);
  });

  it("validates the ambient-dust block and keeps it optional for older packs", () => {
    const withDust = (dust: unknown) => (d: Record<string, unknown>) => {
      d["scene"] = { ...(d["scene"] as Record<string, unknown>), dust };
    };
    const base = { count: 180, size: 0.35, alpha: 0.3, driftSpeed: 0.8, boxSize: 120 };
    expect(mutated("quality", withDust(base))).toBe(true);
    // `count: 0` is the shipped LOW tier — the documented way to disable dust.
    expect(mutated("quality", withDust({ ...base, count: 0 }))).toBe(true);
    // Omitted entirely: an already-published pack stays valid.
    expect(mutated("quality", withDust(undefined))).toBe(true);
    expect(mutated("quality", withDust({ ...base, count: -1 }))).toBe(false);
    expect(mutated("quality", withDust({ ...base, count: 12.5 }))).toBe(false);
    expect(mutated("quality", withDust({ ...base, size: 0 }))).toBe(false);
    expect(mutated("quality", withDust({ ...base, alpha: 1.01 }))).toBe(false);
    expect(mutated("quality", withDust({ ...base, alpha: 0 }))).toBe(true);
    expect(mutated("quality", withDust({ ...base, driftSpeed: -0.1 }))).toBe(false);
    expect(mutated("quality", withDust({ ...base, driftSpeed: 0 }))).toBe(true);
    expect(mutated("quality", withDust({ ...base, boxSize: 0 }))).toBe(false);
    // No half-configured dust: every knob is required once the block is present.
    for (const key of Object.keys(base)) {
      const partial: Record<string, unknown> = { ...base };
      delete partial[key];
      expect(mutated("quality", withDust(partial))).toBe(false);
    }
  });

  it("requires every consumer block to be present (no half-configured tier)", () => {
    for (const block of ["probe", "autoTier", "render", "glow", "particles", "asteroids", "projectiles", "scene"]) {
      expect(mutated("quality", (d) => delete d[block])).toBe(false);
    }
  });
});

describe("manifest schema (validated outside CONFIG_SCHEMAS)", () => {
  it("accepts a non-empty file list and rejects an empty one", () => {
    const base = { id: "manifest.fixture", type: "manifest", version: 1, files: ["a.json"] };
    expect(manifestSchema.safeParse(base).success).toBe(true);
    expect(manifestSchema.safeParse({ ...base, files: [] }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...base, files: "a.json" }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...base, type: "ship" }).success).toBe(false);
  });

  it("is not dispatchable through validateConfig (it is meta, not content)", () => {
    const r = validateConfig({ id: "manifest.fixture", type: "manifest", version: 1, files: ["a.json"] });
    expect(r.success).toBe(false);
  });
});

// --------------------------------------------------------------------------
// 4. Reference extraction (pure half of reference resolution)
// --------------------------------------------------------------------------

/** Parse a fixture and hand the typed config to `collectReferences`. */
function refsOf(type: ConfigType, fixture: unknown): Record<string, string> {
  const parsed = CONFIG_SCHEMAS[type].parse(fixture) as AnyConfig;
  return Object.fromEntries(collectReferences(parsed).map((r) => [r.path, r.id]));
}

describe("collectReferences", () => {
  it("extracts every outgoing id from a ship (tracks, fitting, emitter effects)", () => {
    expect(refsOf("ship", clone(ship))).toEqual({
      "upgradeTracks.hull": "upgrade.hull-std",
      "upgradeTracks.engine": "upgrade.engine-std",
      "upgradeTracks.energy": "upgrade.energy-std",
      "defaultFitting[0]": "module.fixture-laser",
      "defaultFitting[1]": "module.fixture-shield",
      "sockets[2].effect": "fx.engine-trail",
    });
  });

  it("extracts module action hooks from all four lifecycle points", () => {
    const withHooks = clone(module_);
    Object.assign(withHooks, {
      onFire: ["action.a"],
      onActivate: ["action.d"],
      onDeactivate: ["action.e"],
    });
    expect(refsOf("module", withHooks)).toEqual({
      "onFire[0]": "action.a",
      "onActivate[0]": "action.d",
      "onDeactivate[0]": "action.e",
    });
  });

  it("extracts arena asteroid placements, event actions and notification triggers", () => {
    expect(refsOf("arena", clone(arena))).toEqual({
      "asteroidPlacements[0].asteroidId": "asteroid.fixture",
      "render.boundaryShield.warningNotification": "notification.fixture",
    });
    expect(refsOf("event", clone(event))).toEqual({ "actions[0]": "action.fixture-sound" });
    expect(refsOf("notification", { ...clone(notification), triggerEvent: "event.fixture" })).toEqual({
      triggerEvent: "event.fixture",
    });
    expect(refsOf("notification", clone(notification))).toEqual({}); // triggerEvent optional
  });

  it("extracts only the `notification` key out of an action's free-form params", () => {
    expect(refsOf("action", { ...clone(action), kind: "show_notification", params: { notification: "notification.fixture", ttl: 5 } })).toEqual({
      "params.notification": "notification.fixture",
    });
    expect(refsOf("action", { ...clone(action), params: { notification: 42 } })).toEqual({});
    expect(refsOf("action", { ...clone(action), params: undefined })).toEqual({});
  });

  it("extracts the whole gamemode bots graph (default + roster, ships optional)", () => {
    const withBots = clone(gamemode);
    Object.assign(withBots, {
      defaultArena: "arena.fixture",
      bots: {
        defaultProfile: "bot.fixture",
        defaultShip: "ship.fixture",
        roster: [
          { profile: "bot.aggressive", ship: "ship.fixture", team: 1 },
          { profile: "bot.cautious", team: 1 },
        ],
      },
    });
    expect(refsOf("gamemode", withBots)).toEqual({
      defaultArena: "arena.fixture",
      "bots.defaultProfile": "bot.fixture",
      "bots.defaultShip": "ship.fixture",
      "bots.roster[0].profile": "bot.aggressive",
      "bots.roster[0].ship": "ship.fixture",
      "bots.roster[1].profile": "bot.cautious",
    });
    expect(refsOf("gamemode", clone(gamemode))).toEqual({}); // no bots, no defaultArena
  });

  it("returns no references for leaf config types", () => {
    for (const type of ["asteroid", "camera", "tuning", "theme", "progression", "botprofile", "quality", "effect", "upgrade"] as const) {
      expect(refsOf(type, clone(VALID[type]))).toEqual({});
    }
  });
});

describe("collectRelationalErrors", () => {
  const resolve = (type: ConfigType, id: string): AnyConfig | undefined => {
    if (type === "module" && id === "module.fixture-laser") return CONFIG_SCHEMAS.module.parse(clone(module_)) as AnyConfig;
    if (type === "module" && id === "module.fixture-shield") {
      return CONFIG_SCHEMAS.module.parse({ ...clone(module_), id: "module.fixture-shield", family: "shield", fire: undefined }) as AnyConfig;
    }
    return undefined;
  };

  it("passes a fitting whose families match the hardpoints in order", () => {
    const parsed = CONFIG_SCHEMAS.ship.parse(clone(ship)) as AnyConfig;
    expect(collectRelationalErrors(parsed, resolve)).toEqual([]);
  });

  it("flags a family/hardpoint mismatch at the offending index", () => {
    const swapped = CONFIG_SCHEMAS.ship.parse({
      ...clone(ship),
      defaultFitting: ["module.fixture-shield", "module.fixture-laser"],
    }) as AnyConfig;
    const errs = collectRelationalErrors(swapped, resolve);
    expect(errs.map((e) => e.path)).toEqual(["defaultFitting[0]", "defaultFitting[1]"]);
  });

  it("flags a fitting longer than the hardpoint list, and ignores empty slots + unknown ids", () => {
    const tooLong = CONFIG_SCHEMAS.ship.parse({
      ...clone(ship),
      defaultFitting: ["module.fixture-laser", "module.fixture-shield", "module.fixture-laser"],
    }) as AnyConfig;
    expect(collectRelationalErrors(tooLong, resolve).some((e) => e.path === "defaultFitting")).toBe(true);

    const sparse = CONFIG_SCHEMAS.ship.parse({ ...clone(ship), defaultFitting: ["", "module.fixture-shield"] }) as AnyConfig;
    expect(collectRelationalErrors(sparse, resolve)).toEqual([]);

    const unknown = CONFIG_SCHEMAS.ship.parse({ ...clone(ship), defaultFitting: ["module.ghost", "module.fixture-shield"] }) as AnyConfig;
    expect(collectRelationalErrors(unknown, resolve)).toEqual([]); // dangling ids are reference errors, not relational ones
  });

  it("returns nothing for non-ship configs", () => {
    const parsed = CONFIG_SCHEMAS.gamemode.parse(clone(gamemode)) as AnyConfig;
    expect(collectRelationalErrors(parsed, resolve)).toEqual([]);
  });
});

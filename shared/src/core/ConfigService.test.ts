import { describe, it, expect, vi } from "vitest";
import { ConfigService, type ConfigEvents } from "./ConfigService.js";
import { EventBus } from "./EventBus.js";
import type { CameraConfig } from "../schemas/index.js";

/** Build an in-memory loader over a { path -> json } map. */
function memLoader(files: Record<string, unknown>) {
  return (path: string) => {
    if (!(path in files)) return Promise.reject(new Error(`not found: ${path}`));
    return Promise.resolve(files[path]);
  };
}

const camera = {
  id: "camera.default",
  type: "camera",
  version: 1,
  alpha: { default: 0 },
  beta: { min: 0.6, max: 1.1, default: 0.9 },
  radius: { min: 30, max: 90, default: 55 },
  followLag: 0.2,
  lookAhead: 5,
};

const asteroid = {
  id: "asteroid.rock",
  type: "asteroid",
  version: 1,
  radius: 3,
  destructible: true,
  impactDamage: 5,
  render: { recipe: "procedural.rock" },
};

const arena = {
  id: "arena.test",
  type: "arena",
  version: 1,
  bounds: { shape: "circle", radius: 50 },
  asteroidPlacements: [{ asteroidId: "asteroid.rock", position: { x: 0, z: 0 } }],
  spawnPoints: [{ id: "s1", team: 0, position: { x: -10, z: 0 }, heading: 0 }],
};

function validFiles(): Record<string, unknown> {
  return {
    "manifest.json": {
      id: "manifest.default",
      type: "manifest",
      version: 1,
      files: ["camera.json", "asteroid.json", "arena.json"],
    },
    "camera.json": camera,
    "asteroid.json": asteroid,
    "arena.json": arena,
  };
}

describe("ConfigService.load", () => {
  it("loads a valid content pack and populates typed getters", async () => {
    const svc = new ConfigService(memLoader(validFiles()));
    const result = await svc.load("manifest.json");

    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.counts).toMatchObject({ camera: 1, asteroid: 1, arena: 1 });

    expect(svc.get("camera", "camera.default")?.id).toBe("camera.default");
    expect(svc.getAll("asteroid")).toHaveLength(1);
    expect(svc.has("arena.test")).toBe(true);
    expect(svc.has("nope")).toBe(false);
    expect(svc.typeOf("arena.test")).toBe("arena");
  });

  it("aggregates schema errors with file + path + message", async () => {
    const files = validFiles();
    // Corrupt camera: radius.min is a string, followLag out of range.
    files["camera.json"] = {
      ...(camera as Record<string, unknown>),
      radius: { min: "x", max: 90, default: 55 },
      followLag: 5,
    };
    const svc = new ConfigService(memLoader(files));
    const result = await svc.load("manifest.json");

    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
    for (const e of result.errors) {
      expect(e.file).toBe("camera.json");
      expect(typeof e.path).toBe("string");
      expect(typeof e.message).toBe("string");
    }
    // Registry untouched on failure.
    expect(svc.has("camera.default")).toBe(false);
  });

  it("detects dangling cross-references", async () => {
    const files = validFiles();
    files["arena.json"] = {
      ...arena,
      asteroidPlacements: [{ asteroidId: "asteroid.ghost", position: { x: 0, z: 0 } }],
    };
    const svc = new ConfigService(memLoader(files));
    const result = await svc.load("manifest.json");

    expect(result.ok).toBe(false);
    const dangling = result.errors.find((e) => e.message.includes("dangling reference"));
    expect(dangling).toBeDefined();
    expect(dangling?.path).toBe("asteroidPlacements[0].asteroidId");
  });

  it("detects duplicate ids", async () => {
    const files = validFiles();
    (files["manifest.json"] as { files: string[] }).files.push("dupe.json");
    files["dupe.json"] = camera;
    const svc = new ConfigService(memLoader(files));
    const result = await svc.load("manifest.json");

    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.message.includes("duplicate config id"))).toBe(true);
  });

  it("freezes loaded objects deeply", async () => {
    const svc = new ConfigService(memLoader(validFiles()));
    await svc.load("manifest.json");
    const cfg = svc.get<CameraConfig>("camera", "camera.default")!;
    expect(Object.isFrozen(cfg)).toBe(true);
    expect(Object.isFrozen(cfg.beta)).toBe(true);
    expect(() => {
      (cfg as unknown as { version: number }).version = 99;
    }).toThrow();
  });
});

// --- Relational (cross-config) validation: ship defaultFitting vs sockets ---

const moduleOf = (id: string, family: string) => ({
  id,
  type: "module",
  version: 1,
  family,
  level: 1,
  name: id,
  activation: { deployTime: 0, retractTime: 0 },
  energy: { drawIdle: 0, drawActive: 0 },
  heat: { perSecondActive: 0, overheatThreshold: 1, overheatCooldown: 0, overheatSelfDamage: 0 },
  ui: { icon: "i", label: "l" },
  price: 0,
  requiresLevel: 1,
});

const upgradeOf = (id: string, track: string) => ({
  id,
  type: "upgrade",
  version: 1,
  track,
  levels: [{ level: 1, price: 0 }],
});

function shipFiles(defaultFitting: string[]): Record<string, unknown> {
  return {
    "manifest.json": {
      id: "manifest.default",
      type: "manifest",
      version: 1,
      files: ["laser.json", "shield.json", "u-hull.json", "u-engine.json", "u-energy.json", "u-heat.json", "ship.json"],
    },
    "laser.json": moduleOf("module.laserx", "laser"),
    "shield.json": moduleOf("module.shieldx", "shield"),
    "u-hull.json": upgradeOf("upgrade.hull", "hull"),
    "u-engine.json": upgradeOf("upgrade.engine", "engine"),
    "u-energy.json": upgradeOf("upgrade.energy", "energy"),
    "u-heat.json": upgradeOf("upgrade.heat", "heat"),
    "ship.json": {
      id: "ship.tester",
      type: "ship",
      version: 1,
      name: "Tester",
      class: "light",
      core: {
        hull: { base: 80, resists: { kinetic: 0.1, energy: 0 } },
        engine: { nominalSpeed: 34, accel: 22, turnRate: 3 },
        energy: { capacitor: 120, regen: 14 },
        heat: { capacity: 100, dissipation: 9, criticalDamagePerSec: 4 },
      },
      upgradeTracks: { hull: "upgrade.hull", engine: "upgrade.engine", energy: "upgrade.energy", heat: "upgrade.heat" },
      sockets: [
        { id: "hp0", kind: "hardpoint", transform: { pos: [0, 0, 1] }, accepts: ["laser"] },
        { id: "hp1", kind: "hardpoint", transform: { pos: [0, 0, -1] }, accepts: ["shield"] },
      ],
      defaultFitting,
      render: { recipe: "procedural.arrowhead" },
      collider: { shape: "circle", radius: 1.4 },
    },
  };
}

describe("ConfigService relational validation (ship defaultFitting vs sockets)", () => {
  it("loads a ship whose defaultFitting matches its hardpoint families", async () => {
    const svc = new ConfigService(memLoader(shipFiles(["module.laserx", "module.shieldx"])));
    const result = await svc.load("manifest.json");
    expect(result.ok).toBe(true);
  });

  it("rejects a defaultFitting whose module family is not accepted by its hardpoint", async () => {
    // hp0 accepts laser, but index 0 is a shield module → relational error.
    const svc = new ConfigService(memLoader(shipFiles(["module.shieldx", "module.laserx"])));
    const result = await svc.load("manifest.json");
    expect(result.ok).toBe(false);
    const rel = result.errors.find((e) => e.message.includes("not accepted by hardpoint"));
    expect(rel).toBeDefined();
    expect(rel?.path).toBe("defaultFitting[0]");
  });

  it("rejects a defaultFitting with more entries than hardpoints", async () => {
    const svc = new ConfigService(memLoader(shipFiles(["module.laserx", "module.shieldx", "module.laserx"])));
    const result = await svc.load("manifest.json");
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.message.includes("only 2 hardpoint"))).toBe(true);
  });
});

describe("ConfigService.replace", () => {
  it("re-validates, swaps, and emits config:changed", async () => {
    const bus = new EventBus<ConfigEvents>();
    const svc = new ConfigService(memLoader(validFiles()), bus);
    await svc.load("manifest.json");

    const handler = vi.fn();
    bus.on("config:changed", handler);

    const updated = { ...camera, radius: { min: 30, max: 90, default: 70 } };
    const res = svc.replace(updated);

    expect(res.ok).toBe(true);
    expect(svc.get<CameraConfig>("camera", "camera.default")?.radius.default).toBe(70);
    expect(handler).toHaveBeenCalledWith({ id: "camera.default", type: "camera" });
  });

  it("rejects an invalid replacement without mutating the registry", async () => {
    const svc = new ConfigService(memLoader(validFiles()));
    await svc.load("manifest.json");

    const res = svc.replace({ ...camera, followLag: 99 });
    expect(res.ok).toBe(false);
    expect(res.errors.length).toBeGreaterThan(0);
    expect(svc.get<CameraConfig>("camera", "camera.default")?.followLag).toBe(0.2);
  });

  it("rejects a replacement with a dangling reference", async () => {
    const svc = new ConfigService(memLoader(validFiles()));
    await svc.load("manifest.json");

    const res = svc.replace({
      ...arena,
      asteroidPlacements: [{ asteroidId: "asteroid.ghost", position: { x: 0, z: 0 } }],
    });
    expect(res.ok).toBe(false);
    expect(res.errors[0]?.message).toContain("dangling reference");
  });
});

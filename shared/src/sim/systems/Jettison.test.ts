import { beforeAll, describe, expect, it } from "vitest";
import type { ConfigService } from "../../core/ConfigService.js";
import type { ModuleConfig } from "../../schemas/module.js";
import { spawnProjectile, spawnShipFromConfig } from "../spawn.js";
import {
  INTERCEPTOR_FITTING,
  INTERCEPTOR_FITTING_ABLATIVE,
  INTERCEPTOR_SLOTS,
  loadTestConfigs,
  makeWorld,
  rebuildSpatial,
} from "../testutil.js";
import type { World } from "../World.js";
import { jettisonSystem } from "./JettisonSystem.js";
import { projectileSystem } from "./ProjectileSystem.js";
import { targetingSystem } from "./TargetingSystem.js";

const DT = 1 / 30;

let configs: ConfigService;
beforeAll(async () => {
  configs = await loadTestConfigs();
});

function ship(world: World, fitting: readonly string[], team = 0, pos = { x: 0, z: 0 }, heading = 0): number {
  return spawnShipFromConfig(world, configs, "ship.interceptor", fitting, team, pos, heading);
}

const jettisonCfg = (): NonNullable<ModuleConfig["jettison"]> =>
  configs.get<ModuleConfig>("module", "module.heatsink-ablative")!.jettison!;

describe("heatsink jettison (owner 2026-07-31)", () => {
  it("dumps every scrap of the ship's heat and leaves a decoy behind", () => {
    const world = makeWorld(configs);
    const id = ship(world, INTERCEPTOR_FITTING_ABLATIVE);
    const mods = world.modules.get(id)!.modules;
    const core = world.shipCores.get(id)!;
    for (const m of mods) m.heat = 20;
    core.heat.cur = 20 * mods.length;

    world.queueOrder(id, { kind: "jettisonHeatsink" });
    jettisonSystem(world, DT);

    expect(mods.every((m) => m.heat === 0)).toBe(true);
    expect(core.heat.cur).toBe(0);
    expect(world.decoyIds()).toHaveLength(1);
    const decoy = world.decoys.get(world.decoyIds()[0]!)!;
    expect(decoy.team).toBe(0);
    expect(decoy.lifetime).toBe(jettisonCfg().decoyLifetimeSec);
    expect(world.events.some((e) => e.type === "heatsinkJettisoned")).toBe(true);
  });

  it("rescues an OVERHEATED weapon: it comes straight back online", () => {
    const world = makeWorld(configs);
    const id = ship(world, INTERCEPTOR_FITTING_ABLATIVE);
    const laser = world.modules.get(id)!.modules[INTERCEPTOR_SLOTS.laser]!;
    laser.state = "overheated";
    laser.stateTimer = 3;
    laser.heat = 60;

    world.queueOrder(id, { kind: "jettisonHeatsink" });
    jettisonSystem(world, DT);

    expect(laser.state).toBe("active");
    expect(laser.heat).toBe(0);
  });

  it("drops the sink WHERE THE SHIP IS, at rest — a lure that flew along would shadow the hull", () => {
    const world = makeWorld(configs);
    const id = ship(world, INTERCEPTOR_FITTING_ABLATIVE, 0, { x: 12, z: -4 });
    world.velocities.set(id, { x: 30, y: 0, z: 0 });

    world.queueOrder(id, { kind: "jettisonHeatsink" });
    jettisonSystem(world, DT);

    const decoyId = world.decoyIds()[0]!;
    const tf = world.transforms.get(decoyId)!;
    expect(tf.pos.x).toBeCloseTo(12, 9);
    expect(tf.pos.z).toBeCloseTo(-4, 9);
    const vel = world.velocities.get(decoyId)!;
    expect([vel.x, vel.y, vel.z]).toEqual([0, 0, 0]);
  });

  it("respects the cooldown, then allows a second drop once it expires", () => {
    const world = makeWorld(configs);
    const id = ship(world, INTERCEPTOR_FITTING_ABLATIVE);
    const cooldown = jettisonCfg().cooldownSec;

    world.queueOrder(id, { kind: "jettisonHeatsink" });
    jettisonSystem(world, DT);
    expect(world.decoyIds()).toHaveLength(1);

    // Immediately again: refused.
    world.queueOrder(id, { kind: "jettisonHeatsink" });
    jettisonSystem(world, DT);
    expect(world.decoyIds()).toHaveLength(1);

    // Run the cooldown out (the first decoy burns away in the meantime).
    for (let i = 0; i < Math.ceil(cooldown / DT) + 2; i++) jettisonSystem(world, DT);
    world.queueOrder(id, { kind: "jettisonHeatsink" });
    jettisonSystem(world, DT);
    expect(world.decoyIds()).toHaveLength(1); // the new one
  });

  it("a sink with no jettison block cannot be dropped at all", () => {
    const world = makeWorld(configs);
    const id = ship(world, INTERCEPTOR_FITTING); // stock passive radiator
    world.queueOrder(id, { kind: "jettisonHeatsink" });
    jettisonSystem(world, DT);
    expect(world.decoyIds()).toHaveLength(0);
  });

  it("burns out after its authored lifetime", () => {
    const world = makeWorld(configs);
    const id = ship(world, INTERCEPTOR_FITTING_ABLATIVE);
    world.queueOrder(id, { kind: "jettisonHeatsink" });
    jettisonSystem(world, DT);
    expect(world.decoyIds()).toHaveLength(1);

    for (let i = 0; i < Math.ceil(jettisonCfg().decoyLifetimeSec / DT) + 1; i++) jettisonSystem(world, DT);
    expect(world.decoyIds()).toHaveLength(0);
  });
});

describe("a jettisoned sink is a LURE", () => {
  it("steals an enemy's auto-lock away from the hull that dropped it", () => {
    const world = makeWorld(configs);
    // Hunter at the origin facing +x; prey dead ahead.
    const hunter = ship(world, INTERCEPTOR_FITTING, 1, { x: 0, z: 0 }, 0);
    const prey = ship(world, INTERCEPTOR_FITTING_ABLATIVE, 0, { x: 30, z: 0 }, Math.PI);
    rebuildSpatial(world);

    targetingSystem(world, DT);
    expect(world.targets.get(hunter)!.targetId).toBe(prey);

    world.queueOrder(prey, { kind: "jettisonHeatsink" });
    jettisonSystem(world, DT);
    rebuildSpatial(world);
    targetingSystem(world, DT);

    const decoyId = world.decoyIds()[0]!;
    expect(world.targets.get(hunter)!.targetId).toBe(decoyId);
  });

  it("never distracts the team that dropped it", () => {
    const world = makeWorld(configs);
    const ally = ship(world, INTERCEPTOR_FITTING, 0, { x: 0, z: 0 }, 0);
    const dropper = ship(world, INTERCEPTOR_FITTING_ABLATIVE, 0, { x: 20, z: 0 }, Math.PI);
    const foe = ship(world, INTERCEPTOR_FITTING, 1, { x: 40, z: 0 }, Math.PI);
    rebuildSpatial(world);

    world.queueOrder(dropper, { kind: "jettisonHeatsink" });
    jettisonSystem(world, DT);
    rebuildSpatial(world);
    targetingSystem(world, DT);

    // The ally looks straight past its own side's sink to the enemy.
    expect(world.targets.get(ally)!.targetId).toBe(foe);
  });

  it("never lets a friendly sensor retain its own team's heatsink as a lock", () => {
    const world = makeWorld(configs);
    const ally = ship(world, INTERCEPTOR_FITTING, 0, { x: 0, z: 0 }, 0);
    const dropper = ship(world, INTERCEPTOR_FITTING_ABLATIVE, 0, { x: 20, z: 0 }, Math.PI);
    rebuildSpatial(world);
    world.queueOrder(dropper, { kind: "jettisonHeatsink" });
    jettisonSystem(world, DT);
    const decoyId = world.decoyIds()[0]!;
    // Guard the sticky-target path too: no friendly lock may keep the lure.
    world.targets.get(ally)!.targetId = decoyId;
    world.targets.get(ally)!.lockProgress = 1;
    rebuildSpatial(world);

    targetingSystem(world, DT);

    expect(world.targets.get(ally)!.targetId).toBeNull();
  });

  it("drops the lock again the moment the sink burns out", () => {
    const world = makeWorld(configs);
    const hunter = ship(world, INTERCEPTOR_FITTING, 1, { x: 0, z: 0 }, 0);
    const prey = ship(world, INTERCEPTOR_FITTING_ABLATIVE, 0, { x: 30, z: 0 }, Math.PI);
    rebuildSpatial(world);
    world.queueOrder(prey, { kind: "jettisonHeatsink" });
    jettisonSystem(world, DT);
    rebuildSpatial(world);
    targetingSystem(world, DT);
    expect(world.targets.get(hunter)!.targetId).toBe(world.decoyIds()[0]);

    // Burn it out, then let targeting re-evaluate: back onto the real ship.
    for (let i = 0; i < Math.ceil(jettisonCfg().decoyLifetimeSec / DT) + 1; i++) jettisonSystem(world, DT);
    rebuildSpatial(world);
    targetingSystem(world, DT);
    expect(world.targets.get(hunter)!.targetId).toBe(prey);
  });

  it("STEALS A MISSILE MID-FLIGHT — the reason to carry one", () => {
    const world = makeWorld(configs);
    const prey = ship(world, INTERCEPTOR_FITTING_ABLATIVE, 0, { x: 60, z: 0 }, Math.PI);
    // A missile already streaking toward the prey when the sink goes out.
    const missile = spawnProjectile(world, {
      kind: "missile",
      damage: 20,
      damageType: "kinetic",
      speed: 40,
      turnRate: 2.2,
      lifetime: 5,
      ownerId: 999,
      ownerTeam: 1,
      targetId: prey,
      pos: { x: 0, z: 0 },
      heading: 0,
    });
    rebuildSpatial(world);

    world.queueOrder(prey, { kind: "jettisonHeatsink" });
    jettisonSystem(world, DT);
    // Put the sink between the missile and its target — closer than the prey.
    const decoyId = world.decoyIds()[0]!;
    world.transforms.get(decoyId)!.pos.x = 20;
    rebuildSpatial(world);

    projectileSystem(world, DT);

    expect(world.projectiles.get(missile)!.targetId).toBe(decoyId);
  });

  it("leaves a missile alone when the only sink belongs to the shooter's own team", () => {
    const world = makeWorld(configs);
    const prey = ship(world, INTERCEPTOR_FITTING_ABLATIVE, 1, { x: 60, z: 0 }, Math.PI);
    const missile = spawnProjectile(world, {
      kind: "missile",
      damage: 20,
      damageType: "kinetic",
      speed: 40,
      turnRate: 2.2,
      lifetime: 5,
      ownerId: 999,
      ownerTeam: 1, // same team as the dropper
      targetId: prey,
      pos: { x: 0, z: 0 },
      heading: 0,
    });
    rebuildSpatial(world);

    world.queueOrder(prey, { kind: "jettisonHeatsink" });
    jettisonSystem(world, DT);
    world.transforms.get(world.decoyIds()[0]!)!.pos.x = 20;
    rebuildSpatial(world);

    projectileSystem(world, DT);

    expect(world.projectiles.get(missile)!.targetId).toBe(prey);
  });
});

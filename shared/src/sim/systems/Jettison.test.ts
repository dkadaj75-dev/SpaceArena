import { beforeAll, describe, expect, it } from "vitest";
import type { ConfigService } from "../../core/ConfigService.js";
import type { ModuleConfig } from "../../schemas/module.js";
import { spawnProjectile, spawnShipFromConfig } from "../spawn.js";
import {
  INTERCEPTOR_FITTING,
  INTERCEPTOR_FITTING_CHAFF,
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
  configs.get<ModuleConfig>("module", "module.countermeasure-chaff")!.jettison!;

describe("countermeasure jettison (owner 2026-07-31)", () => {
  it("leaves a decoy behind and reports it", () => {
    const world = makeWorld(configs);
    const id = ship(world, INTERCEPTOR_FITTING_CHAFF);

    world.queueOrder(id, { kind: "jettisonCountermeasure" });
    jettisonSystem(world, DT);

    expect(world.decoyIds()).toHaveLength(1);
    const decoy = world.decoys.get(world.decoyIds()[0]!)!;
    expect(decoy.team).toBe(0);
    expect(decoy.lifetime).toBe(jettisonCfg().decoyLifetimeSec);
    expect(world.events.some((e) => e.type === "countermeasureJettisoned")).toBe(true);
  });

  it("drops nothing without an order", () => {
    const world = makeWorld(configs);
    ship(world, INTERCEPTOR_FITTING_CHAFF);
    jettisonSystem(world, DT);
    expect(world.decoyIds()).toHaveLength(0);
  });

  it("drops the pod WHERE THE SHIP IS, at rest — a lure that flew along would shadow the hull", () => {
    const world = makeWorld(configs);
    const id = ship(world, INTERCEPTOR_FITTING_CHAFF, 0, { x: 12, z: -4 });
    world.velocities.set(id, { x: 30, y: 0, z: 0 });

    world.queueOrder(id, { kind: "jettisonCountermeasure" });
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
    const id = ship(world, INTERCEPTOR_FITTING_CHAFF);
    const cooldown = jettisonCfg().cooldownSec;

    world.queueOrder(id, { kind: "jettisonCountermeasure" });
    jettisonSystem(world, DT);
    expect(world.decoyIds()).toHaveLength(1);

    // Immediately again: refused.
    world.queueOrder(id, { kind: "jettisonCountermeasure" });
    jettisonSystem(world, DT);
    expect(world.decoyIds()).toHaveLength(1);

    // Run the cooldown out (the first decoy burns away in the meantime).
    for (let i = 0; i < Math.ceil(cooldown / DT) + 2; i++) jettisonSystem(world, DT);
    world.queueOrder(id, { kind: "jettisonCountermeasure" });
    jettisonSystem(world, DT);
    expect(world.decoyIds()).toHaveLength(1); // the new one
  });

  it("a hull carrying no jettisonable pod drops nothing at all", () => {
    const world = makeWorld(configs);
    // Same fitting with the countermeasure bay left EMPTY: every shipped pod
    // authors a jettison block, so an absent pod is the only way to have none.
    const bare = INTERCEPTOR_FITTING.map((id, i) => (i === INTERCEPTOR_SLOTS.countermeasure ? null : id));
    const id = spawnShipFromConfig(world, configs, "ship.interceptor", bare, 0, { x: 0, z: 0 }, 0);
    world.queueOrder(id, { kind: "jettisonCountermeasure" });
    jettisonSystem(world, DT);
    expect(world.decoyIds()).toHaveLength(0);
  });

  it("burns out after its authored lifetime", () => {
    const world = makeWorld(configs);
    const id = ship(world, INTERCEPTOR_FITTING_CHAFF);
    world.queueOrder(id, { kind: "jettisonCountermeasure" });
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
    const prey = ship(world, INTERCEPTOR_FITTING_CHAFF, 0, { x: 30, z: 0 }, Math.PI);
    rebuildSpatial(world);

    targetingSystem(world, DT);
    expect(world.targets.get(hunter)!.targetId).toBe(prey);

    world.queueOrder(prey, { kind: "jettisonCountermeasure" });
    jettisonSystem(world, DT);
    rebuildSpatial(world);
    targetingSystem(world, DT);

    const decoyId = world.decoyIds()[0]!;
    expect(world.targets.get(hunter)!.targetId).toBe(decoyId);
  });

  it("never distracts the team that dropped it", () => {
    const world = makeWorld(configs);
    const ally = ship(world, INTERCEPTOR_FITTING, 0, { x: 0, z: 0 }, 0);
    const dropper = ship(world, INTERCEPTOR_FITTING_CHAFF, 0, { x: 20, z: 0 }, Math.PI);
    const foe = ship(world, INTERCEPTOR_FITTING, 1, { x: 40, z: 0 }, Math.PI);
    rebuildSpatial(world);

    world.queueOrder(dropper, { kind: "jettisonCountermeasure" });
    jettisonSystem(world, DT);
    rebuildSpatial(world);
    targetingSystem(world, DT);

    // The ally looks straight past its own side's sink to the enemy.
    expect(world.targets.get(ally)!.targetId).toBe(foe);
  });

  it("never lets a friendly sensor retain its own team's decoy as a lock", () => {
    const world = makeWorld(configs);
    const ally = ship(world, INTERCEPTOR_FITTING, 0, { x: 0, z: 0 }, 0);
    const dropper = ship(world, INTERCEPTOR_FITTING_CHAFF, 0, { x: 20, z: 0 }, Math.PI);
    rebuildSpatial(world);
    world.queueOrder(dropper, { kind: "jettisonCountermeasure" });
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
    const prey = ship(world, INTERCEPTOR_FITTING_CHAFF, 0, { x: 30, z: 0 }, Math.PI);
    rebuildSpatial(world);
    world.queueOrder(prey, { kind: "jettisonCountermeasure" });
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
    const prey = ship(world, INTERCEPTOR_FITTING_CHAFF, 0, { x: 60, z: 0 }, Math.PI);
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

    world.queueOrder(prey, { kind: "jettisonCountermeasure" });
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
    const prey = ship(world, INTERCEPTOR_FITTING_CHAFF, 1, { x: 60, z: 0 }, Math.PI);
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

    world.queueOrder(prey, { kind: "jettisonCountermeasure" });
    jettisonSystem(world, DT);
    world.transforms.get(world.decoyIds()[0]!)!.pos.x = 20;
    rebuildSpatial(world);

    projectileSystem(world, DT);

    expect(world.projectiles.get(missile)!.targetId).toBe(prey);
  });
});

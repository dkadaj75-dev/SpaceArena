import { beforeAll, describe, expect, it } from "vitest";
import type { ConfigService } from "../core/ConfigService.js";
import type { BotprofileConfig, ShipConfig } from "../schemas/index.js";
import { ArenaSimulation } from "../sim/ArenaSimulation.js";
import { deriveRng } from "../sim/rng.js";
import { loadTestConfigs } from "../sim/testutil.js";
import { BotDriver } from "./BotDriver.js";
import { botBehaviors } from "./behaviors.js";

const DT = 1 / 30;

let configs: ConfigService;
beforeAll(async () => {
  configs = await loadTestConfigs();
});

/**
 * Regression for the live "bots become inactive" report (owner 2026-08-16):
 * bots parked motionless at their spawn pads after a death, in CTF and TDM
 * alike.
 *
 * `gamemode.respawn` destroys a dead hull outright and rebuilds it UNDER ITS
 * OLD ENTITY ID after the delay. A driver that outlives the death therefore
 * meets the returned id holding the DEAD ship's memory — above all the
 * level-triggered `lastFlight` the new hull never received. Whenever the next
 * desired command lands inside the profile's change epsilons of that stale
 * state, the epsilon gate treats the order as already standing and sends
 * nothing, and because a parked hull's context is static, every following
 * decision reproduces the same suppressed command: the ship integrates its
 * default zero throttle at the pad forever. `BotDriver.update` now detects the
 * SIGHTING GAP itself — `snapshot.tick` not directly following the last tick
 * this driver saw its ship — and starts the returned id from `reset()`. A tick
 * gap rather than an "I saw an absence" flag, because half the hosts (the test
 * harnesses, the CTF review tool) skip `update` entirely while the ship is
 * dead, and a flag set inside the absent path would never fire for them. Both
 * host contracts are pinned below.
 * (`ArenaRoom.driveBots` had the harsher form of the same lifecycle bug — it
 * DELETED the driver during the respawn wait — pinned by its own regression in
 * `server/src/rooms/ArenaRoomBotRespawn.test.ts`.)
 *
 * The scripted behaviour aims a fixed offset along the ship's own nose, so the
 * desired command is identical before death and after respawn ({turn 0,
 * pitch 0, throttle 1}) — the deterministic worst case for the epsilon gate.
 */
/**
 * Drive one scripted bot through fly → die → respawn under one of the two host
 * contracts found in this repo, and report what the rebuilt hull did.
 *
 * `updateWhileAbsent: true` is the keep-calling contract (`ArenaRoom`, the
 * client offline session); `false` is the skip-while-dead contract (the test
 * harnesses in CtfBots.test.ts, tools/bot-ctf-review.ts) — the one an
 * absence FLAG inside `update` can never serve, which is why the driver
 * detects the sighting gap instead.
 */
function respawnUnderContract(updateWhileAbsent: boolean): { flightOrders: number; displacement: number } {
  const seed = 7;
  const sim = new ArenaSimulation(configs, "arena.ring-nebula", "gamemode.practice-bots-5v5", seed);
  const ship = configs.get<ShipConfig>("ship", "ship.interceptor")!;
  const shipped = configs.get<BotprofileConfig>("botprofile", "bot.rookie")!;
  const profile = {
    ...shipped,
    id: "bot.cruise-measure",
    behaviors: { cruise: { baseWeight: 1 } },
  } as BotprofileConfig;
  const behaviors = new Map(botBehaviors());
  behaviors.set("cruise", {
    score: () => 1,
    // A point along the CURRENT nose: the steering errors are zero wherever
    // the hull is, so the desired command never changes across the respawn.
    plan: (ctx) => ({
      aim: {
        x: ctx.self.pos.x + Math.cos(ctx.self.pitch) * Math.cos(ctx.self.heading) * 120,
        y: ctx.self.pos.y + Math.sin(ctx.self.pitch) * 120,
        z: ctx.self.pos.z + Math.cos(ctx.self.pitch) * Math.sin(ctx.self.heading) * 120,
      },
      throttle: 1,
      boost: false,
      engaged: false,
    }),
  });
  const id = sim.spawnPlayer(ship.id, ship.defaultFitting, 0);
  const driver = new BotDriver({ entityId: id, profile, configs, rng: deriveRng(seed, id), behaviors });

  let nowMs = 0;
  const step = (): void => {
    nowMs += DT * 1000;
    const snapshot = sim.snapshot();
    // No external reset() anywhere in either contract — the driver is on its own.
    if (sim.hasShip(id) || updateWhileAbsent) {
      for (const order of driver.update(snapshot, nowMs)) sim.applyOrder(id, order);
    }
    sim.tick(DT);
    sim.getEvents();
  };

  // Fly long enough to have decided and settled the level-triggered command.
  for (let tick = 0; tick < 8 / DT && !driver.lastDecision; tick++) step();
  for (let tick = 0; tick < 2 / DT; tick++) step();
  expect(driver.lastDecision?.flight?.throttle).toBe(1);

  // Die the way live ships do (boundary damage), so the destruction emits the
  // event the respawn pipeline consumes.
  sim.world.shipCores.get(id)!.hull = 0.01;
  sim.world.transforms.get(id)!.pos.x = 30_000;
  for (let tick = 0; tick < 5 / DT && sim.hasShip(id); tick++) step();
  expect(sim.hasShip(id)).toBe(false);

  // Wait out `respawn.delay` under the host contract being tested.
  for (let tick = 0; tick < 15 / DT && !sim.hasShip(id); tick++) step();
  expect(sim.hasShip(id)).toBe(true);

  // The rebuilt hull starts from a standstill with a default zero-throttle
  // flight state. Under the stale-memory bug the driver's desired command
  // equals the dead ship's `lastFlight`, so no order is ever re-sent and the
  // ship parks at the pad for the rest of the match.
  const pad = { ...sim.world.transforms.get(id)!.pos };
  let flightOrders = 0;
  for (let tick = 0; tick < 8 / DT && sim.hasShip(id); tick++) {
    nowMs += DT * 1000;
    const snapshot = sim.snapshot();
    for (const order of driver.update(snapshot, nowMs)) {
      if (order.kind === "flight") flightOrders += 1;
      sim.applyOrder(id, order);
    }
    sim.tick(DT);
    sim.getEvents();
  }
  const at = sim.world.transforms.get(id)!.pos;
  return { flightOrders, displacement: Math.hypot(at.x - pad.x, at.y - pad.y, at.z - pad.z) };
}

describe("bot driver across a respawn (owner 2026-08-16)", () => {
  it("resumes flying a respawned hull when the host keeps calling update", () => {
    const { flightOrders, displacement } = respawnUnderContract(true);
    expect(flightOrders, "no flight order reached the respawned hull").toBeGreaterThan(0);
    expect(displacement, `respawned bot moved ${displacement.toFixed(2)} units in 8 s`).toBeGreaterThan(10);
  }, 30_000);

  it("resumes flying when the host SKIPPED update for the whole respawn wait", () => {
    // This is the contract an absence flag cannot serve: update() is never
    // called while the ship is dead, so nothing inside the absent path can run.
    // Only the sighting-gap test fires here.
    const { flightOrders, displacement } = respawnUnderContract(false);
    expect(flightOrders, "no flight order reached the respawned hull").toBeGreaterThan(0);
    expect(displacement, `respawned bot moved ${displacement.toFixed(2)} units in 8 s`).toBeGreaterThan(10);
  }, 30_000);
});

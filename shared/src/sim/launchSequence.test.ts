import { beforeAll, describe, expect, it } from "vitest";
import type { ConfigService } from "../core/ConfigService.js";
import { ArenaSimulation } from "./ArenaSimulation.js";
import { applyDamageToShip } from "./damage.js";
import { INTERCEPTOR_FITTING, loadTestConfigs } from "./testutil.js";

const DT = 1 / 30;
const ARENA = "arena.lunar-rift";
const RESPAWN_MODE = "gamemode.practice-bots";

let configs: ConfigService;
beforeAll(async () => {
  configs = await loadTestConfigs();
});

/** Run the match's own start countdown out so ships go live. */
function goLive(sim: ArenaSimulation): void {
  for (let i = 0; i < 200 && sim.snapshot().phase !== "live"; i++) {
    sim.tick(DT);
    sim.getEvents();
  }
  expect(sim.snapshot().phase).toBe("live");
}

function shipSnap(sim: ArenaSimulation, id: number) {
  const snap = sim.snapshot().ships.find((s) => s.id === id);
  expect(snap, `ship ${id} in snapshot`).toBeDefined();
  return snap!;
}

function destroy(sim: ArenaSimulation, id: number): void {
  applyDamageToShip(sim.world, id, null, 100_000, "kinetic");
  sim.tick(DT);
  sim.getEvents();
  expect(sim.hasShip(id)).toBe(false);
}

describe("spawn launch sequence (pad hold → 50% launch run → control)", () => {
  it("holds on the pad, launches at half throttle, then hands over control", () => {
    const sim = new ArenaSimulation(configs, ARENA, RESPAWN_MODE, 7);
    const id = sim.spawnPlayer("ship.interceptor", INTERCEPTOR_FITTING, 0);
    const spawnPos = { ...sim.world.transforms.get(id)!.pos };
    goLive(sim);

    // During the hold: pinned to the pad, and a full-throttle player order is
    // dropped on the floor.
    sim.applyOrder(id, { kind: "flight", throttle: 1, turn: 1, pitchStick: 0, boost: false, fire: true });
    sim.tick(DT);
    sim.getEvents();
    expect(sim.world.flightStates.get(id)!.throttle).toBe(0);
    expect(sim.world.transforms.get(id)!.pos.x).toBe(spawnPos.x);

    // Hold expires (3 s) → the launch run flies the ship itself at exactly 50%.
    for (let i = 0; i < 30 * 3; i++) { sim.tick(DT); sim.getEvents(); }
    sim.applyOrder(id, { kind: "flight", throttle: 1, turn: 1, pitchStick: 0, boost: false, fire: true });
    sim.tick(DT);
    sim.getEvents();
    expect(sim.world.flightStates.get(id)!.throttle).toBe(0.5);
    expect(sim.world.flightStates.get(id)!.turn).toBe(0);
    expect(sim.world.flightStates.get(id)!.fire).toBe(false);

    // It travels straight out along the spawn heading until clear, then control
    // returns: the same order now sticks.
    for (let i = 0; i < 30 * 5; i++) { sim.tick(DT); sim.getEvents(); }
    const tf = sim.world.transforms.get(id)!;
    const traveled = Math.hypot(tf.pos.x - spawnPos.x, tf.pos.z - spawnPos.z);
    expect(traveled).toBeGreaterThan(20);
    sim.applyOrder(id, { kind: "flight", throttle: 1, turn: 0, pitchStick: 0, boost: false, fire: false });
    sim.tick(DT);
    sim.getEvents();
    expect(sim.world.flightStates.get(id)!.throttle).toBe(1);
  });

  it("a respawn holds 3 seconds on the pad, reports the countdown, and is untouchable until clear", () => {
    const sim = new ArenaSimulation(configs, ARENA, RESPAWN_MODE, 11);
    const id = sim.spawnPlayer("ship.interceptor", INTERCEPTOR_FITTING, 0);
    sim.spawnPlayer("ship.interceptor", INTERCEPTOR_FITTING, 1);
    goLive(sim);
    // Let the opening holds AND launch runs finish (3 s hold + run) so the
    // kill below is a clean baseline.
    for (let i = 0; i < 30 * 9; i++) { sim.tick(DT); sim.getEvents(); }

    destroy(sim, id);
    for (let tick = 0; tick < 300 && !sim.hasShip(id); tick++) { sim.tick(DT); sim.getEvents(); }
    expect(sim.hasShip(id)).toBe(true);

    // Fresh off the rebuild: the pad hold is live and replicated for the HUD.
    const hold0 = shipSnap(sim, id).launchHold ?? 0;
    expect(hold0).toBeGreaterThan(2.5);
    const padPos = { ...sim.world.transforms.get(id)!.pos };

    // Damage during the hold is fully ignored — no hull tick lost.
    const hullBefore = sim.world.shipCores.get(id)!.hull;
    applyDamageToShip(sim.world, id, null, 500, "kinetic");
    expect(sim.world.shipCores.get(id)!.hull).toBe(hullBefore);

    // One second in, the countdown has moved and the ship has not.
    for (let i = 0; i < 30; i++) { sim.tick(DT); sim.getEvents(); }
    const hold1 = shipSnap(sim, id).launchHold ?? 0;
    expect(hold1).toBeLessThan(hold0);
    expect(hold1).toBeGreaterThan(0);
    expect(sim.world.transforms.get(id)!.pos.x).toBe(padPos.x);
    expect(sim.world.transforms.get(id)!.pos.z).toBe(padPos.z);

    // Hold expires → launch run carries it off the pad; protection holds while
    // enrolled, and lifts once the run completes.
    for (let i = 0; i < 30 * 7; i++) { sim.tick(DT); sim.getEvents(); }
    const tf = sim.world.transforms.get(id)!;
    expect(Math.hypot(tf.pos.x - padPos.x, tf.pos.z - padPos.z)).toBeGreaterThan(20);
    expect(shipSnap(sim, id).launchHold ?? 0).toBe(0);
    expect(sim.world.launchProtected.has(id)).toBe(false);
    applyDamageToShip(sim.world, id, null, 10, "kinetic");
    expect(sim.world.shipCores.get(id)!.hull).toBeLessThan(hullBefore);
  });

  it("explicit-position spawns (practice/tutorial) skip the sequence entirely", () => {
    const sim = new ArenaSimulation(configs, ARENA, RESPAWN_MODE, 13);
    const id = sim.spawnPlayerAt("ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 5, z: 5 });
    goLive(sim);
    expect(sim.world.launchProtected.has(id)).toBe(false);
    sim.applyOrder(id, { kind: "flight", throttle: 1, turn: 0, pitchStick: 0, boost: false, fire: false });
    sim.tick(DT);
    sim.getEvents();
    expect(sim.world.flightStates.get(id)!.throttle).toBe(1);
  });
});

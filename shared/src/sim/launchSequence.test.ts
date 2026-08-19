import { beforeAll, describe, expect, it } from "vitest";
import type { ConfigService } from "../core/ConfigService.js";
import { ArenaSimulation, LAUNCH_RUN_SEC } from "./ArenaSimulation.js";
import { applyDamageToShip } from "./damage.js";
import { INTERCEPTOR_FITTING, loadTestConfigs } from "./testutil.js";

const DT = 1 / 30;
const ARENA = "arena.lunar-rift";
const RESPAWN_MODE = "gamemode.practice-bots";

let configs: ConfigService;
/** `loadTestConfigs` zeroes the match countdown; the opening-wave case needs it. */
let countdownConfigs: ConfigService;
beforeAll(async () => {
  configs = await loadTestConfigs();
  countdownConfigs = await loadTestConfigs({ matchCountdownSec: 3 });
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

describe("spawn launch sequence (pad hold → sim-flown run → control at 0)", () => {
  /**
   * The opening wave's hold IS the match countdown, so it enrolls at hold 0 and
   * flies its run on the first live ticks — `launchHold` never leaves 0 and the
   * HUD stays out of the way, but the pilot is still locked out.
   */
  it("flies the opening wave out of the bay with no visible hold, then hands over", () => {
    const sim = new ArenaSimulation(countdownConfigs, ARENA, RESPAWN_MODE, 7);
    const id = sim.spawnPlayer("ship.interceptor", INTERCEPTOR_FITTING, 0);
    const spawnPos = { ...sim.world.transforms.get(id)!.pos };
    expect(sim.matchPhase).toBe("countdown");
    // Locked from the pre-match beat onward, which is what puts the client in
    // its establishing shot before the match clock even starts.
    expect(shipSnap(sim, id).launchLocked).toBe(true);
    expect(shipSnap(sim, id).launchHold ?? 0).toBe(0);
    goLive(sim);

    sim.applyOrder(id, { kind: "flight", throttle: 0, turn: 1, pitchStick: 0, boost: false, fire: true });
    sim.tick(DT);
    sim.getEvents();
    expect(shipSnap(sim, id).launchHold ?? 0).toBe(0);
    expect(shipSnap(sim, id).launchLocked).toBe(true);
    // Forced to full throttle straight away — the run has 1.5 s to clear a bay.
    expect(sim.world.flightStates.get(id)!.throttle).toBe(1);
    expect(sim.world.flightStates.get(id)!.turn).toBe(0);
    expect(sim.world.flightStates.get(id)!.fire).toBe(false);

    // One run later the ship is out of the bay and the pilot has the stick back.
    for (let i = 0; i < Math.ceil(LAUNCH_RUN_SEC / DT); i++) { sim.tick(DT); sim.getEvents(); }
    const tf = sim.world.transforms.get(id)!;
    expect(Math.hypot(tf.pos.x - spawnPos.x, tf.pos.z - spawnPos.z)).toBeGreaterThan(15);
    expect(shipSnap(sim, id).launchLocked).toBe(false);
    sim.applyOrder(id, { kind: "flight", throttle: 0.25, turn: 0, pitchStick: 0, boost: false, fire: false });
    sim.tick(DT);
    sim.getEvents();
    expect(sim.world.flightStates.get(id)!.throttle).toBe(0.25);
  });

  /**
   * The gamified half: the pilot watches the last 1.5 s of their own countdown
   * as a launch, not as a freeze. Pinned through "3", flying through "1", free
   * on "GO".
   */
  it("pins a respawn for half the hold, then flies it out for the rest", () => {
    const sim = new ArenaSimulation(configs, ARENA, RESPAWN_MODE, 5);
    const id = sim.spawnPlayer("ship.interceptor", INTERCEPTOR_FITTING, 0);
    goLive(sim);
    for (let i = 0; i < 30 * 9; i++) { sim.tick(DT); sim.getEvents(); }
    destroy(sim, id);
    for (let tick = 0; tick < 300 && !sim.hasShip(id); tick++) { sim.tick(DT); sim.getEvents(); }
    const padPos = { ...sim.world.transforms.get(id)!.pos };

    // First half of the hold: pinned at zero throttle, countdown still above the
    // run length.
    for (let i = 0; i < 15; i++) { sim.tick(DT); sim.getEvents(); }
    expect(shipSnap(sim, id).launchHold ?? 0).toBeGreaterThan(LAUNCH_RUN_SEC);
    expect(sim.world.flightStates.get(id)!.throttle).toBe(0);
    expect(sim.world.transforms.get(id)!.pos.x).toBe(padPos.x);

    // Crossing into the run: still no control, but now under full thrust.
    for (let i = 0; i < 32; i++) { sim.tick(DT); sim.getEvents(); }
    expect(shipSnap(sim, id).launchHold ?? 0).toBeLessThanOrEqual(LAUNCH_RUN_SEC);
    expect(shipSnap(sim, id).launchLocked).toBe(true);
    expect(sim.world.flightStates.get(id)!.throttle).toBe(1);

    // The countdown and the run end together: control is back exactly at 0, with
    // the ~15u bay interior already behind the ship.
    for (let i = 0; i < 46; i++) { sim.tick(DT); sim.getEvents(); }
    expect(shipSnap(sim, id).launchHold ?? 0).toBe(0);
    expect(shipSnap(sim, id).launchLocked).toBe(false);
    const tf = sim.world.transforms.get(id)!;
    expect(Math.hypot(tf.pos.x - padPos.x, tf.pos.z - padPos.z)).toBeGreaterThan(15);
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

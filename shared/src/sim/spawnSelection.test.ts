import { beforeAll, describe, expect, it } from "vitest";
import type { ConfigService } from "../core/ConfigService.js";
import { ArenaSimulation } from "./ArenaSimulation.js";
import { applyDamageToShip } from "./damage.js";
import { INTERCEPTOR_FITTING, loadTestConfigs } from "./testutil.js";

const DT = 1 / 30;
const ARENA = "arena.ring-nebula";
const RESPAWN_MODE = "gamemode.practice-bots";

let configs: ConfigService;
beforeAll(async () => {
  configs = await loadTestConfigs();
});

function padKey(sim: ArenaSimulation, id: number): string {
  const pos = sim.world.transforms.get(id)!.pos;
  const pad = sim.world.arena.spawnPoints.find(
    (candidate) =>
      candidate.position.x === pos.x &&
      (candidate.position.y ?? 0) === pos.y &&
      candidate.position.z === pos.z,
  );
  if (!pad) throw new Error(`ship ${id} did not spawn on an authored pad`);
  return pad.id;
}

/** Tick and drain like a host, until the normal three-second respawn completes. */
function waitForRespawn(sim: ArenaSimulation, id: number): void {
  for (let tick = 0; tick < 100 && !sim.hasShip(id); tick++) {
    sim.tick(DT);
    sim.getEvents();
  }
  expect(sim.hasShip(id)).toBe(true);
}

function destroy(sim: ArenaSimulation, id: number): void {
  applyDamageToShip(sim.world, id, null, 100_000, "kinetic");
  sim.tick(DT);
  sim.getEvents();
  expect(sim.hasShip(id)).toBe(false);
}

describe("spawn-point selection (owner 2026-08-16)", () => {
  it("gives a 5v5 every authored pad on each side before either side repeats", () => {
    const sim = new ArenaSimulation(configs, ARENA, RESPAWN_MODE, 19);
    const teams = new Map<number, string[]>();

    // Interleaving is intentional: this was the old global-counter failure mode.
    for (let slot = 0; slot < 5; slot++) {
      for (const team of [0, 1]) {
        const id = sim.spawnPlayer("ship.interceptor", INTERCEPTOR_FITTING, team);
        const pads = teams.get(team) ?? [];
        pads.push(padKey(sim, id));
        teams.set(team, pads);
      }
    }

    for (const team of [0, 1]) {
      const authored = sim.world.arena.spawnPoints.filter((pad) => pad.team === team).map((pad) => pad.id);
      expect(authored).toHaveLength(5);
      expect(teams.get(team)).toEqual(authored);
    }
  });

  it("respawns only on a clear pad while any team pad has collider-derived room", () => {
    const sim = new ArenaSimulation(configs, ARENA, RESPAWN_MODE, 23);
    const victim = sim.spawnPlayer("ship.interceptor", INTERCEPTOR_FITTING, 0);
    const pads = sim.world.arena.spawnPoints.filter((pad) => pad.team === 0);
    const safePad = pads[pads.length - 1]!;

    // Occupy every other friendly pad with a live hull. These are deliberately
    // explicit placements: the test is about the selector's clearance decision,
    // not the initial-placement rotation that supplied the fixtures.
    for (const pad of pads.slice(0, -1)) {
      sim.spawnPlayerAt("ship.interceptor", INTERCEPTOR_FITTING, 1, pad.position, pad.heading, undefined, pad.pitch ?? 0);
    }
    destroy(sim, victim);
    waitForRespawn(sim, victim);

    expect(padKey(sim, victim)).toBe(safePad.id);
    const spawned = sim.world.transforms.get(victim)!.pos;
    const spawnedRadius = sim.world.colliders.get(victim)!.radius;
    for (const id of sim.world.shipIds()) {
      if (id === victim) continue;
      const other = sim.world.transforms.get(id)!.pos;
      const clearance = (spawnedRadius + sim.world.colliders.get(id)!.radius) * 1.1;
      expect(Math.hypot(spawned.x - other.x, spawned.y - other.y, spawned.z - other.z)).toBeGreaterThanOrEqual(clearance);
    }
  });

  it("uses the least-crowded pad instead of failing when every team pad is occupied", () => {
    const sim = new ArenaSimulation(configs, ARENA, RESPAWN_MODE, 29);
    const victim = sim.spawnPlayerAt("ship.interceptor", INTERCEPTOR_FITTING, 0, { x: 0, y: 0, z: 0 });
    const pads = sim.world.arena.spawnPoints.filter((candidate) => candidate.team === 0);
    const leastCrowded = pads[pads.length - 1]!;
    for (const pad of pads) {
      // 2.8 is inside two interceptor radii plus the selector's safety factor,
      // but gives this one pad more room than the exact-on-pad occupants.
      const position = pad === leastCrowded ? { ...pad.position, x: pad.position.x + 2.8 } : pad.position;
      sim.spawnPlayerAt("ship.interceptor", INTERCEPTOR_FITTING, 1, position, pad.heading, undefined, pad.pitch ?? 0);
    }

    destroy(sim, victim);
    expect(() => waitForRespawn(sim, victim)).not.toThrow();
    expect(padKey(sim, victim)).toBe(leastCrowded.id);
  });

  it("replays the same seeded respawn sequence exactly", () => {
    const sequence = (seed: number): string[] => {
      const sim = new ArenaSimulation(configs, ARENA, RESPAWN_MODE, seed);
      const id = sim.spawnPlayer("ship.interceptor", INTERCEPTOR_FITTING, 0);
      const result: string[] = [];
      for (let death = 0; death < 4; death++) {
        destroy(sim, id);
        waitForRespawn(sim, id);
        result.push(padKey(sim, id));
      }
      return result;
    };

    expect(sequence(31)).toEqual(sequence(31));
  });
});

import { beforeAll, describe, expect, it } from "vitest";
import type { ConfigService } from "../../core/ConfigService.js";
import { ArenaSimulation, type FlagSnapshot } from "../ArenaSimulation.js";
import { applyDamageToShip } from "../damage.js";
import type { EntityId } from "../components.js";
import { INTERCEPTOR_FITTING, INTERCEPTOR_FITTING_BOOST, loadTestConfigs } from "../testutil.js";

const DT = 1 / 30;
/**
 * Open space in `arena.ring-nebula`: clear of the colossal centrepiece and every
 * belt rock, well inside the bubble. Ships parked anywhere near the middle get
 * shoved out by the collision system, which would move the flag with them.
 */
const OPEN = { x: 0, y: 0, z: 90 };
const OPEN_2 = { x: 0, y: -90, z: 0 };
const CTF = "gamemode.practice-ctf-5v5";
const ARENA = "arena.ring-nebula";

let configs: ConfigService;
beforeAll(async () => {
  configs = await loadTestConfigs();
});

function ctfSim(): ArenaSimulation {
  return new ArenaSimulation(configs, ARENA, CTF, 7);
}

const flagOf = (sim: ArenaSimulation, team: number): FlagSnapshot =>
  sim.snapshot().flags.find((f) => f.team === team)!;

/** Put a ship exactly on a point, at rest. */
function place(sim: ArenaSimulation, id: EntityId, at: { x: number; y: number; z: number }): void {
  const tf = sim.world.transforms.get(id)!;
  tf.pos.x = at.x;
  tf.pos.y = at.y;
  tf.pos.z = at.z;
  const vel = sim.world.velocities.get(id)!;
  vel.x = vel.y = vel.z = 0;
}

function tick(sim: ArenaSimulation, n = 1): void {
  for (let i = 0; i < n; i++) {
    sim.tick(DT);
    sim.getEvents();
  }
}

/** Tick once and hand back what the sim announced. */
function tickEvents(sim: ArenaSimulation, n = 1) {
  const out = [];
  for (let i = 0; i < n; i++) {
    sim.tick(DT);
    out.push(...sim.getEvents());
  }
  return out;
}

describe("flags exist because the MODE says so (owner 2026-07-31)", () => {
  it("stands one flag on each authored base, at home", () => {
    const flags = ctfSim().snapshot().flags;
    expect(flags).toHaveLength(2);
    for (const f of flags) {
      expect(f.state).toBe("home");
      expect(f.carrierId).toBeNull();
      expect(f.pos).toEqual(f.home);
      expect(f.trail).toEqual([]);
    }
    expect(new Set(flags.map((f) => f.team))).toEqual(new Set([0, 1]));
  });

  it("spawns none in a mode without a ctf block, even on the same arena", () => {
    const plain = new ArenaSimulation(configs, ARENA, "gamemode.practice-bots-5v5", 7);
    expect(plain.snapshot().flags).toEqual([]);
  });
});

describe("taking a flag", () => {
  it("uses the authored 7.5-unit flag pickup radius, without enlarging the capture base", () => {
    const sim = ctfSim();
    const runner = sim.spawnPlayer("ship.interceptor", INTERCEPTOR_FITTING, 0);
    const enemy = flagOf(sim, 1);
    // The interceptor collision radius is 1.4, so 8 units is outside the old
    // 5 + 1.4 reach but inside the new 7.5 + 1.4 loose/home-flag reach.
    place(sim, runner, { x: enemy.home.x + 8, y: enemy.home.y, z: enemy.home.z });

    expect(tickEvents(sim)).toContainEqual(
      expect.objectContaining({ type: "flagTaken", flagTeam: 1, carrierId: runner }),
    );
    expect(sim.world.flags.get(enemy.id)!.baseRadius).toBe(16);
  });

  it("is done by flying through the enemy's, and makes you the carrier", () => {
    const sim = ctfSim();
    const runner = sim.spawnPlayer("ship.interceptor", INTERCEPTOR_FITTING, 0);
    place(sim, runner, flagOf(sim, 1).home);

    const events = tickEvents(sim);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "flagTaken", flagTeam: 1, carrierId: runner, carrierTeam: 0 }),
    );
    const flag = flagOf(sim, 1);
    expect(flag.state).toBe("carried");
    expect(flag.carrierId).toBe(runner);
  });

  it("does NOTHING when you fly through your own flag at home", () => {
    const sim = ctfSim();
    const defender = sim.spawnPlayer("ship.interceptor", INTERCEPTOR_FITTING, 0);
    place(sim, defender, flagOf(sim, 0).home);

    const events = tickEvents(sim, 5);
    expect(events.filter((e) => e.type === "flagTaken")).toEqual([]);
    expect(flagOf(sim, 0).state).toBe("home");
  });

  it.each([
    ["friendly lower id", [0, 1]],
    ["friendly higher id", [1, 0]],
  ] as const)("lets an enemy take a home flag with a simultaneous %s defender", (_order, teams) => {
    const sim = ctfSim();
    const first = sim.spawnPlayer("ship.interceptor", INTERCEPTOR_FITTING, teams[0]);
    const second = sim.spawnPlayer("ship.interceptor", INTERCEPTOR_FITTING, teams[1]);
    const defender = teams[0] === 0 ? first : second;
    const runner = teams[0] === 1 ? first : second;
    const home = flagOf(sim, 0).home;
    place(sim, defender, home);
    place(sim, runner, home);

    expect(defender < runner).toBe(teams[0] === 0);
    const events = tickEvents(sim);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "flagTaken", flagTeam: 0, carrierId: runner, carrierTeam: 1 }),
    );
    expect(flagOf(sim, 0)).toMatchObject({ state: "carried", carrierId: runner });
  });

  it("cannot be taken off a carrier — you have to kill them first", () => {
    const sim = ctfSim();
    const runner = sim.spawnPlayer("ship.interceptor", INTERCEPTOR_FITTING, 0);
    const thief = sim.spawnPlayer("ship.interceptor", INTERCEPTOR_FITTING, 0);
    place(sim, runner, flagOf(sim, 1).home);
    tick(sim);
    place(sim, thief, sim.world.transforms.get(runner)!.pos);
    tick(sim, 3);
    expect(flagOf(sim, 1).carrierId).toBe(runner);
  });

  it("rides along with the carrier", () => {
    const sim = ctfSim();
    const runner = sim.spawnPlayer("ship.interceptor", INTERCEPTOR_FITTING, 0);
    place(sim, runner, flagOf(sim, 1).home);
    tick(sim);
    place(sim, runner, OPEN);
    tick(sim);
    expect(flagOf(sim, 1).pos).toEqual(OPEN);
  });
});

describe("a carrier cannot boost", () => {
  const boostedSpeed = (sim: ArenaSimulation, id: EntityId): number => {
    sim.applyOrder(id, { kind: "flight", throttle: 1, turn: 0, pitchStick: 0, boost: true, fire: false });
    tick(sim, 60);
    const v = sim.world.velocities.get(id)!;
    return Math.hypot(v.x, v.y, v.z);
  };

  it("flies slower with the flag than the same hull flies without it", () => {
    const free = ctfSim();
    const a = free.spawnPlayer("ship.interceptor", INTERCEPTOR_FITTING_BOOST, 0);
    place(free, a, { x: 0, y: 0, z: 0 });
    const openSpeed = boostedSpeed(free, a);

    const laden = ctfSim();
    const b = laden.spawnPlayer("ship.interceptor", INTERCEPTOR_FITTING_BOOST, 0);
    place(laden, b, flagOf(laden, 1).home);
    tick(laden);
    expect(flagOf(laden, 1).carrierId).toBe(b);
    const ladenSpeed = boostedSpeed(laden, b);

    expect(ladenSpeed).toBeLessThan(openSpeed);
  });
});

describe("dropping a flag", () => {
  it("leaves it where the carrier died, with a clock running", () => {
    const sim = ctfSim();
    const runner = sim.spawnPlayer("ship.interceptor", INTERCEPTOR_FITTING, 0);
    place(sim, runner, flagOf(sim, 1).home);
    tick(sim);
    const deathSpot = OPEN;
    place(sim, runner, deathSpot);
    tick(sim);

    applyDamageToShip(sim.world, runner, runner, 100000, "kinetic");
    const events = tickEvents(sim);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "flagDropped", flagTeam: 1, carrierId: runner, returnSec: 10 }),
    );
    const flag = flagOf(sim, 1);
    expect(flag.state).toBe("dropped");
    expect(flag.pos).toEqual(deathSpot);
    expect(flag.dropRemaining).toBeGreaterThan(9);
  });

  it("returns itself home when nobody comes for it", () => {
    const sim = ctfSim();
    const runner = sim.spawnPlayer("ship.interceptor", INTERCEPTOR_FITTING, 0);
    place(sim, runner, flagOf(sim, 1).home);
    tick(sim);
    place(sim, runner, OPEN);
    tick(sim);
    applyDamageToShip(sim.world, runner, runner, 100000, "kinetic");
    tick(sim);

    const events = tickEvents(sim, Math.ceil(10 / DT) + 2);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "flagReturned", flagTeam: 1, byId: null, timedOut: true }),
    );
    const flag = flagOf(sim, 1);
    expect(flag.state).toBe("home");
    expect(flag.pos).toEqual(flag.home);
  });

  it("goes straight home when a DEFENDER touches it", () => {
    const sim = ctfSim();
    const runner = sim.spawnPlayer("ship.interceptor", INTERCEPTOR_FITTING, 0);
    const defender = sim.spawnPlayer("ship.interceptor", INTERCEPTOR_FITTING, 1);
    place(sim, runner, flagOf(sim, 1).home);
    tick(sim);
    const loose = OPEN;
    place(sim, runner, loose);
    tick(sim);
    applyDamageToShip(sim.world, runner, runner, 100000, "kinetic");
    tick(sim);
    expect(flagOf(sim, 1).state).toBe("dropped");

    place(sim, defender, loose);
    const events = tickEvents(sim);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "flagReturned", flagTeam: 1, byId: defender, timedOut: false }),
    );
    expect(flagOf(sim, 1).state).toBe("home");
  });

  it("is picked back up by another ATTACKER, continuing the run", () => {
    const sim = ctfSim();
    const runner = sim.spawnPlayer("ship.interceptor", INTERCEPTOR_FITTING, 0);
    const mate = sim.spawnPlayer("ship.interceptor", INTERCEPTOR_FITTING, 0);
    place(sim, runner, flagOf(sim, 1).home);
    tick(sim);
    const loose = OPEN;
    place(sim, runner, loose);
    tick(sim);
    applyDamageToShip(sim.world, runner, runner, 100000, "kinetic");
    tick(sim);

    place(sim, mate, loose);
    tick(sim);
    expect(flagOf(sim, 1).state).toBe("carried");
    expect(flagOf(sim, 1).carrierId).toBe(mate);
  });
});

describe("capturing", () => {
  /** Take team 1's flag and stand in team 0's base. */
  function runToBase(sim: ArenaSimulation, runner: EntityId): void {
    place(sim, runner, flagOf(sim, 1).home);
    tick(sim);
    place(sim, runner, flagOf(sim, 0).home);
  }

  it("scores when the enemy flag reaches your base and yours is home", () => {
    const sim = ctfSim();
    const runner = sim.spawnPlayer("ship.interceptor", INTERCEPTOR_FITTING, 0);
    runToBase(sim, runner);

    const events = tickEvents(sim);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "flagCaptured", flagTeam: 1, scoringTeam: 0, carrierId: runner, captures: 1 }),
    );
    // The captured flag goes straight back to its own stand.
    const enemyFlag = flagOf(sim, 1);
    expect(enemyFlag.state).toBe("home");
    expect(enemyFlag.pos).toEqual(enemyFlag.home);
    expect(sim.snapshot().teamScores.find((s) => s.team === 0)!.captures).toBe(1);
  });

  it("does NOT score while your own flag is out — that is the whole mode", () => {
    const sim = ctfSim();
    const runner = sim.spawnPlayer("ship.interceptor", INTERCEPTOR_FITTING, 0);
    const enemy = sim.spawnPlayer("ship.interceptor", INTERCEPTOR_FITTING, 1);
    // The enemy takes ours first, so ours is not home.
    place(sim, enemy, flagOf(sim, 0).home);
    tick(sim);
    expect(flagOf(sim, 0).state).toBe("carried");

    runToBase(sim, runner);
    const events = tickEvents(sim, 5);
    expect(events.filter((e) => e.type === "flagCaptured")).toEqual([]);
    expect(flagOf(sim, 1).carrierId).toBe(runner);
  });

  it("ends the match at three captures", () => {
    const sim = ctfSim();
    const runner = sim.spawnPlayer("ship.interceptor", INTERCEPTOR_FITTING, 0);
    sim.spawnPlayer("ship.interceptor", INTERCEPTOR_FITTING, 1);

    for (let i = 0; i < 3; i++) {
      runToBase(sim, runner);
      tick(sim);
    }
    expect(sim.snapshot().teamScores.find((s) => s.team === 0)!.captures).toBe(3);
    expect(sim.isEnded).toBe(true);
    expect(sim.snapshot().winnerTeam).toBe(0);
  });
});

describe("the flag's wake", () => {
  it("grows behind a moving flag and clears the moment it is home", () => {
    const sim = ctfSim();
    const runner = sim.spawnPlayer("ship.interceptor", INTERCEPTOR_FITTING, 0);
    place(sim, runner, flagOf(sim, 1).home);
    tick(sim);

    for (let step = 1; step <= 20; step++) {
      place(sim, runner, { x: OPEN_2.x + step * 3, y: OPEN_2.y, z: OPEN_2.z });
      tick(sim);
    }
    const trail = flagOf(sim, 1).trail;
    expect(trail.length).toBeGreaterThan(2);

    // Trail length is bounded by the mode's authored trailLength (100 units).
    let length = 0;
    for (let i = 1; i < trail.length; i++) {
      length += Math.hypot(
        trail[i]!.x - trail[i - 1]!.x,
        trail[i]!.y - trail[i - 1]!.y,
        trail[i]!.z - trail[i - 1]!.z,
      );
    }
    expect(length).toBeLessThanOrEqual(110);

    place(sim, runner, flagOf(sim, 0).home);
    tick(sim);
    expect(flagOf(sim, 1).trail).toEqual([]);
  });
});

describe("determinism", () => {
  it("two sims fed the same inputs agree on every flag", () => {
    const run = () => {
      const sim = ctfSim();
      const runner = sim.spawnPlayer("ship.interceptor", INTERCEPTOR_FITTING, 0);
      place(sim, runner, flagOf(sim, 1).home);
      tick(sim, 3);
      for (let i = 0; i < 30; i++) {
        place(sim, runner, { x: OPEN.x + i, y: OPEN.y, z: OPEN.z });
        tick(sim);
      }
      return sim.snapshot().flags;
    };
    expect(run()).toEqual(run());
  });
});

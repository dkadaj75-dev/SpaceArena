import { describe, expect, it } from "vitest";

import type { AsteroidSnapshot, ShipSnapshot, Snapshot } from "../sim/ArenaSimulation.js";
import type { BotPlan } from "./behaviors.js";
import { RecoveryController } from "./recovery.js";

function ship(over: Partial<ShipSnapshot> = {}): ShipSnapshot {
  return {
    id: 1, team: 0, pos: { x: 0, y: 0, z: 0 }, pitch: 0, up: { x: 0, y: 1, z: 0 }, heading: 0,
    hull: 100, hullMax: 100, targetId: null, throttle: 1, lockProgress: 0, locked: false, modules: [],
    colliderRadius: 1.4, velocity: { x: 0, y: 0, z: 0 },
    ...over,
  };
}

function snap(self: ShipSnapshot, asteroids: AsteroidSnapshot[] = []): Snapshot {
  return {
    tick: 1, elapsed: 1, phase: "live", teamScores: [], countdownRemaining: 0, winnerTeam: null,
    ships: [self], asteroids, projectiles: [], decoys: [], flags: [],
  };
}

const travelling: BotPlan = { aim: { x: 0, y: 0, z: 100 }, throttle: 1, boost: false, engaged: false };

/** Run the guard past its arming window against an unchanging frame. */
function press(
  controller: RecoveryController,
  snapshot: Snapshot,
  self: ShipSnapshot,
  untilMs: number,
  plan: BotPlan = travelling,
): BotPlan | null {
  let result: BotPlan | null = plan;
  for (let nowMs = 0; nowMs <= untilMs; nowMs += 100) {
    result = controller.plan(snapshot, self, plan, nowMs, 1);
  }
  return result;
}

describe("L0 recovery controller (D1, owner 2026-08-08)", () => {
  it("composes the outward normal of every active contact, not just the nearest", () => {
    // Wedged in the seam: the floor plane below and a rock to −x. Pushing off
    // either one alone presses the hull into the other.
    const self = ship({ pos: { x: 0, y: 1.4, z: 0 } });
    const rock: AsteroidSnapshot = {
      id: 9, configId: "asteroid.fixture-sphere", pos: { x: -9.4, y: 1.4, z: 0 }, radius: 8,
      colliderRadius: 8, state: "intact",
    };
    const controller = new RecoveryController({ floorY: 0, orbitSign: 1, visualRadius: 1.4 });
    // A destination the rock does not stand in front of, so the corridor rung
    // above this one has nothing to route around.
    const away: BotPlan = { aim: { x: 60, y: 1.4, z: 0 }, throttle: 1, boost: false, engaged: false };
    const escape = press(controller, snap(self, [rock]), self, 2_000, away);

    expect(controller.owningFlight).toBe(true);
    // Up AND away from the rock, which is what neither single normal answers.
    expect(escape!.aim!.y).toBeGreaterThan(self.pos.y);
    expect(escape!.aim!.x).toBeGreaterThan(self.pos.x);
  });

  it("never becomes an absorbing state: a pinned hull releases within a bounded time", () => {
    // The frame never changes, so the escape can never measure clearance — the
    // exact shape of the parked-nose-down deadlock (69639cd), one layer up.
    const self = ship({ pos: { x: 0, y: 1.4, z: 0 } });
    const controller = new RecoveryController({ floorY: 0, orbitSign: 1 });
    press(controller, snap(self), self, 2_000);
    expect(controller.owningFlight).toBe(true);

    let released = false;
    for (let nowMs = 2_000; nowMs <= 12_000 && !released; nowMs += 100) {
      controller.plan(snap(self), self, travelling, nowMs, 1);
      released = !controller.owningFlight;
    }
    expect(released).toBe(true);
  });

  it("leaves a legitimate hold alone — a cut throttle in open space is waiting, not stuck", () => {
    const self = ship({ pos: { x: 0, y: 60, z: 0 }, throttle: 0 });
    const controller = new RecoveryController({ floorY: 0, orbitSign: 1 });
    const holding: BotPlan = { aim: { x: 0, y: 60, z: 4 }, throttle: 0, boost: false, engaged: false };
    for (let nowMs = 0; nowMs <= 10_000; nowMs += 100) {
      expect(controller.plan(snap(self), self, holding, nowMs, 0)).toBe(holding);
    }
    expect(controller.owningFlight).toBe(false);
  });

  it("treats a hull skimming past a rock as flight, however close it renders", () => {
    // Collider gap 0.10 against a 2.20 rendered overhang: this is inside the
    // contact band and the hull is nonetheless travelling 2 units per decision.
    const rock: AsteroidSnapshot = {
      id: 9, configId: "asteroid.fixture-sphere", pos: { x: -9.5, y: 40, z: 0 }, radius: 8,
      colliderRadius: 8, state: "intact",
    };
    const controller = new RecoveryController({ orbitSign: 1, visualRadius: 3.6 });
    for (let nowMs = 0; nowMs <= 5_000; nowMs += 100) {
      const self = ship({ pos: { x: 0, y: 40, z: -40 + nowMs / 50 }, velocity: { x: 0, y: 0, z: 20 } });
      controller.plan(snap(self, [rock]), self, travelling, nowMs, 1);
    }
    expect(controller.owningFlight).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import type { FlagSnapshot, ShipSnapshot, Snapshot } from "../sim/ArenaSimulation.js";
import { allocateTeamRoles, clearRoleAllocationCache, ROLE_WINDOW_MS, type BotRole } from "./roleAllocator.js";

function ship(id: number, team: number, x: number, z: number, over: Partial<ShipSnapshot> = {}): ShipSnapshot {
  return {
    id, team, pos: { x, y: 0, z }, pitch: 0, up: { x: 0, y: 1, z: 0 }, heading: 0,
    hull: 100, hullMax: 100, targetId: null, throttle: 0, lockProgress: 0, locked: false, modules: [],
    ...over,
  };
}

function flag(id: number, team: number, x: number, z: number, over: Partial<FlagSnapshot> = {}): FlagSnapshot {
  return {
    id, team, state: "home", carrierId: null,
    pos: { x, y: 0, z }, home: { x, y: 0, z },
    baseRadius: 6, pickupRadius: 3, dropRemaining: 0, trail: [],
    ...over,
  };
}

function snap(ships: ShipSnapshot[], flags: FlagSnapshot[], elapsed = 1): Snapshot {
  return {
    tick: Math.round(elapsed * 30), elapsed, phase: "live", teamScores: [], countdownRemaining: 0,
    winnerTeam: null, ships, asteroids: [], projectiles: [], decoys: [], flags,
  };
}

/** Ten hulls of team 0 strung out between the two bases, plus one enemy. */
function tenVersusOne(over: Partial<ShipSnapshot> = {}): ShipSnapshot[] {
  return [
    ...Array.from({ length: 10 }, (_, index) => ship(10 + index, 0, 0, -100 + index * 22, over)),
    ship(90, 1, 0, 400),
  ];
}

const HOME_FLAGS = [flag(1, 0, 0, -200), flag(2, 1, 0, 200)];

function roleOf(allocation: { roles: ReadonlyMap<number, BotRole> }, id: number): BotRole {
  return allocation.roles.get(id) ?? "free";
}

describe("team role allocator (D2, owner 2026-08-08)", () => {
  it("is inert outside capture the flag — every ship stays a free agent", () => {
    clearRoleAllocationCache();
    const allocation = allocateTeamRoles(snap(tenVersusOne(), []), 0);
    expect(allocation.roles.size).toBe(0);
    expect(allocation.counts.free).toBe(0);
  });

  it("presses the attack while both flags are home and still holds the stand", () => {
    clearRoleAllocationCache();
    const allocation = allocateTeamRoles(snap(tenVersusOne(), HOME_FLAGS), 0);
    expect(allocation.counts).toEqual({ striker: 4, interceptor: 0, escort: 0, warden: 2, free: 4 });
    // Claims go to the ships nearest the job: strikers from the enemy end, the
    // stand to the hulls already sitting on it.
    expect(roleOf(allocation, 19)).toBe("striker");
    expect(roleOf(allocation, 10)).toBe("warden");
  });

  it("commits a full 5v5 press while a lone survivor still attacks", () => {
    clearRoleAllocationCache();
    const solo = allocateTeamRoles(snap([ship(10, 0, 0, 0), ship(90, 1, 0, 400)], HOME_FLAGS), 0);
    expect(solo.counts.striker).toBe(1);
    expect(solo.counts.warden).toBe(0);

    clearRoleAllocationCache();
    const half = allocateTeamRoles(snap([
      ...Array.from({ length: 5 }, (_, index) => ship(10 + index, 0, 0, -100 + index * 44)),
      ship(90, 1, 0, 400),
    ], HOME_FLAGS), 0);
    expect(half.counts.striker).toBe(4);
    expect(half.counts.warden).toBe(1);
  });

  it("ignores a hull waiting to respawn", () => {
    clearRoleAllocationCache();
    const allocation = allocateTeamRoles(snap(tenVersusOne({ hull: 0 }), HOME_FLAGS), 0);
    expect(allocation.roles.size).toBe(0);
  });

  it("fields interceptors the moment our flag is stolen", () => {
    clearRoleAllocationCache();
    const flags = [flag(1, 0, 0, -200, { state: "carried", carrierId: 90, pos: { x: 0, y: 0, z: 300 } }), flag(2, 1, 0, 200)];
    const allocation = allocateTeamRoles(snap(tenVersusOne(), flags), 0);
    expect(allocation.counts.interceptor).toBe(2);
    expect(allocation.counts.striker).toBe(3); // no longer a free run — press eases off
    expect(allocation.counts.warden).toBe(2);
  });

  it("caps a dropped-flag rescue at two ships instead of drawing the team", () => {
    clearRoleAllocationCache();
    const flags = [flag(1, 0, 0, -200, { state: "dropped", pos: { x: 40, y: 0, z: -40 }, dropRemaining: 20 }), flag(2, 1, 0, 200)];
    const allocation = allocateTeamRoles(snap(tenVersusOne(), flags), 0);
    expect(allocation.counts.warden).toBe(2);
    expect(allocation.counts.striker).toBe(3);
  });

  it("makes our carrier the striker and screens it with two escorts", () => {
    clearRoleAllocationCache();
    const flags = [flag(1, 0, 0, -200), flag(2, 1, 0, 200, { state: "carried", carrierId: 14, pos: { x: 0, y: 0, z: 48 } })];
    const allocation = allocateTeamRoles(snap(tenVersusOne(), flags), 0);
    expect(roleOf(allocation, 14)).toBe("striker");
    expect(allocation.counts.escort).toBe(2);
    // The enemy flag is in our hands, so nobody is claiming a second run.
    expect(allocation.counts.striker).toBe(1);
  });

  it("adds a third escort when a damaged 5v5 carrier is overwhelmed", () => {
    const members = Array.from({ length: 5 }, (_, index) => ship(10 + index, 0, 0, -80 + index * 35));
    members[4] = ship(14, 0, 0, 60, { hull: 50 });
    const carried = flag(2, 1, 0, 200, { state: "carried", carrierId: 14, pos: { x: 0, y: 0, z: 60 } });

    clearRoleAllocationCache();
    const calm = allocateTeamRoles(snap([...members, ship(90, 1, 300, 300)], [HOME_FLAGS[0]!, carried]), 0);
    expect(calm.counts.escort).toBe(2);

    clearRoleAllocationCache();
    const pressured = allocateTeamRoles(snap([
      ...members,
      ship(90, 1, 20, 60),
      ship(91, 1, -20, 60),
      ship(92, 1, 0, 90),
    ], [HOME_FLAGS[0]!, carried]), 0);
    expect(pressured.counts.escort).toBe(3);
  });

  it("hands every driver on the team the same board, from the shared snapshot alone", () => {
    clearRoleAllocationCache();
    const snapshot = snap(tenVersusOne(), HOME_FLAGS);
    const first = allocateTeamRoles(snapshot, 0);
    clearRoleAllocationCache();
    const second = allocateTeamRoles(snapshot, 0);
    expect([...second.roles.entries()]).toEqual([...first.roles.entries()]);
  });

  it("holds a board for its window and re-bids once the window turns over", () => {
    clearRoleAllocationCache();
    const early = allocateTeamRoles(snap(tenVersusOne(), HOME_FLAGS, 1), 0);
    // Same window, ships reversed along the axis: the held board must not move.
    const moved = tenVersusOne().map((s) => (s.team === 0 ? ship(s.id, 0, 0, 100 - (s.id - 10) * 22) : s));
    const held = allocateTeamRoles(snap(moved, HOME_FLAGS, 1 + (ROLE_WINDOW_MS / 1000) * 0.3), 0);
    expect([...held.roles.entries()]).toEqual([...early.roles.entries()]);
    const rebid = allocateTeamRoles(snap(moved, HOME_FLAGS, 1 + (ROLE_WINDOW_MS / 1000) * 1.5), 0);
    expect([...rebid.roles.entries()]).not.toEqual([...early.roles.entries()]);
  });

  it("re-bids inside the window as soon as a flag event lands", () => {
    clearRoleAllocationCache();
    const before = allocateTeamRoles(snap(tenVersusOne(), HOME_FLAGS, 1), 0);
    const stolen = [flag(1, 0, 0, -200, { state: "carried", carrierId: 90, pos: { x: 0, y: 0, z: 300 } }), flag(2, 1, 0, 200)];
    const after = allocateTeamRoles(snap(tenVersusOne(), stolen, 1.1), 0);
    expect(before.counts.interceptor).toBe(0);
    expect(after.counts.interceptor).toBe(2);
  });
});

import { describe, expect, it } from "vitest";
import { WIRE_FIELDS, checkWireState, encodeCenti, encodeFlagState } from "@space-arena/shared";

/**
 * The client half of the wire field-name contract (see
 * `shared/src/net/wireFields.ts`).
 *
 * The exhaustive per-class assertion lives on the SERVER, where every schema
 * class can be constructed and CI can fail the build on a rename. What runs on
 * the client is {@link checkWireState}, once, on the first authoritative patch
 * in `NetGameSession.receiveState` — the backstop for a deployed server whose
 * schema drifted from the bundle a browser is running, which CI structurally
 * cannot observe. These tests pin what that check actually detects, so that the
 * one call in the hot path is not a decoration.
 */

/** A minimal state whose field names are typed out by hand, exactly as the room sends them. */
function wireState(): Record<string, unknown> {
  return {
    matchPhase: "live",
    matchTimer: 12.5,
    countdownRemaining: 0,
    lobbyRemainingSec: 0,
    winnerTeam: -1,
    teamScores: { 0: { kills: 3, captures: 1 } },
    players: {
      abc: {
        entityId: 7, team: 0, shipId: "ship.interceptor", displayName: "Pilot", isBot: false,
        alive: true, cosmeticId: "", x: encodeCenti(1), y: encodeCenti(2), z: encodeCenti(3),
        heading: 0, pitch: 0, upX: 0, upY: 1, upZ: 0, hull: 50, hullMax: 60,
        shieldPool: 0, throttle: 0, launchHold: 0, lockProgress: 0, locked: false, targetId: -1,
        modules: [{
          moduleId: "module.laser-mk1", hardpointIndex: 0, state: 2, stateTimer: 0, rounds: 0,
          heat: 0, heatCapacity: 4, energy: 0, energyCapacity: 0, cycleTimer: 0,
          channeling: false, shieldPool: 0,
        }],
      },
    },
    projectiles: { 11: { entityId: 11, x: 0, y: 0, z: 0, heading: 0 } },
    asteroids: { 0: { destroyed: false } },
    decoys: { 9: { entityId: 9, team: 1, x: 0, y: 0, z: 0, radius: 4, lifeFraction: 0.5 } },
    flags: {
      17: {
        entityId: 17, team: 0, state: encodeFlagState("carried"), x: 0, y: 0, z: 0,
        carrierEntityId: 42, dropRemaining: 0,
      },
    },
  };
}

describe("client wire field-name check", () => {
  it("accepts a state whose names match the contract", () => {
    // Hand-written names, not names read out of WIRE_FIELDS — so a rename that
    // edits the frozen list without touching the decoders still fails here.
    expect(checkWireState(wireState())).toEqual([]);
  });

  it("catches a renamed leaf field on a map entry", () => {
    const state = wireState();
    const flag = (state["flags"] as Record<string, Record<string, unknown>>)["17"]!;
    flag["dropSec"] = flag["dropRemaining"];
    delete flag["dropRemaining"];
    expect(checkWireState(state)).toEqual([
      "FlagState: missing [dropRemaining], unexpected [dropSec]",
    ]);
  });

  it("catches a renamed field on the root state and inside the nested module array", () => {
    const state = wireState();
    state["countdownSec"] = state["countdownRemaining"];
    delete state["countdownRemaining"];
    const player = (state["players"] as Record<string, Record<string, unknown>>)["abc"]!;
    const mod = (player["modules"] as Record<string, unknown>[])[0]!;
    mod["heatMax"] = mod["heatCapacity"];
    delete mod["heatCapacity"];
    expect(checkWireState(state)).toEqual([
      "ArenaState: missing [countdownRemaining], unexpected [countdownSec]",
      "ModuleState: missing [heatCapacity], unexpected [heatMax]",
    ]);
  });

  it("catches a reordering, because colyseus encodes fields by declaration index", () => {
    const state = wireState();
    const score = { captures: 1, kills: 3 }; // declared kills-first
    state["teamScores"] = { 0: score };
    expect(checkWireState(state)[0]).toContain("TeamScoreState: wire field ORDER changed");
  });

  it("stays quiet on empty collections and on an opaque state object", () => {
    // An empty map proves nothing about its value class, and a state with no
    // enumerable keys is far more likely to be a proxy than an 11-field rename.
    const state = wireState();
    state["decoys"] = {};
    state["flags"] = {};
    expect(checkWireState(state)).toEqual([]);
    expect(checkWireState({})).toEqual([]);
    expect(checkWireState(undefined)).toEqual([]);
  });

  it("keeps the frozen lists frozen", () => {
    expect(Object.isFrozen(WIRE_FIELDS)).toBe(true);
    expect(Object.isFrozen(WIRE_FIELDS.PlayerState)).toBe(true);
  });
});

import { describe, expect, it, vi } from "vitest";
import type {
  ConfigService,
  ModuleConfig,
  ShipSnapshot,
  SimEvent,
  Snapshot,
  TutorialConfig,
  TutorialStep,
} from "@space-arena/shared";
import type { GameSession, ScriptedSpawn } from "../GameSession.js";
import {
  TutorialDirector,
  type TutorialHost,
  type TutorialOutcome,
  type TutorialStepView,
} from "./TutorialDirector.js";

const PLAYER = 1 as const;

function tutorial(steps: TutorialStep[]): TutorialConfig {
  return {
    id: "tutorial.test",
    type: "tutorial",
    version: 1,
    gamemode: "gamemode.tutorial",
    instructor: "ARENA COMMAND",
    completeToast: "Done.",
    pilot: { ship: "ship.interceptor", fitting: ["module.laser-mk1"] },
    steps,
  } as TutorialConfig;
}

function step(patch: Partial<TutorialStep> & Pick<TutorialStep, "id" | "condition">): TutorialStep {
  return { stage: "flight", title: patch.id.toUpperCase(), text: "…", ...patch } as TutorialStep;
}

/** A config service that knows one module, for the family lookup. */
function configs(): Pick<ConfigService, "get"> {
  return {
    get: ((_type: string, id: string) =>
      id === "module.shield-mk1" ? ({ family: "shield" } as ModuleConfig) : undefined) as ConfigService["get"],
  };
}

interface Recorder {
  host: TutorialHost;
  views: (TutorialStepView | null)[];
  stages: string[];
  outcomes: TutorialOutcome[];
}

function recorder(): Recorder {
  const views: (TutorialStepView | null)[] = [];
  const stages: string[] = [];
  const outcomes: TutorialOutcome[] = [];
  return {
    views,
    stages,
    outcomes,
    host: {
      navigate: (stage) => stages.push(stage),
      present: (view) => views.push(view),
      finish: (outcome) => outcomes.push(outcome),
    },
  };
}

function ship(patch: Partial<ShipSnapshot> = {}): ShipSnapshot {
  return {
    id: PLAYER,
    team: 0,
    pos: { x: 0, y: 0, z: 0 },
    colliderRadius: 1,
    heading: 0,
    pitch: 0,
    up: { x: 0, y: 1, z: 0 },
    hull: 100,
    hullMax: 100,
    targetId: null,
    throttle: 0,
    velocity: { x: 0, y: 0, z: 0 },
    sensorRange: 100,
    lockProgress: 0,
    locked: false,
    modules: [],
    ...patch,
  } as ShipSnapshot;
}

function snapshot(ships: ShipSnapshot[]): Snapshot {
  return { ships, projectiles: [], asteroids: [], flags: [], teamScores: [], elapsed: 0, phase: "live" } as unknown as Snapshot;
}

/** A session stub: the director only ever asks it for an id and a spawn. */
function session(spawn: (s: ScriptedSpawn) => number | null = () => 7): GameSession {
  return { playerId: PLAYER, spawnScripted: vi.fn(spawn) } as unknown as GameSession;
}

describe("TutorialDirector — walking the steps", () => {
  it("presents the first step and navigates to its stage on begin()", () => {
    const rec = recorder();
    const director = new TutorialDirector(
      tutorial([step({ id: "throttle", condition: { kind: "throttle-above", value: 0.5 } })]),
      configs(),
      rec.host,
    );
    director.begin();
    expect(rec.stages).toEqual(["flight"]);
    expect(rec.views[0]).toMatchObject({ stepId: "throttle", index: 1, total: 1, confirmable: false });
  });

  it("advances when the snapshot satisfies the condition, and not before", () => {
    const rec = recorder();
    const director = new TutorialDirector(
      tutorial([
        step({ id: "throttle", condition: { kind: "throttle-above", value: 0.5 } }),
        step({ id: "steer", condition: { kind: "heading-changed", radians: 1 } }),
      ]),
      configs(),
      rec.host,
    );
    director.attachMatch(session());
    director.begin();

    const idle = snapshot([ship({ throttle: 0.2 })]);
    director.update(33, idle, idle);
    expect(director.currentStep?.id).toBe("throttle");

    const moving = snapshot([ship({ throttle: 0.8 })]);
    director.update(33, moving, idle);
    expect(director.currentStep?.id).toBe("steer");
    // A new step is a new accumulator: the throttle it just saw must not also
    // satisfy the next lesson.
    expect(rec.views.at(-1)).toMatchObject({ stepId: "steer", index: 2 });
  });

  it("accumulates attitude change across frames rather than reading one heading", () => {
    const rec = recorder();
    const director = new TutorialDirector(
      tutorial([step({ id: "steer", condition: { kind: "heading-changed", radians: 1 } })]),
      configs(),
      rec.host,
    );
    director.attachMatch(session());
    director.begin();
    let previous = snapshot([ship({ heading: 0 })]);
    for (const heading of [0.4, 0.8, 1.2]) {
      const next = snapshot([ship({ heading })]);
      director.update(33, next, previous);
      previous = next;
    }
    expect(rec.outcomes).toEqual(["completed"]);
  });

  it("holds the beat for holdMs after the condition fires", () => {
    const rec = recorder();
    const director = new TutorialDirector(
      tutorial([
        step({ id: "beat", condition: { kind: "dwell", seconds: 0.1 }, holdMs: 500 }),
        step({ id: "next", condition: { kind: "acknowledged" } }),
      ]),
      configs(),
      rec.host,
    );
    director.begin();
    const snap = snapshot([]);
    director.update(200, snap, snap); // condition satisfied, hold starts
    expect(director.currentStep?.id).toBe("beat");
    director.update(200, snap, snap);
    expect(director.currentStep?.id).toBe("beat");
    director.update(400, snap, snap);
    expect(director.currentStep?.id).toBe("next");
  });

  it("navigates only when the stage actually changes", () => {
    const rec = recorder();
    const director = new TutorialDirector(
      tutorial([
        step({ id: "a", condition: { kind: "acknowledged" } }),
        step({ id: "b", condition: { kind: "acknowledged" } }),
        step({ id: "c", stage: "hangar", condition: { kind: "acknowledged" } }),
      ]),
      configs(),
      rec.host,
    );
    const snap = snapshot([]);
    director.begin();
    director.acknowledge();
    director.update(16, snap, snap);
    director.acknowledge();
    director.update(16, snap, snap);
    expect(rec.stages).toEqual(["flight", "hangar"]);
  });

  it("finishes after the last step and reports completion once", () => {
    const rec = recorder();
    const director = new TutorialDirector(
      tutorial([step({ id: "only", condition: { kind: "acknowledged" } })]),
      configs(),
      rec.host,
    );
    const snap = snapshot([]);
    director.begin();
    director.acknowledge();
    director.update(16, snap, snap);
    expect(rec.outcomes).toEqual(["completed"]);
    expect(rec.views.at(-1)).toBeNull();
    // Nothing further moves: a finished run is inert.
    director.update(16, snap, snap);
    expect(rec.outcomes).toEqual(["completed"]);
  });
});

describe("TutorialDirector — spawning its targets", () => {
  const flow = () =>
    tutorial([
      step({
        id: "lock",
        condition: { kind: "lock-acquired" },
        spawn: { role: "dummy", ship: "ship.support", aheadDistance: 48, hull: 22, team: 1, callsign: "DERELICT" },
      }),
      step({ id: "kill", condition: { kind: "kill", target: "dummy" } }),
    ]);

  it("asks the session for the step's actor, translated into a scripted spawn", () => {
    const rec = recorder();
    const s = session();
    const director = new TutorialDirector(flow(), configs(), rec.host);
    director.attachMatch(s);
    director.begin();
    expect(s.spawnScripted).toHaveBeenCalledWith({
      shipId: "ship.support",
      team: 1,
      aheadDistance: 48,
      hull: 22,
      displayName: "DERELICT",
    });
  });

  it("counts a kill only for the entity it actually spawned", () => {
    const rec = recorder();
    const director = new TutorialDirector(flow(), configs(), rec.host);
    director.attachMatch(session(() => 7));
    director.begin();
    const snap = snapshot([ship()]);
    director.consumeEvents([{ type: "lockAcquired", entityId: PLAYER, targetId: 7 }]);
    director.update(16, snap, snap);
    expect(director.currentStep?.id).toBe("kill");

    // Some other rock dying is not the lesson.
    director.consumeEvents([{ type: "entityDestroyed", entityId: 99, killerId: PLAYER, isAsteroid: true }]);
    director.update(16, snap, snap);
    expect(director.currentStep?.id).toBe("kill");

    director.consumeEvents([{ type: "entityDestroyed", entityId: 7, killerId: PLAYER, isAsteroid: false }]);
    director.update(16, snap, snap);
    expect(rec.outcomes).toEqual(["completed"]);
  });

  it("does not spawn when there is no live match to spawn into", () => {
    const rec = recorder();
    const director = new TutorialDirector(flow(), configs(), rec.host);
    director.begin();
    expect(rec.views[0]).toMatchObject({ stepId: "lock" });
  });
});

describe("TutorialDirector — signals off the world", () => {
  function driver(condition: TutorialStep["condition"]): { director: TutorialDirector; rec: Recorder } {
    const rec = recorder();
    const director = new TutorialDirector(tutorial([step({ id: "s", condition })]), configs(), rec.host);
    director.attachMatch(session());
    director.begin();
    return { director, rec };
  }

  it("counts only the PLAYER's shots", () => {
    const { director, rec } = driver({ kind: "fired", shots: 2 });
    const snap = snapshot([ship()]);
    const shot = (ownerId: number): SimEvent => ({
      type: "projectileFired",
      ownerId,
      moduleId: "module.laser-mk1",
      kind: "beam",
      targetId: null,
    });
    director.consumeEvents([shot(99), shot(99)]);
    director.update(16, snap, snap);
    expect(rec.outcomes).toEqual([]);
    director.consumeEvents([shot(PLAYER), shot(PLAYER)]);
    director.update(16, snap, snap);
    expect(rec.outcomes).toEqual(["completed"]);
  });

  it("reads a module family off the config when one comes up", () => {
    const { director, rec } = driver({ kind: "module-toggled", family: "shield" });
    const snap = snapshot([ship()]);
    const toggle = (moduleId: string, to: string): SimEvent =>
      ({ type: "moduleStateChanged", entityId: PLAYER, hardpointIndex: 1, moduleId, from: "retracted", to }) as SimEvent;
    // A module going DOWN is the other half of the lesson, not the instruction.
    director.consumeEvents([toggle("module.shield-mk1", "retracting")]);
    director.update(16, snap, snap);
    expect(rec.outcomes).toEqual([]);
    director.consumeEvents([toggle("module.shield-mk1", "deploying")]);
    director.update(16, snap, snap);
    expect(rec.outcomes).toEqual(["completed"]);
  });

  it("tracks the hottest rack filling and then cooling", () => {
    const { director, rec } = driver({ kind: "heat-above-then-cooled", peak: 0.8, cooled: 0.35 });
    const rack = (heat: number): ShipSnapshot =>
      ship({ modules: [{ moduleId: "module.laser-mk1", hardpointIndex: 0, heat, heatCapacity: 100 }] as ShipSnapshot["modules"] });
    let previous = snapshot([rack(0)]);
    for (const heat of [40, 90]) {
      const next = snapshot([rack(heat)]);
      director.update(16, next, previous);
      previous = next;
    }
    expect(rec.outcomes).toEqual([]);
    const cooled = snapshot([rack(20)]);
    director.update(16, cooled, previous);
    expect(rec.outcomes).toEqual(["completed"]);
  });

  it("ticks with NO snapshots at all — the menu lessons have no sim to read", () => {
    const rec = recorder();
    const director = new TutorialDirector(
      tutorial([
        step({ id: "to-hangar", stage: "lobby", condition: { kind: "screen-visited", screen: "hangar" } }),
        step({ id: "fit", stage: "hangar", condition: { kind: "loadout-changed" } }),
      ]),
      configs(),
      rec.host,
    );
    director.begin();
    director.update(16);
    expect(director.currentStep?.id).toBe("to-hangar");
    director.noteScreen("hangar");
    director.update(16);
    expect(director.currentStep?.id).toBe("fit");
    director.noteLoadoutChanged();
    director.update(16);
    expect(rec.outcomes).toEqual(["completed"]);
  });

  it("takes screen visits, loadout changes and purchases from the host", () => {
    const visited = driver({ kind: "screen-visited", screen: "hangar" });
    const snap = snapshot([ship()]);
    visited.director.noteScreen("shop");
    visited.director.update(16, snap, snap);
    expect(visited.rec.outcomes).toEqual([]);
    visited.director.noteScreen("hangar");
    visited.director.update(16, snap, snap);
    expect(visited.rec.outcomes).toEqual(["completed"]);

    const fitted = driver({ kind: "loadout-changed" });
    fitted.director.noteLoadoutChanged();
    fitted.director.update(16, snap, snap);
    expect(fitted.rec.outcomes).toEqual(["completed"]);

    const bought = driver({ kind: "purchase-made" });
    bought.director.notePurchase();
    bought.director.update(16, snap, snap);
    expect(bought.rec.outcomes).toEqual(["completed"]);
  });
});

describe("TutorialDirector — getting out", () => {
  it("skips from any step, clears the mark and reports it", () => {
    const rec = recorder();
    const director = new TutorialDirector(
      tutorial([
        step({ id: "a", condition: { kind: "throttle-above", value: 1 } }),
        step({ id: "b", condition: { kind: "acknowledged" } }),
      ]),
      configs(),
      rec.host,
    );
    director.begin();
    director.skip();
    expect(rec.outcomes).toEqual(["skipped"]);
    expect(rec.views.at(-1)).toBeNull();
    expect(director.isFinished).toBe(true);
    // A skipped run stops observing anything.
    const snap = snapshot([ship({ throttle: 1 })]);
    director.update(16, snap, snap);
    expect(rec.outcomes).toEqual(["skipped"]);
  });

  it("jumps to the wrap-up when the student is destroyed mid-flight", () => {
    const rec = recorder();
    const director = new TutorialDirector(
      tutorial([
        step({ id: "kill-bot", condition: { kind: "kill", target: "bot" } }),
        step({ id: "victory", condition: { kind: "dwell", seconds: 3 } }),
        step({ id: "shop", stage: "shop", condition: { kind: "acknowledged" } }),
      ]),
      configs(),
      rec.host,
    );
    director.attachMatch(session());
    director.begin();
    director.consumeEvents([{ type: "entityDestroyed", entityId: PLAYER, killerId: 7, isAsteroid: false }]);
    expect(director.currentStep?.id).toBe("shop");
    expect(rec.stages).toEqual(["flight", "shop"]);
  });

  it("dispose() clears the mark without telling the host the run ended", () => {
    const rec = recorder();
    const director = new TutorialDirector(
      tutorial([step({ id: "a", condition: { kind: "acknowledged" } })]),
      configs(),
      rec.host,
    );
    director.begin();
    director.dispose();
    expect(rec.views.at(-1)).toBeNull();
    expect(rec.outcomes).toEqual([]);
  });
});

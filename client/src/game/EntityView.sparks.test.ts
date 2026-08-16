import { MeshBuilder, NullEngine, Scene, type Mesh } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ConfigService,
  EffectConfig,
  ModuleConfig,
  ProjectileSnapshot,
  ShipConfig,
  ShipSnapshot,
  SimEvent,
  Snapshot,
} from "@space-arena/shared";
import { ViewManager } from "./EntityView.js";
import { DEFAULT_JUICE_SETTINGS } from "./juice/juiceSettings.js";
import { TERRAIN_MESH_NAME } from "./juice/geometryImpact.js";

/**
 * Weapon impact sparks and impacts on arena geometry (owner 2026-08-14).
 *
 * These drive the real {@link ViewManager} against a NullEngine scene and read
 * the burst back off the pooled {@link import("./juice/SparkFx.js").SparkFx},
 * so what is pinned is the behaviour a player sees: WHICH effect fired, WHERE,
 * and — just as important — when nothing fires at all.
 */

const energySpark: EffectConfig = sparkEffect("fx.impact-energy", "#d8f7ff");
const kineticSpark: EffectConfig = sparkEffect("fx.impact-kinetic", "#ffd489");
const missileImpact: EffectConfig = {
  ...sparkEffect("fx.missile-impact", "#ffe3a8"),
  sound: "[SOUND: explosion_light]",
};

function sparkEffect(id: string, color1: string): EffectConfig {
  return {
    id,
    type: "effect",
    version: 1,
    name: id,
    base: {
      capacity: 24,
      emitRate: 0,
      lifeMin: 0.06,
      lifeMax: 0.3,
      sizeMin: 0.05,
      sizeMax: 0.3,
      speedMin: 5,
      speedMax: 14,
      color1,
      color2: "#ff5a0d",
      direction: [0.4, 0.4, 0.4],
    },
    params: [],
  };
}

/** A 2-unit hull, so an impact point lands on a surface and not on a fallback. */
const HULL_RADIUS = 2;
const hull = {
  id: "ship.spark-test",
  render: { recipe: "procedural.arrowhead" },
  collider: { shape: "circle", radius: HULL_RADIUS },
  sockets: [],
} as unknown as ShipConfig;

const laser = {
  id: "module.laser-test",
  fire: { mode: "held", range: 95, damageType: "energy" },
} as unknown as ModuleConfig;

const beamLaser = {
  id: "module.beam-test",
  fire: { mode: "continuous", range: 70, damageType: "energy" },
} as unknown as ModuleConfig;

const engines: NullEngine[] = [];

afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
});

function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    tick: 1,
    elapsed: 0,
    phase: "live",
    countdownRemaining: 0,
    teamScores: [],
    winnerTeam: null,
    ships: [],
    asteroids: [],
    projectiles: [],
    decoys: [],
    flags: [],
    ...over,
  };
}

function ship(id: number, x: number, y: number, z: number, over: Partial<ShipSnapshot> = {}): ShipSnapshot {
  return {
    id,
    team: 1,
    pos: { x, y, z },
    heading: 0,
    pitch: 0,
    up: { x: 0, y: 1, z: 0 },
    hull: 60,
    hullMax: 100,
    targetId: null,
    throttle: 0,
    lockProgress: 0,
    locked: false,
    modules: [],
    ...over,
  };
}

function bolt(id: number, x: number, y: number, z: number): ProjectileSnapshot {
  return { id, kind: "kinetic", pos: { x, y, z }, heading: 0 };
}

function warhead(id: number, x: number, y: number, z: number): ProjectileSnapshot {
  return { id, kind: "missile", pos: { x, y, z }, heading: 0 };
}

function damage(targetId: number, damageType: "kinetic" | "energy" | "hybrid"): SimEvent {
  return { type: "damage", targetId, sourceId: 1, amount: 12, damageType, isAsteroid: false };
}

function makeView(): {
  view: ViewManager;
  scene: Scene;
  burst: ReturnType<typeof vi.fn>;
} {
  const engine = new NullEngine();
  engines.push(engine);
  const scene = new Scene(engine);
  const configs = {
    get: (type: string, id: string) => {
      if (type === "effect") {
        for (const effect of [energySpark, kineticSpark, missileImpact]) {
          if (effect.id === id) return effect;
        }
        return undefined;
      }
      if (type === "ship" && id === hull.id) return hull;
      if (type === "module" && id === laser.id) return laser;
      if (type === "module" && id === beamLaser.id) return beamLaser;
      return undefined;
    },
    getAll: (type: string) => (type === "tuning" ? [{ projectilePoolSize: 4, beamFadeMs: 120 }] : []),
  } as unknown as ConfigService;
  const view = new ViewManager(
    scene,
    configs,
    () => hull.id,
    {
      projectiles: { useInstances: true },
      // Particles ON: a spark IS its particle burst, so the ring must be live.
      particles: { enabled: true, budgetMultiplier: 1, maxEmitterCapacity: 40 },
      asteroids: { lodMediumDistance: 0, lodLowDistance: 0, lodCullDistance: 0 },
    },
    { juice: DEFAULT_JUICE_SETTINGS, playSound: vi.fn() },
  );
  // Watch the pool rather than the particle system: this is the seam where
  // "which effect, at which point" is decided.
  const burst = vi.fn(() => true);
  vi.spyOn(view.sparkFx, "burst").mockImplementation(burst as never);
  return { view, scene, burst };
}

/** A stand-in for SceneBuilder's regolith disc — a wide slab at height `y`. */
function terrain(scene: Scene, y: number): Mesh {
  const mesh = MeshBuilder.CreateBox(TERRAIN_MESH_NAME, { width: 400, height: 1, depth: 400 }, scene);
  mesh.position.y = y;
  mesh.isPickable = false;
  return mesh;
}

/** A stand-in for an authored prop instance, with the metadata SceneBuilder stamps. */
function prop(scene: Scene, x: number, y = 0, z = 0): Mesh {
  const mesh = MeshBuilder.CreateBox("prop.boulder", { size: 4 }, scene);
  mesh.position.set(x, y, z);
  mesh.isPickable = false;
  mesh.metadata = { editorKind: "prop", editorIndex: 0 };
  return mesh;
}

/** Fly a shot two snapshots along +X, then take it out of the snapshot. */
function fire(
  view: ViewManager,
  shot: (id: number, x: number, y: number, z: number) => ProjectileSnapshot,
  ships: ShipSnapshot[] = [],
): { closer: Snapshot; gone: Snapshot } {
  const far = snapshot({ ships, projectiles: [shot(9, 16, 0, 0)] });
  const closer = snapshot({ ships, projectiles: [shot(9, 18, 0, 0)] });
  view.render(far, closer, 1, 16);
  return { closer, gone: snapshot({ ships }) };
}

describe("gun round impacts", () => {
  it("sparks on the hull surface, in the colour of the damage the sim reported", () => {
    const { view, burst } = makeView();
    const target = ship(3, 21, 0, 0);
    const { closer, gone } = fire(view, bolt, [target]);

    view.consumeEvents([damage(3, "kinetic")], gone);
    view.render(closer, gone, 1, 16);

    expect(burst).toHaveBeenCalledTimes(1);
    const [effect, x, y, z, ax] = burst.mock.calls[0] as unknown as [EffectConfig, number, number, number, number];
    expect(effect.id).toBe("fx.impact-kinetic");
    // Pulled back onto the hull facing the incoming round: centre 21, radius 2.
    expect(x).toBeCloseTo(21 - HULL_RADIUS, 5);
    expect(y).toBeCloseTo(0, 5);
    expect(z).toBeCloseTo(0, 5);
    // Sprayed back the way the round came (it was travelling +X).
    expect(ax).toBeCloseTo(-1, 5);

    view.dispose();
  });

  it("throws the ENERGY spray when the same landing round reports energy damage", () => {
    const { view, burst } = makeView();
    const target = ship(3, 21, 0, 0);
    const { closer, gone } = fire(view, bolt, [target]);

    view.consumeEvents([damage(3, "energy")], gone);
    view.render(closer, gone, 1, 16);

    expect((burst.mock.calls[0] as unknown as [EffectConfig])[0].id).toBe("fx.impact-energy");
    view.dispose();
  });

  it("falls back to the kinetic spray for a composite damage type", () => {
    const { view, burst } = makeView();
    const target = ship(3, 21, 0, 0);
    const { closer, gone } = fire(view, bolt, [target]);

    view.consumeEvents([damage(3, "hybrid")], gone);
    view.render(closer, gone, 1, 16);

    expect((burst.mock.calls[0] as unknown as [EffectConfig])[0].id).toBe("fx.impact-kinetic");
    view.dispose();
  });

  it("draws NOTHING for a round that expired at the arena limit", () => {
    const { view, burst } = makeView();
    // Empty arena: no hit reported, and nothing solid anywhere on its line.
    const { closer, gone } = fire(view, bolt);

    view.render(closer, gone, 1, 16);

    expect(burst).not.toHaveBeenCalled();
    expect(view.explosionFx.activeCount).toBe(0);
    view.dispose();
  });

  it("still draws nothing when the boundary shell itself is in the scene", () => {
    const { view, scene, burst } = makeView();
    // The bounds shell is real geometry to Babylon and sits right where ordnance
    // expires. It must never be a spark surface.
    const shell = MeshBuilder.CreateSphere("boundsShell", { diameter: 40 }, scene);
    shell.isPickable = false;
    const { closer, gone } = fire(view, bolt);

    view.render(closer, gone, 1, 16);

    expect(burst).not.toHaveBeenCalled();
    view.dispose();
  });

  it("sparks on a prop the round flew into, at the face it touched", () => {
    const { view, scene, burst } = makeView();
    prop(scene, 21); // 4-unit box: near face at x = 19
    const { closer, gone } = fire(view, bolt);

    view.render(closer, gone, 1, 16);

    expect(burst).toHaveBeenCalledTimes(1);
    const [effect, x] = burst.mock.calls[0] as unknown as [EffectConfig, number];
    expect(effect.id).toBe("fx.impact-kinetic");
    expect(x).toBeCloseTo(19, 3);
    view.dispose();
  });

  it("prefers the sim's own damage report over the scenery behind the target", () => {
    const { view, scene, burst } = makeView();
    prop(scene, 21);
    const target = ship(3, 21, 0, 0);
    const { closer, gone } = fire(view, bolt, [target]);

    view.consumeEvents([damage(3, "energy")], gone);
    view.render(closer, gone, 1, 16);

    const [effect, x] = burst.mock.calls[0] as unknown as [EffectConfig, number];
    expect(effect.id).toBe("fx.impact-energy"); // the hull, not the rock
    expect(x).toBeCloseTo(19, 5);
    view.dispose();
  });
});

describe("ground impacts", () => {
  /**
   * A tilted slab, standing in for the real regolith relief: its bounding-box
   * CEILING is far above the surface directly under the shot, which is exactly
   * the case the look-ahead exists for (find the crossing early, draw it late).
   * Surface directly below x = 0 sits at 0.5 / cos(0.12) ≈ 0.5036.
   */
  const SLOPE_SURFACE_Y = 0.5 / Math.cos(0.12);
  function slope(scene: Scene): Mesh {
    const mesh = terrain(scene, 0);
    mesh.rotation.z = 0.12;
    return mesh;
  }

  /** One frame of a round descending straight down through `from` → `to`. */
  function descend(view: ViewManager, from: number, to: number): void {
    view.render(
      snapshot({ projectiles: [bolt(9, 0, from, 0)] }),
      snapshot({ projectiles: [bolt(9, 0, to, 0)] }),
      1,
      16,
    );
  }

  it("finds the floor ahead of the round but draws only when it gets there", () => {
    const { view, scene, burst } = makeView();
    slope(scene);

    // Well above the terrain's ceiling: nothing is even looked for.
    descend(view, 40, 34);
    expect(burst).not.toHaveBeenCalled();

    // Under the ceiling now — the look-ahead finds the surface 15 units below,
    // and deliberately does NOT draw a spark the round has not reached.
    descend(view, 20, 16);
    expect(burst).not.toHaveBeenCalled();

    descend(view, 16, 8);
    expect(burst).not.toHaveBeenCalled();

    // Arrival.
    descend(view, 8, 0);
    expect(burst).toHaveBeenCalledTimes(1);
    const [effect, x, y, z, , ay] = burst.mock.calls[0] as unknown as [
      EffectConfig,
      number,
      number,
      number,
      number,
      number,
    ];
    expect(effect.id).toBe("fx.impact-kinetic");
    expect(x).toBeCloseTo(0, 3);
    expect(y).toBeCloseTo(SLOPE_SURFACE_Y, 2);
    expect(z).toBeCloseTo(0, 3);
    expect(ay).toBeCloseTo(1, 5); // sprayed back up, against the dive

    // Exactly once: the despawn that follows must not spark the same round again.
    view.render(snapshot({ projectiles: [bolt(9, 0, 0, 0)] }), snapshot(), 1, 16);
    expect(burst).toHaveBeenCalledTimes(1);
    view.dispose();
  });

  it("draws a round that punched through the surface inside one snapshot at once", () => {
    const { view, scene, burst } = makeView();
    terrain(scene, 0); // flat slab, top at y = 0.5

    // 20 units in a single snapshot: the crossing is already behind the shot on
    // the very frame it is found.
    descend(view, 12, -8);

    expect(burst).toHaveBeenCalledTimes(1);
    const [, , y] = burst.mock.calls[0] as unknown as [EffectConfig, number, number];
    expect(y).toBeCloseTo(0.5, 3);
    view.dispose();
  });

  it("draws nothing for a round that dies before reaching the ground", () => {
    const { view, scene, burst } = makeView();
    slope(scene);

    descend(view, 24, 20);
    // Lifetime ran out mid-air, still well above the surface.
    view.render(snapshot({ projectiles: [bolt(9, 0, 20, 0)] }), snapshot(), 1, 16);

    expect(burst).not.toHaveBeenCalled();
    view.dispose();
  });

  it("detonates a warhead that reaches the ground instead of sparking it", () => {
    const { view, scene, burst } = makeView();
    terrain(scene, 0);

    view.render(
      snapshot({ projectiles: [warhead(9, 0, 16, 0)] }),
      snapshot({ projectiles: [warhead(9, 0, 8, 0)] }),
      1,
      16,
    );
    view.render(
      snapshot({ projectiles: [warhead(9, 0, 8, 0)] }),
      snapshot({ projectiles: [warhead(9, 0, 0, 0)] }),
      1,
      16,
    );

    expect(view.explosionFx.activeCount).toBe(1);
    expect(burst).not.toHaveBeenCalled();
    view.dispose();
  });
});

describe("beam impacts", () => {
  it("sparks where a fired beam lands, in its module's damage colour", () => {
    const { view, burst } = makeView();
    const shooter = ship(1, 0, 0, 0);
    const target = ship(3, 10, 0, 0);
    const cur = snapshot({ ships: [shooter, target] });

    view.consumeEvents(
      [{ type: "projectileFired", ownerId: 1, moduleId: laser.id, kind: "beam", targetId: 3 }],
      cur,
    );

    expect(burst).toHaveBeenCalledTimes(1);
    const [effect, x, , , ax] = burst.mock.calls[0] as unknown as [EffectConfig, number, number, number, number];
    expect(effect.id).toBe("fx.impact-energy");
    expect(x).toBeCloseTo(10 - HULL_RADIUS, 5); // on the skin, facing the shooter
    expect(ax).toBeCloseTo(-1, 5); // sprayed back down the beam
    view.dispose();
  });

  it("does not spark a beam that hit nothing", () => {
    const { view, burst } = makeView();
    const cur = snapshot({ ships: [ship(1, 0, 0, 0)] });

    view.consumeEvents(
      [{ type: "projectileFired", ownerId: 1, moduleId: laser.id, kind: "beam", targetId: null }],
      cur,
    );

    expect(burst).not.toHaveBeenCalled();
    view.dispose();
  });

  it("sizzles a channelling beam on its own cadence, not once per frame", () => {
    const { view, burst } = makeView();
    const channel = { hardpointIndex: 0, moduleId: beamLaser.id, state: "ready", channeling: true };
    const shooter = ship(1, 0, 0, 0, {
      targetId: 3,
      modules: [channel as unknown as ShipSnapshot["modules"][number]],
    });
    const cur = snapshot({ ships: [shooter, ship(3, 10, 0, 0)] });

    // Ten frames at 16 ms is 160 ms of burn: the shipped 120 ms cadence gives
    // two beats, where one per frame would have given ten.
    for (let frame = 0; frame < 10; frame++) view.render(cur, cur, 1, 16);

    expect(burst).toHaveBeenCalledTimes(2);
    expect((burst.mock.calls[0] as unknown as [EffectConfig])[0].id).toBe("fx.impact-energy");
    view.dispose();
  });

  it("stops sparking the moment the channel is released", () => {
    const { view, burst } = makeView();
    const shooter = (channeling: boolean): ShipSnapshot =>
      ship(1, 0, 0, 0, {
        targetId: 3,
        modules: [
          { hardpointIndex: 0, moduleId: beamLaser.id, state: "ready", channeling } as unknown as ShipSnapshot["modules"][number],
        ],
      });
    const target = ship(3, 10, 0, 0);
    const on = snapshot({ ships: [shooter(true), target] });
    const off = snapshot({ ships: [shooter(false), target] });

    view.render(on, on, 1, 16);
    expect(burst).toHaveBeenCalledTimes(1);
    for (let frame = 0; frame < 20; frame++) view.render(off, off, 1, 16);
    expect(burst).toHaveBeenCalledTimes(1);
    view.dispose();
  });
});

describe("spark pool discipline", () => {
  it("never grows: sustained fire recycles the same fixed ring", () => {
    const { view } = makeView();
    vi.restoreAllMocks(); // let the real pool take the bursts this time
    const effect = kineticSpark;
    for (let i = 0; i < 50; i++) view.sparkFx.burst(effect, i, 0, 0, 1, 0, 0);
    expect(view.sparkFx.activeCount).toBeLessThanOrEqual(view.sparkFx.poolSize);
    view.dispose();
  });
});

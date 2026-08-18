import { NullEngine, Scene, Vector3, type InstancedMesh } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ConfigService,
  EffectConfig,
  ProjectileSnapshot,
  ShipConfig,
  ShipSnapshot,
  SimEvent,
  Snapshot,
} from "@space-arena/shared";
import { ViewManager } from "./EntityView.js";
import { DEFAULT_JUICE_SETTINGS, MISSILE_IMPACT_SCALE } from "./juice/juiceSettings.js";

const impact: EffectConfig = {
  id: "fx.missile-impact",
  type: "effect",
  version: 1,
  name: "missile impact",
  base: {
    capacity: 20,
    emitRate: 0,
    lifeMin: 0.1,
    lifeMax: 0.3,
    sizeMin: 0.2,
    sizeMax: 0.6,
    speedMin: 5,
    speedMax: 12,
    color1: "#ffe3a8",
    color2: "#ff5a1e",
  },
  params: [],
  sound: "[SOUND: explosion_light]",
};

/** A 2-unit hull, so the impact point lands on a surface and not on a fallback. */
const HULL_RADIUS = 2;
const hull = {
  id: "ship.missile-test",
  render: { recipe: "procedural.arrowhead" },
  collider: { shape: "circle", radius: HULL_RADIUS },
  sockets: [],
} as unknown as ShipConfig;

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

function ship(id: number, x: number, y: number, z: number): ShipSnapshot {
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
  };
}

function missile(id: number, x: number, y: number, z: number): ProjectileSnapshot {
  return { id, kind: "missile", pos: { x, y, z }, heading: 0 };
}

function damage(targetId: number): SimEvent {
  return { type: "damage", targetId, sourceId: 1, amount: 12, damageType: "kinetic", isAsteroid: false };
}

function makeView(): { view: ViewManager; scene: Scene; playSound: ReturnType<typeof vi.fn> } {
  const engine = new NullEngine();
  engines.push(engine);
  const scene = new Scene(engine);
  const configs = {
    get: (type: string, id: string) => {
      if (type === "effect" && id === impact.id) return impact;
      if (type === "ship" && id === hull.id) return hull;
      return undefined;
    },
    getAll: (type: string) => (type === "tuning" ? [{ projectilePoolSize: 4, beamFadeMs: 120 }] : []),
  } as unknown as ConfigService;
  const playSound = vi.fn();
  const view = new ViewManager(
    scene,
    configs,
    () => hull.id,
    {
      projectiles: { useInstances: true },
      particles: { enabled: false, budgetMultiplier: 0, maxEmitterCapacity: 0 },
      asteroids: { lodMediumDistance: 0, lodLowDistance: 0, lodCullDistance: 0 },
    },
    { juice: DEFAULT_JUICE_SETTINGS, playSound },
  );
  return { view, scene, playSound };
}

describe("missile projectile view", () => {
  it("instances the modelled missile master and flies it nose-first along its travel", () => {
    const { view, scene } = makeView();
    // Climbing to the right: 3 across, 4 up — a direction no scalar heading carries.
    view.render(
      snapshot({ projectiles: [missile(9, 0, 0, 0)] }),
      snapshot({ projectiles: [missile(9, 3, 4, 0)] }),
      1,
      16,
    );

    const node = scene.getMeshByName("proj.missile.0") as InstancedMesh;
    expect(node.sourceMesh.name).toBe("master.proj.missile");
    expect(node.isEnabled()).toBe(true);
    node.computeWorldMatrix(true);
    // The model's nose is +Z; posed, it must land on the unit travel direction.
    const nose = Vector3.TransformNormal(Vector3.Forward(), node.getWorldMatrix()).normalize();
    expect(nose.x).toBeCloseTo(0.6, 5);
    expect(nose.y).toBeCloseTo(0.8, 5);
    expect(nose.z).toBeCloseTo(0, 5);

    view.dispose();
  });

  it("hides pooled missiles again once the snapshot stops carrying them", () => {
    const { view, scene } = makeView();
    view.render(
      snapshot({ projectiles: [missile(9, 0, 0, 0)] }),
      snapshot({ projectiles: [missile(9, 1, 0, 0)] }),
      1,
      16,
    );
    expect(scene.getMeshByName("proj.missile.0")!.isEnabled()).toBe(true);

    view.render(snapshot(), snapshot(), 1, 16);
    expect(scene.getMeshByName("proj.missile.0")!.isEnabled()).toBe(false);

    view.dispose();
  });
});

describe("missile impact explosion", () => {
  /** Fly a missile at `target` and then take it out of the snapshot. */
  function approach(view: ViewManager, target: ShipSnapshot): { closer: Snapshot; gone: Snapshot } {
    const far = snapshot({ ships: [target], projectiles: [missile(9, 16, 0, 0)] });
    const closer = snapshot({ ships: [target], projectiles: [missile(9, 18, 0, 0)] });
    view.render(far, closer, 1, 16);
    return { closer, gone: snapshot({ ships: [target] }) };
  }

  it("spawns exactly one burst on the hull surface when the sim reports the hit", () => {
    const { view, scene, playSound } = makeView();
    const target = ship(3, 21, 0, 0);
    const { closer, gone } = approach(view, target);
    expect(view.explosionFx.activeCount).toBe(0);

    view.consumeEvents([damage(3)], gone);
    view.render(closer, gone, 1, 16);

    expect(view.explosionFx.activeCount).toBe(1);
    const slot = scene.getTransformNodeByName("fx.explosion.slot.0")!;
    // Pulled back onto the hull surface facing the missile: hull centre at x=21
    // with a 2-unit collider, missile last seen at x=18.
    expect(slot.position.x).toBeCloseTo(21 - HULL_RADIUS, 5);
    expect(slot.position.y).toBeCloseTo(0, 5);
    expect(slot.position.z).toBeCloseTo(0, 5);
    // Visibly smaller than the hull-death burst the same pool draws.
    expect(slot.scaling.x).toBeCloseTo(MISSILE_IMPACT_SCALE, 5);
    expect(playSound).toHaveBeenCalledTimes(1);
    expect(playSound).toHaveBeenCalledWith("explosion_light");

    // The track is retired with the burst: further frames must not re-detonate it.
    view.render(gone, gone, 1, 16);
    expect(view.explosionFx.activeCount).toBe(1);
    expect(playSound).toHaveBeenCalledTimes(1);

    view.dispose();
  });

  it("releases the burst back to the pool once its lifetime runs out", () => {
    const { view } = makeView();
    const target = ship(3, 21, 0, 0);
    const { closer, gone } = approach(view, target);
    view.consumeEvents([damage(3)], gone);
    view.render(closer, gone, 1, 16);
    expect(view.explosionFx.activeCount).toBe(1);

    view.render(gone, gone, 1, 9_000); // past the slot's full life + fade
    expect(view.explosionFx.activeCount).toBe(0);

    view.dispose();
  });

  it("draws nothing for a missile that simply ran out of fuel", () => {
    const { view, playSound } = makeView();
    const target = ship(3, 21, 0, 0);
    const { closer, gone } = approach(view, target);

    view.render(closer, gone, 1, 16); // no damage event: the sim reported no hit

    expect(view.explosionFx.activeCount).toBe(0);
    expect(playSound).not.toHaveBeenCalled();

    view.dispose();
  });

  it("does not pair a vanished missile with a hit it could never have reached", () => {
    const { view } = makeView();
    // Hit reported on a hull far from where this missile was last seen.
    const target = ship(3, 200, 0, 0);
    const { closer, gone } = approach(view, target);

    view.consumeEvents([damage(3)], gone);
    view.render(closer, gone, 1, 16);

    expect(view.explosionFx.activeCount).toBe(0);

    view.dispose();
  });

  it("forgets a reported hit once its matching window has passed", () => {
    const { view } = makeView();
    const target = ship(3, 21, 0, 0);
    const far = snapshot({ ships: [target], projectiles: [missile(9, 16, 0, 0)] });
    const closer = snapshot({ ships: [target], projectiles: [missile(9, 18, 0, 0)] });
    const gone = snapshot({ ships: [target] });

    view.consumeEvents([damage(3)], far);
    view.render(far, closer, 1, 500); // long frame ages the window out
    view.render(closer, gone, 1, 16);

    expect(view.explosionFx.activeCount).toBe(0);

    view.dispose();
  });

  it("detonates a missile a shield stopped, not just one that reached hull", () => {
    const { view } = makeView();
    const target = ship(3, 21, 0, 0);
    const { closer, gone } = approach(view, target);

    view.consumeEvents(
      [{ type: "shieldAbsorb", targetId: 3, sourceId: 1, hardpointIndex: 0, amount: 9, hullAvoided: 8.1, damageType: "kinetic" }],
      gone,
    );
    view.render(closer, gone, 1, 16);

    expect(view.explosionFx.activeCount).toBe(1);

    view.dispose();
  });

  it("drops live tracks on teardown instead of detonating them", () => {
    const { view, playSound } = makeView();
    const target = ship(3, 21, 0, 0);
    approach(view, target);

    view.consumeEvents([damage(3)], snapshot({ ships: [target] }));
    view.dispose();

    expect(playSound).not.toHaveBeenCalled();
  });
});

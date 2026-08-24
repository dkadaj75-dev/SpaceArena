import { NullEngine, Scene } from "@babylonjs/core";
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
import { DEFAULT_JUICE_SETTINGS } from "./juice/juiceSettings.js";

/**
 * PER-DAMAGE-TYPE IMPACT FEEDBACK (owner rework 2026-08-23) — the routing from
 * a sim `damage` / `shieldAbsorb` event to what the player actually sees, driven
 * through the real {@link ViewManager} on a NullEngine scene.
 *
 * The red bubble that used to pop around any damaged hull is gone; these pin
 * what replaced it, and — just as important — pin that the sim's own impact
 * point does not get drawn TWICE now that the despawn matcher and the event
 * both know where the shot landed.
 */

const effects: EffectConfig[] = [
  fx("fx.impact-kinetic", "#ffd489"),
  fx("fx.impact-energy", "#d8f7ff"),
  { ...fx("fx.missile-impact", "#ffe3a8"), sound: "[SOUND: explosion_light]" },
];

function fx(id: string, color1: string): EffectConfig {
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

const HULL_RADIUS = 2;
const hull = {
  id: "ship.impact-test",
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

function shot(kind: "kinetic" | "missile", id: number, x: number): ProjectileSnapshot {
  return { id, kind, pos: { x, y: 0, z: 0 }, heading: 0 };
}

/** A `damage` event as the 2026-08-23 sim emits it: weapon and impact point. */
function damage(over: Partial<Extract<SimEvent, { type: "damage" }>> = {}): SimEvent {
  return {
    type: "damage",
    targetId: 3,
    sourceId: 1,
    amount: 12,
    damageType: "kinetic",
    isAsteroid: false,
    weapon: "kinetic",
    pos: { x: 19, y: 0, z: 0 },
    ...over,
  };
}

function makeView(): {
  view: ViewManager;
  scene: Scene;
  burst: ReturnType<typeof vi.fn>;
  playSound: ReturnType<typeof vi.fn>;
} {
  const engine = new NullEngine();
  engines.push(engine);
  const scene = new Scene(engine);
  const configs = {
    get: (type: string, id: string) => {
      if (type === "effect") return effects.find((e) => e.id === id);
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
      // Particles ON: a spark IS its particle burst, so the ring must be live.
      particles: { enabled: true, budgetMultiplier: 1, maxEmitterCapacity: 40 },
      asteroids: { lodMediumDistance: 0, lodLowDistance: 0, lodCullDistance: 0 },
    },
    { juice: DEFAULT_JUICE_SETTINGS, playSound },
  );
  const burst = vi.fn(() => true);
  vi.spyOn(view.sparkFx, "burst").mockImplementation(burst as never);
  return { view, scene, burst, playSound };
}

/**
 * Fly one round two snapshots along +X toward a hull at x=21, then take it out
 * of the snapshot — the "it landed, or it expired" moment the view has to read.
 */
function fire(view: ViewManager, kind: "kinetic" | "missile"): { closer: Snapshot; gone: Snapshot } {
  const ships = [ship(3, 21, 0, 0), ship(1, 0, 0, 0)];
  const far = snapshot({ ships, projectiles: [shot(kind, 9, 16)] });
  const closer = snapshot({ ships, projectiles: [shot(kind, 9, 18)] });
  view.render(far, closer, 1, 16);
  return { closer, gone: snapshot({ ships }) };
}

describe("kinetic impact feedback", () => {
  it("sparks at the point the SIM reported, not at a point the view guessed", () => {
    const { view, burst } = makeView();
    const { closer, gone } = fire(view, "kinetic");

    view.consumeEvents([damage({ pos: { x: 19.5, y: 1.25, z: -0.5 } })], gone);
    view.render(closer, gone, 1, 16);

    expect(burst).toHaveBeenCalledTimes(1);
    const [effect, x, y, z, ax] = burst.mock.calls[0] as unknown as [EffectConfig, number, number, number, number];
    expect(effect.id).toBe("fx.impact-kinetic");
    expect(x).toBeCloseTo(19.5, 5);
    expect(y).toBeCloseTo(1.25, 5);
    expect(z).toBeCloseTo(-0.5, 5);
    // Sprayed back out of the hull toward the shooter, who is at the origin.
    expect(ax).toBeLessThan(0);

    view.dispose();
  });

  it("draws the strike ONCE — the despawning round does not spark it again", () => {
    const { view, burst } = makeView();
    const { closer, gone } = fire(view, "kinetic");

    view.consumeEvents([damage()], gone);
    view.render(closer, gone, 1, 16);
    // Several more frames: the track is retired, and the claimed hit window
    // must not attract anything else either.
    view.render(gone, gone, 1, 16);
    view.render(gone, gone, 1, 16);

    expect(burst).toHaveBeenCalledTimes(1);
    view.dispose();
  });

  it("still falls back to the despawn matcher for an event carrying no point", () => {
    // A pre-2026-08-23 peer, or a hull scraping a rock. The old path is intact.
    const { view, burst } = makeView();
    const { closer, gone } = fire(view, "kinetic");

    view.consumeEvents([damage({ weapon: undefined, pos: undefined })], gone);
    view.render(closer, gone, 1, 16);

    expect(burst).toHaveBeenCalledTimes(1);
    const [, x] = burst.mock.calls[0] as unknown as [EffectConfig, number];
    // Pulled onto the hull surface by the matcher: centre 21, radius 2.
    expect(x).toBeCloseTo(21 - HULL_RADIUS, 5);

    view.dispose();
  });
});

describe("missile impact feedback", () => {
  it("detonates the warhead at the sim's impact point instead of sparking", () => {
    const { view, scene, burst, playSound } = makeView();
    const { closer, gone } = fire(view, "missile");

    view.consumeEvents(
      [damage({ damageType: "hybrid", weapon: "missile", pos: { x: 19, y: 0.5, z: 0 } })],
      gone,
    );
    view.render(closer, gone, 1, 16);

    expect(view.explosionFx.activeCount).toBe(1);
    expect(burst).not.toHaveBeenCalled();
    const slot = scene.getTransformNodeByName("fx.explosion.slot.0")!;
    expect(slot.position.x).toBeCloseTo(19, 5);
    expect(slot.position.y).toBeCloseTo(0.5, 5);
    expect(playSound).toHaveBeenCalledWith("explosion_light");

    view.dispose();
  });

  it("goes off ONCE — the vanished missile is not detonated a second time", () => {
    const { view, playSound } = makeView();
    const { closer, gone } = fire(view, "missile");

    view.consumeEvents([damage({ damageType: "hybrid", weapon: "missile" })], gone);
    view.render(closer, gone, 1, 16);
    view.render(gone, gone, 1, 16);

    expect(view.explosionFx.activeCount).toBe(1);
    expect(playSound).toHaveBeenCalledTimes(1);
    view.dispose();
  });

  it("detonates on a shield that stopped it, from the absorb alone", () => {
    const { view } = makeView();
    const { closer, gone } = fire(view, "missile");

    view.consumeEvents(
      [
        {
          type: "shieldAbsorb",
          targetId: 3,
          sourceId: 1,
          hardpointIndex: 0,
          amount: 9,
          hullAvoided: 8.1,
          damageType: "hybrid",
          weapon: "missile",
          pos: { x: 19, y: 0, z: 0 },
        },
      ],
      gone,
    );
    view.render(closer, gone, 1, 16);

    expect(view.explosionFx.activeCount).toBe(1);
    view.dispose();
  });
});

describe("energy impact feedback", () => {
  it("electrifies the struck HULL and throws no spray of its own", () => {
    const { view, burst } = makeView();
    const ships = [ship(3, 21, 0, 0), ship(1, 0, 0, 0)];
    const live = snapshot({ ships });
    view.render(live, live, 1, 16);

    view.consumeEvents([damage({ damageType: "energy", weapon: "beam", pos: undefined })], live);
    view.render(live, live, 1, 16);

    expect(view.juiceDebug.chargedHulls).toBe(1);
    // The beam that did it already sparks where it visibly touches the hull;
    // the charge is the hull's own reaction, not a second impact.
    expect(burst).not.toHaveBeenCalled();

    view.dispose();
  });

  it("runs the charge out on its own clock", () => {
    const { view } = makeView();
    const ships = [ship(3, 21, 0, 0), ship(1, 0, 0, 0)];
    const live = snapshot({ ships });
    view.render(live, live, 1, 16);

    view.consumeEvents([damage({ damageType: "energy", weapon: "beam", pos: undefined })], live);
    view.render(live, live, 1, 16);
    expect(view.juiceDebug.chargedHulls).toBe(1);

    view.render(live, live, 1, DEFAULT_JUICE_SETTINGS.energyCharge.durationMs);
    expect(view.juiceDebug.chargedHulls).toBe(0);

    view.dispose();
  });

  it("leaves an energy hit's round free for the despawn matcher", () => {
    // An energy event never claims the hit window: it drew no positioned
    // impact, so whatever the view saw vanish is still the matcher's business.
    const { view, burst } = makeView();
    const { closer, gone } = fire(view, "kinetic");

    view.consumeEvents([damage({ damageType: "energy", weapon: "beam", pos: undefined })], gone);
    view.render(closer, gone, 1, 16);

    expect(burst).toHaveBeenCalledTimes(1);
    expect((burst.mock.calls[0] as unknown as [EffectConfig])[0].id).toBe("fx.impact-energy");
    view.dispose();
  });
});

// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import type { ConfigService, Snapshot } from "@space-arena/shared";
import { Gauges } from "./Gauges.js";
import { resolveHudLayout } from "./hudLayout.js";
import { VitalArcs } from "./VitalArcs.js";

const snapshot: Snapshot = {
  tick: 0,
  elapsed: 0,
  phase: "live",
  countdownRemaining: 0,
  winnerTeam: null,
  projectiles: [],
  asteroids: [],
  ships: [{
    id: 1,
    team: 0,
    pos: { x: 0, y: 0, z: 0 },
    heading: 0,
    pitch: 0,
    hull: 75,
    hullMax: 100,
    energy: { cur: 60, max: 100 },
    heat: { cur: 10, capacity: 100 },
    targetId: null,
    throttle: 0,
    lockProgress: 0,
    locked: false,
    modules: [{
      hardpointIndex: 0,
      moduleId: "module.shield",
      state: "retracted",
      heat: 0,
      stateTimer: 0,
      cycleTimer: 0,
      channeling: false,
      shieldPool: 20,
    }],
  }],
};

const configs = {
  get: (type: string, id: string) =>
    type === "module" && id === "module.shield"
      ? { mitigation: { absorbPerSecond: 40 } }
      : undefined,
} as unknown as ConfigService;

describe("centre vital arcs", () => {
  it("moves hull/shield out of the lower-left panel and follows live pools", () => {
    const root = document.createElement("div");
    const layout = resolveHudLayout(
      {
        hud: {
          gauges: { showHull: false, showShield: false },
          vitalArcs: { enabled: true, radiusPx: 140, strokePx: 5, arcDeg: 120 },
        },
      } as never,
      { width: 400, height: 800 },
    );
    const gauges = new Gauges(root, configs, {} as never, 1);
    const arcs = new VitalArcs(root, configs, 1);
    gauges.applyLayout(layout);
    arcs.applyLayout(layout);
    gauges.update(snapshot);
    arcs.update(snapshot);

    expect(root.querySelector<HTMLElement>('[data-gauge="hull"]')!.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>('[data-gauge="shield"]')!.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>('[data-gauge="energy"]')!.hidden).toBe(false);
    expect(root.querySelector<HTMLElement>('[data-gauge="heat"]')!.hidden).toBe(false);
    expect(root.querySelector<HTMLElement>(".hud-vital-label.hull .value")!.textContent).toBe("75%");
    expect(root.querySelector<HTMLElement>(".hud-vital-label.shield .value")!.textContent).toBe("50%");
    expect(root.querySelector<SVGPathElement>(".hud-vital-arc.fill.hull")!.style.strokeDasharray).toBe("75 100");

    arcs.dispose();
    gauges.dispose();
  });
});

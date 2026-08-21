// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import type { ConfigService, Snapshot } from "@space-arena/shared";
import { resolveHudLayout } from "./hudLayout.js";
import { VitalArcs } from "./VitalArcs.js";

const snapshot: Snapshot = {
  tick: 0,
  elapsed: 0,
  phase: "live",
  countdownRemaining: 0,
  teamScores: [],
  winnerTeam: null,
  projectiles: [],
  decoys: [],
      flags: [],
  asteroids: [],
  ships: [{
    id: 1,
    team: 0,
    pos: { x: 0, y: 0, z: 0 },
    heading: 0,
    pitch: 0,
    up: { x: 0, y: 1, z: 0 },
    hull: 75,
    hullMax: 100,
    targetId: null,
    throttle: 0,
    lockProgress: 0,
    locked: false,
    modules: [{
      hardpointIndex: 0,
      moduleId: "module.shield",
      state: "retracted",
      // A shield's reserve IS its energy tank (2026-08-07): `shieldPool` mirrors
      // that charge for the hull arc, and `energyCapacity` is its denominator.
      energy: 20,
      energyCapacity: 40,
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
      ? { mitigation: { damageReduction: 0.5 } }
      : undefined,
} as unknown as ConfigService;

describe("centre vital arcs", () => {
  it("keeps hull/shield in centre vital arcs with no lower-left panel", () => {
    const root = document.createElement("div");
    const layout = resolveHudLayout(
      {
        hud: {
          gauges: { showHull: true, showShield: true },
          vitalArcs: { enabled: true, radiusPx: 140, strokePx: 5, arcDeg: 120 },
        },
      } as never,
      { width: 400, height: 800 },
    );
    const arcs = new VitalArcs(root, configs, 1);
    arcs.applyLayout(layout);
    arcs.update(snapshot);

    expect(root.querySelector(".hud-gauges")).toBeNull();
    expect(root.querySelector('[data-gauge="energy"]')).toBeNull();
    expect(root.querySelector('[data-gauge="energy"]')).toBeNull();
    expect(root.querySelector<HTMLElement>(".hud-vital-label.hull .value")!.textContent).toBe("75%");
    expect(root.querySelector<HTMLElement>(".hud-vital-label.shield .value")!.textContent).toBe("50%");
    expect(root.querySelector<SVGPathElement>(".hud-vital-arc.fill.hull")!.style.strokeDasharray).toBe("75 100");

    arcs.dispose();
  });

  /**
   * The arcs were unreadable in a live fight (owner, 2026-08-21). The fix keeps
   * the semi-circle design and adds a dark backing stroke under each arc rather
   * than making the arcs themselves louder — so this pins the halo's existence,
   * its geometry (identical to the arc it backs) and its stacking order.
   */
  it("backs each arc with a dark halo on the same path, drawn underneath it", () => {
    const root = document.createElement("div");
    const layout = resolveHudLayout(
      {
        hud: {
          gauges: { showHull: true, showShield: true },
          vitalArcs: { enabled: true, radiusPx: 140, strokePx: 5, arcDeg: 120 },
        },
      } as never,
      { width: 400, height: 800 },
    );
    const arcs = new VitalArcs(root, configs, 1);
    arcs.applyLayout(layout);

    for (const kind of ["hull", "shield"] as const) {
      const halo = root.querySelector<SVGPathElement>(`.hud-vital-arc.halo.${kind}`)!;
      const track = root.querySelector<SVGPathElement>(`.hud-vital-arc.track.${kind}`)!;
      expect(halo).not.toBeNull();
      expect(halo.getAttribute("d")).toBe(track.getAttribute("d"));
      // Painted first, so the arc and its track sit on top of it.
      expect(halo.compareDocumentPosition(track) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    // The halo carries no value — it must never be mistaken for a second gauge.
    expect(root.querySelector(".hud-vital-arc.halo")!.getAttribute("pathLength")).toBeNull();
    arcs.dispose();
  });
});

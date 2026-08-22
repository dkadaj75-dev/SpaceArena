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
   * Owner 2026-08-22: the two arcs must sit FURTHER APART and stop being
   * semicircles ("more like a third or a fourth of a circle"). Both are theme
   * numbers, so this pins the geometry they produce rather than the numbers:
   * each arc keeps the authored radius (its curvature is untouched), the two
   * centres are one `gapPx` apart, and the box grows horizontally only.
   */
  it("draws two short arcs on separate centres, a full gapPx apart", () => {
    const root = document.createElement("div");
    const layout = resolveHudLayout(
      {
        hud: {
          gauges: { showHull: true, showShield: true },
          vitalArcs: { enabled: true, radiusPx: 100, strokePx: 5, arcDeg: 100, gapPx: 60 },
        },
      } as never,
      { width: 400, height: 800 },
    );
    const arcs = new VitalArcs(root, configs, 1);
    arcs.applyLayout(layout);

    const container = root.querySelector<HTMLElement>(".hud-vital-arcs")!;
    const pad = Math.max(8, 5 * 2); // strokePx * 2, floored at 8 — see applyLayout
    // Height is (radius + pad) * 2 as before; only the WIDTH takes the gap.
    expect(container.style.height).toBe(`${(100 + pad) * 2}px`);
    expect(container.style.width).toBe(`${(100 + pad) * 2 + 60}px`);
    expect(root.querySelector("svg")!.getAttribute("viewBox")).toBe(`0 0 ${(100 + pad) * 2 + 60} ${(100 + pad) * 2}`);

    // Each arc's own centre, recovered from its endpoints: the sweep is centred
    // on the horizontal axis, so start and end are mirrored about it and the
    // centre's y is their midpoint; the centre's x is one radius inboard of the
    // arc's extreme (180° for the left arc, 0° for the right).
    const midY = (100 + pad);
    const d = (kind: string): number[] =>
      [...root.querySelector<SVGPathElement>(`.hud-vital-arc.fill.${kind}`)!.getAttribute("d")!.matchAll(/-?\d+(?:\.\d+)?/g)].map(Number);
    const [hullStartX, hullStartY, hullR] = d("hull") as [number, number, number];
    const [shieldStartX, shieldStartY, shieldR] = d("shield") as [number, number, number];
    // Radius reaches the SVG untouched — a gap must never bend the curve.
    expect(hullR).toBeCloseTo(100, 6);
    expect(shieldR).toBeCloseTo(100, 6);

    // Start points sit at ±(arcDeg / 2) off the axis on each side.
    const half = (100 / 2) * (Math.PI / 180);
    const hullCentreX = hullStartX - Math.cos(Math.PI - half) * 100;
    const shieldCentreX = shieldStartX - Math.cos(half) * 100;
    expect(hullStartY).toBeCloseTo(midY + Math.sin(Math.PI - half) * 100, 6);
    expect(shieldStartY).toBeCloseTo(midY + Math.sin(half) * 100, 6);
    // …and the two centres are exactly one gap apart, straddling the middle.
    expect(shieldCentreX - hullCentreX).toBeCloseTo(60, 6);
    expect((hullCentreX + shieldCentreX) / 2).toBeCloseTo(((100 + pad) * 2 + 60) / 2, 6);

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

import type { ShipSnapshot, ThemeConfig } from "@space-arena/shared";
import { describe, expect, it } from "vitest";
import { resolveFlightHudLayout } from "./flightHudLayout.js";
import {
  formatHudDistance,
  roundedHudMeters,
  snapshotSpeedMps,
  SpeedReadout,
} from "./SpeedReadout.js";

/** A ship carrying an authoritative velocity — what the readout actually reads. */
function ship(vx: number, vy = 0, vz = 0): ShipSnapshot {
  return {
    id: 1,
    team: 0,
    pos: { x: 0, y: 0, z: 0 },
    heading: 0,
    pitch: 0,
    up: { x: 0, y: 1, z: 0 },
    hull: 100,
    hullMax: 100,
    targetId: null,
    throttle: 0,
    velocity: { x: vx, y: vy, z: vz },
    lockProgress: 0,
    locked: false,
    modules: [],
  };
}

/** Same ship with the velocity field absent (a pre-velocity server). */
function velocitylessShip(): ShipSnapshot {
  const s = ship(0);
  delete s.velocity;
  return s;
}

describe("HUD measurement formatting", () => {
  it("rounds metres to the nearest non-negative integer", () => {
    expect(roundedHudMeters(141.49)).toBe(141);
    expect(formatHudDistance(141.5)).toBe("142m");
    expect(formatHudDistance(-4)).toBe("0m");
  });
});

describe("SpeedReadout", () => {
  it("reads true 3D metres per second off the snapshot's replicated velocity", () => {
    expect(snapshotSpeedMps(ship(3, 4, 12))).toBe(13);
    // A sample with no velocity at all (pre-velocity server) reads 0, not NaN.
    expect(snapshotSpeedMps(velocitylessShip())).toBe(0);
  });

  it("updates at 10 Hz and reuses its text node", () => {
    const root = document.createElement("div");
    const readout = new SpeedReadout(
      root,
      resolveFlightHudLayout(undefined, { width: 400, height: 800 }),
    );
    const value = root.querySelector<HTMLElement>(".hud-speed-value")!;
    readout.update(ship(10), 0, 0);
    expect(value.textContent).toBe("10 m/s");
    readout.update(ship(40), 0.1, 99); // inside the 10 Hz window: ignored
    expect(value.textContent).toBe("10 m/s");
    readout.update(ship(40), 0.1, 100);
    expect(root.querySelector(".hud-speed-value")).toBe(value);
    expect(value.textContent).toBe("40 m/s");
    readout.dispose();
  });

  it("is immune to the prediction-correction wobble that the differenced measure had", () => {
    // The bug: online, the own ship is drawn by the PREDICTOR, whose position is
    // pulled toward the authoritative path by a correction term every frame.
    // Differentiating that position added the correction's own motion to the
    // measured speed, so the readout wandered whenever the pilot steered — even
    // at a dead-steady throttle. Velocity comes off the authoritative snapshot,
    // which the correction cannot touch: a steady 42 u/s reads 42 on every
    // single sample, whatever the rendered position is doing.
    const root = document.createElement("div");
    const readout = new SpeedReadout(
      root,
      resolveFlightHudLayout(undefined, { width: 400, height: 800 }),
    );
    const value = root.querySelector<HTMLElement>(".hud-speed-value")!;
    const written: string[] = [];
    for (let frame = 0; frame <= 60; frame++) {
      const nowMs = frame * 16.667;
      const s = ship(42);
      // A correction of up to ±0.4 units per frame riding on the rendered pose,
      // exactly as reconciliation produces. It must not reach the readout.
      s.pos.x = 42 * (nowMs / 1000) + Math.sin(frame) * 0.4;
      const before = value.textContent;
      readout.update(s, nowMs / 1000, nowMs);
      if (value.textContent !== before && value.textContent) written.push(value.textContent);
    }
    expect(written).toEqual(["42 m/s"]);
    readout.dispose();
  });

  it("holds its reading through a starved buffer replaying the same snapshot", () => {
    const root = document.createElement("div");
    const readout = new SpeedReadout(
      root,
      resolveFlightHudLayout(undefined, { width: 400, height: 800 }),
    );
    const value = root.querySelector<HTMLElement>(".hud-speed-value")!;
    readout.update(ship(10), 0, 0);
    expect(value.textContent).toBe("10 m/s");
    // Interpolation hold: the same snapshot served again, match clock frozen.
    readout.update(ship(10), 0, 100);
    readout.update(ship(10), 0, 200);
    expect(value.textContent).toBe("10 m/s");
    readout.dispose();
  });

  it("scales by the theme's display-only metres-per-unit factor", () => {
    const root = document.createElement("div");
    const layout = resolveFlightHudLayout(undefined, { width: 400, height: 800 });
    const readout = new SpeedReadout(root, { ...layout, metersPerUnit: 2 });
    const value = root.querySelector<HTMLElement>(".hud-speed-value")!;
    readout.update(ship(0, 0, 30), 0, 0);
    expect(value.textContent).toBe("60 m/s");
    readout.dispose();
  });

  it("resolves beside the throttle in portrait and landscape", () => {
    const theme = {
      id: "theme.speed-test",
      type: "theme",
      version: 1,
      colors: {},
      hud: {
        scale: 1,
        flight: {
          throttle: {
            anchor: "bottom-right",
            widthPx: 44,
            heightPx: 200,
            thumbHeightPx: 26,
            offsetXPx: 6,
            offsetYPx: 212,
          },
        },
        landscape: {
          scale: 0.5,
          flight: { throttle: { heightPx: 150 } },
        },
      },
    } as ThemeConfig;
    const root = document.createElement("div");
    const portrait = resolveFlightHudLayout(theme, { width: 400, height: 800 });
    const readout = new SpeedReadout(root, portrait);
    const value = root.querySelector<HTMLElement>(".hud-speed-value")!;
    expect(root.querySelector<HTMLElement>(".hud-speed")!.dataset["anchor"]).toBe(
      portrait.throttle.anchor,
    );
    expect(value.style.left).toBe("-28px");
    expect(value.style.top).toBe("-202px");

    const landscape = resolveFlightHudLayout(theme, { width: 800, height: 400 });
    readout.applyLayout(landscape);
    expect(value.style.left).toBe("-14px");
    expect(value.style.top).toBe("-101px");
    readout.dispose();
  });
});

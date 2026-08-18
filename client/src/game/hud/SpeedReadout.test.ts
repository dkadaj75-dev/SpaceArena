import type { ShipSnapshot, ThemeConfig } from "@space-arena/shared";
import { describe, expect, it } from "vitest";
import { resolveFlightHudLayout } from "./flightHudLayout.js";
import {
  formatHudDistance,
  roundedHudMeters,
  snapshotSpeedMps,
  SpeedReadout,
} from "./SpeedReadout.js";

function ship(x: number, y: number, z: number): ShipSnapshot {
  return {
    id: 1,
    team: 0,
    pos: { x, y, z },
    heading: 0,
    pitch: 0,
    up: { x: 0, y: 1, z: 0 },
    hull: 100,
    hullMax: 100,
    targetId: null,
    throttle: 0,
    lockProgress: 0,
    locked: false,
    modules: [],
  };
}

describe("HUD measurement formatting", () => {
  it("rounds metres to the nearest non-negative integer", () => {
    expect(roundedHudMeters(141.49)).toBe(141);
    expect(formatHudDistance(141.5)).toBe("142m");
    expect(formatHudDistance(-4)).toBe("0m");
  });
});

describe("SpeedReadout", () => {
  it("derives true 3D metres per second from successive snapshots", () => {
    expect(snapshotSpeedMps(ship(3, 4, 12), ship(0, 0, 0), 0.5)).toBe(26);
    expect(snapshotSpeedMps(ship(3, 4, 12), ship(0, 0, 0), 0)).toBe(0);
  });

  it("updates at 10 Hz over the display window and reuses its text node", () => {
    const root = document.createElement("div");
    const readout = new SpeedReadout(
      root,
      resolveFlightHudLayout(undefined, { width: 400, height: 800 }),
    );
    const value = root.querySelector<HTMLElement>(".hud-speed-value")!;
    readout.update(ship(0, 0, 0), 0, 0);          // anchor sample — nothing to show yet
    readout.update(ship(1, 0, 0), 0.1, 99);       // inside the 10 Hz window: ignored
    readout.update(ship(1, 0, 0), 0.1, 100);      // 1 unit over 0.1 s
    expect(value.textContent).toBe("10 m/s");
    readout.update(ship(5, 0, 0), 0.2, 200);      // 4 more units over the next 0.1 s
    expect(root.querySelector(".hud-speed-value")).toBe(value);
    expect(value.textContent).toBe("40 m/s");
    readout.dispose();
  });

  it("averages out fixed-step position quantization instead of flapping to 0 (online own-ship)", () => {
    // Online the own ship's predicted position advances in 33 ms sim steps
    // while `elapsed` interpolates smoothly: frame pairs alternate between "no
    // movement" and "a whole step of movement". The windowed measure must read
    // the TRUE speed (10 u/s here), never 0, on every written sample.
    const root = document.createElement("div");
    const readout = new SpeedReadout(
      root,
      resolveFlightHudLayout(undefined, { width: 400, height: 800 }),
    );
    const value = root.querySelector<HTMLElement>(".hud-speed-value")!;
    const written: string[] = [];
    let x = 0;
    for (let frame = 0; frame <= 60; frame++) {
      const nowMs = frame * 16.667;
      const elapsed = nowMs / 1000;
      // A predict tick lands on every OTHER frame: position moves in 0.333-unit
      // steps (10 u/s at 30 Hz) while elapsed advances every frame.
      if (frame % 2 === 0 && frame > 0) x += 10 * (2 * 16.667) / 1000;
      const before = value.textContent;
      readout.update(ship(x, 0, 0), elapsed, nowMs);
      if (value.textContent !== before && value.textContent) written.push(value.textContent);
    }
    expect(written.length).toBeGreaterThan(0);
    for (const text of written) expect(text).toBe("10 m/s");
    readout.dispose();
  });

  it("holds the last reading through a starved window instead of reporting 0", () => {
    const root = document.createElement("div");
    const readout = new SpeedReadout(
      root,
      resolveFlightHudLayout(undefined, { width: 400, height: 800 }),
    );
    const value = root.querySelector<HTMLElement>(".hud-speed-value")!;
    readout.update(ship(0, 0, 0), 0, 0);
    readout.update(ship(1, 0, 0), 0.1, 100);
    expect(value.textContent).toBe("10 m/s");
    // Interpolation hold: same snapshot served again — elapsed did not move.
    readout.update(ship(1, 0, 0), 0.1, 200);
    expect(value.textContent).toBe("10 m/s");
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

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
    hull: 100,
    hullMax: 100,
    energy: { cur: 100, max: 100 },
    heat: { cur: 0, capacity: 100 },
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

  it("updates at 10 Hz and reuses its text node", () => {
    const root = document.createElement("div");
    const readout = new SpeedReadout(
      root,
      resolveFlightHudLayout(undefined, { width: 400, height: 800 }),
    );
    const value = root.querySelector<HTMLElement>(".hud-speed-value")!;
    readout.update(ship(1, 0, 0), ship(0, 0, 0), 0.1, 0);
    expect(value.textContent).toBe("10 m/s");
    readout.update(ship(4, 0, 0), ship(0, 0, 0), 0.1, 99);
    expect(value.textContent).toBe("10 m/s");
    readout.update(ship(4, 0, 0), ship(0, 0, 0), 0.1, 100);
    expect(root.querySelector(".hud-speed-value")).toBe(value);
    expect(value.textContent).toBe("40 m/s");
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

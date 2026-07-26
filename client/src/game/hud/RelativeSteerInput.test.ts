// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { HUD_CONTROL_ATTR } from "../inputGuards.js";
import { resolveFlightHudLayout } from "./flightHudLayout.js";
import {
  RelativeSteerInput,
  startsOnHudControl,
  startsOnSteerSurface,
} from "./RelativeSteerInput.js";

function pointer(
  type: string,
  init: {
    id: number;
    pointerType: "mouse" | "touch" | "pen";
    button?: number;
    x?: number;
    y?: number;
    movementX?: number;
    movementY?: number;
  },
): Event {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(ev, {
    pointerId: init.id,
    pointerType: init.pointerType,
    button: init.button ?? 0,
    clientX: init.x ?? 0,
    clientY: init.y ?? 0,
    movementX: init.movementX ?? 0,
    movementY: init.movementY ?? 0,
  });
  return ev;
}

function mount() {
  const root = document.createElement("div");
  const canvas = document.createElement("canvas");
  document.body.append(canvas, root);
  const input = new RelativeSteerInput(root, canvas, resolveFlightHudLayout(undefined, { width: 800, height: 600 }));
  return { root, canvas, input };
}

describe("RelativeSteerInput", () => {
  it("accumulates RMB mouse deltas and recentres both axes on release", () => {
    const { canvas, input } = mount();
    canvas.dispatchEvent(pointer("pointerdown", { id: 1, pointerType: "mouse", button: 2, x: 100, y: 100 }));
    document.dispatchEvent(pointer("pointermove", { id: 1, pointerType: "mouse", x: 110, y: 95, movementX: 10, movementY: -5 }));
    const firstTurn = input.turn;
    expect(input.active).toBe(true);
    expect(Math.abs(firstTurn)).toBeGreaterThan(0);
    expect(input.pitchStick).toBeGreaterThan(0);
    document.dispatchEvent(pointer("pointermove", { id: 1, pointerType: "mouse", x: 120, y: 90, movementX: 10, movementY: -5 }));
    expect(Math.abs(input.turn)).toBeGreaterThan(Math.abs(firstTurn));
    document.dispatchEvent(pointer("pointerup", { id: 1, pointerType: "mouse" }));
    expect(input.active).toBe(false);
    expect(input.turn).toBe(0);
    expect(input.pitchStick).toBe(0);
    input.dispose();
    canvas.remove();
  });

  it("rejects touch origins on HUD controls but accepts a free-area origin", () => {
    const { root, canvas, input } = mount();
    const button = document.createElement("button");
    button.setAttribute(HUD_CONTROL_ATTR, "throttle");
    root.append(button);
    expect(startsOnHudControl(button)).toBe(true);
    button.dispatchEvent(pointer("pointerdown", { id: 2, pointerType: "touch", x: 20, y: 20 }));
    expect(input.active).toBe(false);

    canvas.dispatchEvent(pointer("pointerdown", { id: 3, pointerType: "touch", x: 100, y: 100 }));
    document.dispatchEvent(pointer("pointermove", { id: 3, pointerType: "touch", x: 150, y: 60 }));
    expect(input.active).toBe(true);
    expect(Math.abs(input.turn)).toBeGreaterThan(0);
    expect(input.pitchStick).toBeGreaterThan(0);
    document.dispatchEvent(pointer("pointercancel", { id: 3, pointerType: "touch" }));
    expect(input.turn).toBe(0);
    input.dispose();
    canvas.remove();
  });

  it("rejects modal-overlay touches outside the canvas/HUD allow-list and accepts pen", () => {
    const { root, canvas, input } = mount();
    const setCapture = vi.fn();
    const releaseCapture = vi.fn();
    Object.assign(canvas, {
      setPointerCapture: setCapture,
      hasPointerCapture: () => true,
      releasePointerCapture: releaseCapture,
    });
    const overlay = document.createElement("div");
    const slider = document.createElement("input");
    overlay.append(slider);
    document.body.append(overlay);

    expect(startsOnSteerSurface(slider, root, canvas)).toBe(false);
    slider.dispatchEvent(pointer("pointerdown", { id: 4, pointerType: "touch", x: 10, y: 10 }));
    expect(input.active).toBe(false);

    canvas.dispatchEvent(pointer("pointerdown", { id: 5, pointerType: "pen", x: 100, y: 100 }));
    document.dispatchEvent(pointer("pointermove", { id: 5, pointerType: "pen", x: 140, y: 80 }));
    expect(input.active).toBe(true);
    expect(input.turn).not.toBe(0);
    input.setEnabled(false);
    expect(input.active).toBe(false);
    expect(setCapture).toHaveBeenCalledWith(5);
    expect(releaseCapture).toHaveBeenCalledWith(5);

    input.dispose();
    overlay.remove();
    canvas.remove();
  });

  it("rebases an active mouse accumulator when max radius changes", () => {
    const { canvas, input } = mount();
    canvas.dispatchEvent(pointer("pointerdown", { id: 6, pointerType: "mouse", button: 2, x: 100, y: 100 }));
    document.dispatchEvent(pointer("pointermove", {
      id: 6,
      pointerType: "mouse",
      x: 110,
      y: 100,
      movementX: 10,
    }));
    const before = input.turn;
    const next = resolveFlightHudLayout(undefined, { width: 400, height: 300 });
    input.applyLayout(next);
    expect(input.turn).toBeCloseTo(before, 6);
    input.dispose();
    canvas.remove();
  });

  it("uses pointer lock for RMB and exits/recentres on release or Escape", () => {
    const { canvas, input } = mount();
    let lockElement: Element | null = null;
    Object.defineProperty(document, "pointerLockElement", {
      configurable: true,
      get: () => lockElement,
    });
    Object.assign(canvas, {
      requestPointerLock: () => {
        lockElement = canvas;
        document.dispatchEvent(new Event("pointerlockchange"));
        return Promise.resolve();
      },
    });
    Object.assign(document, {
      exitPointerLock: () => {
        lockElement = null;
        document.dispatchEvent(new Event("pointerlockchange"));
      },
    });

    canvas.dispatchEvent(pointer("pointerdown", { id: 7, pointerType: "mouse", button: 2 }));
    expect(lockElement).toBe(canvas);
    document.dispatchEvent(pointer("pointermove", {
      id: 7,
      pointerType: "mouse",
      movementX: 12,
      movementY: -4,
    }));
    expect(input.turn).not.toBe(0);
    document.dispatchEvent(pointer("pointerup", { id: 7, pointerType: "mouse" }));
    expect(lockElement).toBeNull();
    expect(input.active).toBe(false);

    canvas.dispatchEvent(pointer("pointerdown", { id: 8, pointerType: "mouse", button: 2 }));
    lockElement = null;
    document.dispatchEvent(new Event("pointerlockchange"));
    expect(input.active).toBe(false);
    input.dispose();
    canvas.remove();
  });
});

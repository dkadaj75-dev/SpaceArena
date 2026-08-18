// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { HUD_CONTROL_ATTR } from "../inputGuards.js";
import { resolveFlightHudLayout } from "./flightHudLayout.js";
import {
  applySteerSensitivity,
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
  it("applies the player multiplier to the input mapping", () => {
    expect(applySteerSensitivity(24, 0.5)).toBe(12);
    expect(applySteerSensitivity(-24, 2.5)).toBe(-60);
  });

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
    document.dispatchEvent(pointer("pointerup", { id: 1, pointerType: "mouse", button: 2 }));
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

  it("does not start a steer drag from a FIRE jab", () => {
    const { root, canvas, input } = mount();
    const fire = document.createElement("div");
    fire.setAttribute(HUD_CONTROL_ATTR, "fire");
    root.append(fire);
    fire.dispatchEvent(pointer("pointerdown", {
      id: 8,
      pointerType: "touch",
      x: 40,
      y: 40,
    }));
    expect(input.active).toBe(false);
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

  it("applies sensitivity changes live to active mouse and touch gestures", () => {
    const { canvas, input } = mount();
    canvas.dispatchEvent(pointer("pointerdown", { id: 9, pointerType: "mouse", button: 2 }));
    document.dispatchEvent(pointer("pointermove", {
      id: 9,
      pointerType: "mouse",
      movementX: 30,
    }));
    const mouseBefore = input.turn;
    input.setSensitivityMultipliers(2, 1);
    expect(Math.abs(input.turn)).toBeGreaterThan(Math.abs(mouseBefore));
    document.dispatchEvent(pointer("pointerup", { id: 9, pointerType: "mouse", button: 2 }));

    canvas.dispatchEvent(pointer("pointerdown", { id: 10, pointerType: "touch", x: 100, y: 100 }));
    document.dispatchEvent(pointer("pointermove", {
      id: 10,
      pointerType: "touch",
      x: 120,
      y: 100,
    }));
    const touchBefore = input.turn;
    input.setSensitivityMultipliers(2, 2);
    expect(Math.abs(input.turn)).toBeGreaterThan(Math.abs(touchBefore));
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
    document.dispatchEvent(pointer("pointerup", { id: 7, pointerType: "mouse", button: 2 }));
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

describe("desktop auto-center", () => {
  it("a stationary mouse springs back to neutral while the drag stays live", () => {
    const frames: FrameRequestCallback[] = [];
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => { frames.push(cb); return frames.length; });
    const caf = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    const { canvas, input } = mount();
    canvas.dispatchEvent(pointer("pointerdown", { id: 1, pointerType: "mouse", button: 2, x: 100, y: 100 }));
    document.dispatchEvent(pointer("pointermove", { id: 1, pointerType: "mouse", x: 160, y: 80, movementX: 60, movementY: -20 }));
    expect(Math.abs(input.turn)).toBeGreaterThan(0);
    const deflected = Math.abs(input.turn);

    // ~2 s of frames with the mouse perfectly still: the offset decays through
    // its 160 ms half-life and snaps to exact zero, but the drag stays live.
    let now = performance.now();
    for (let i = 0; i < 40 && frames.length; i++) { now += 50; frames.shift()!(now); }
    expect(input.turn).toBe(0);
    expect(input.pitchStick).toBe(0);
    expect(input.active).toBe(true);

    // Movement immediately deflects again — decay only wins while stationary.
    document.dispatchEvent(pointer("pointermove", { id: 1, pointerType: "mouse", x: 220, y: 80, movementX: 60 }));
    expect(Math.abs(input.turn)).toBeGreaterThanOrEqual(deflected * 0.5);
    raf.mockRestore(); caf.mockRestore();
  });

  it("touch steering is untouched: offset holds while the finger rests", () => {
    const frames: FrameRequestCallback[] = [];
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => { frames.push(cb); return frames.length; });
    const { canvas, input } = mount();
    canvas.dispatchEvent(pointer("pointerdown", { id: 7, pointerType: "touch", x: 100, y: 100 }));
    document.dispatchEvent(pointer("pointermove", { id: 7, pointerType: "touch", x: 150, y: 100 }));
    const held = input.turn;
    expect(Math.abs(held)).toBeGreaterThan(0);
    let now = performance.now();
    for (let i = 0; i < 40 && frames.length; i++) { now += 50; frames.shift()!(now); }
    expect(input.turn).toBe(held);
    raf.mockRestore();
  });
});

import { describe, expect, it, vi } from "vitest";
import { classifySwipe, SwipeWatcher, SWIPE_THRESHOLDS, wrapIndex, type SwipePoint } from "./hangarSwipe.js";

const at = (x: number, y: number, t: number): SwipePoint => ({ x, y, t });

describe("classifySwipe (owner 2026-07-31)", () => {
  it("reads a leftward flick as 'next' and a rightward one as 'previous'", () => {
    expect(classifySwipe(at(300, 200, 0), at(150, 205, 200))).toBe(1);
    expect(classifySwipe(at(150, 200, 0), at(300, 205, 200))).toBe(-1);
  });

  it("ignores a drag too short to be meant", () => {
    expect(classifySwipe(at(300, 200, 0), at(260, 200, 120))).toBe(0);
  });

  it("ignores a diagonal — that is the camera being orbited, not a swipe", () => {
    expect(classifySwipe(at(300, 200, 0), at(180, 320, 200))).toBe(0);
  });

  it("ignores a slow drag, however far it travels", () => {
    expect(classifySwipe(at(400, 200, 0), at(100, 200, SWIPE_THRESHOLDS.maxDurationMs + 1))).toBe(0);
  });

  it("ignores a negative duration rather than trusting a jumped clock", () => {
    expect(classifySwipe(at(400, 200, 500), at(100, 200, 0))).toBe(0);
  });

  it("honours custom thresholds", () => {
    const loose = { minDistancePx: 10, offAxisRatio: 1, maxDurationMs: 5000 };
    expect(classifySwipe(at(300, 200, 0), at(280, 205, 3000), loose)).toBe(1);
  });
});

describe("wrapIndex", () => {
  it("cycles both ways", () => {
    expect(wrapIndex(0, -1, 3)).toBe(2);
    expect(wrapIndex(2, 1, 3)).toBe(0);
    expect(wrapIndex(1, 1, 3)).toBe(2);
  });

  it("survives an empty list", () => {
    expect(wrapIndex(0, 1, 0)).toBe(0);
  });
});

describe("SwipeWatcher", () => {
  function harness(opts: { shouldTrack?: (ev: PointerEvent) => boolean } = {}) {
    const target = document.createElement("div");
    const onSwipe = vi.fn();
    let now = 0;
    const watcher = new SwipeWatcher(target, { onSwipe, now: () => now, ...opts });
    // happy-dom has no PointerEvent constructor with clientX/Y, so dispatch a
    // plain Event carrying the fields the watcher actually reads.
    const fire = (type: string, x: number, y: number, isPrimary = true): void => {
      const ev = new Event(type);
      Object.assign(ev, { clientX: x, clientY: y, isPrimary });
      target.dispatchEvent(ev);
    };
    return { target, onSwipe, watcher, fire, tick: (ms: number) => (now += ms) };
  }

  it("reports a qualifying flick once", () => {
    const h = harness();
    h.fire("pointerdown", 300, 200);
    h.tick(150);
    h.fire("pointerup", 120, 210);
    expect(h.onSwipe).toHaveBeenCalledTimes(1);
    expect(h.onSwipe).toHaveBeenCalledWith(1);
  });

  it("stays quiet when the gesture never started on it", () => {
    const h = harness();
    h.fire("pointerup", 120, 210);
    expect(h.onSwipe).not.toHaveBeenCalled();
  });

  it("drops a cancelled pointer rather than measuring where it died", () => {
    const h = harness();
    h.fire("pointerdown", 300, 200);
    h.tick(50);
    h.fire("pointercancel", 100, 200);
    h.fire("pointerup", 100, 200);
    expect(h.onSwipe).not.toHaveBeenCalled();
  });

  it("ignores a secondary pointer — two fingers are a pinch", () => {
    const h = harness();
    h.fire("pointerdown", 300, 200, false);
    h.tick(100);
    h.fire("pointerup", 100, 200, false);
    expect(h.onSwipe).not.toHaveBeenCalled();
  });

  it("honours shouldTrack, so a drag inside the info panel is not a ship change", () => {
    const h = harness({ shouldTrack: () => false });
    h.fire("pointerdown", 300, 200);
    h.tick(100);
    h.fire("pointerup", 100, 200);
    expect(h.onSwipe).not.toHaveBeenCalled();
  });

  it("stops listening once disposed", () => {
    const h = harness();
    h.watcher.dispose();
    h.fire("pointerdown", 300, 200);
    h.tick(100);
    h.fire("pointerup", 100, 200);
    expect(h.onSwipe).not.toHaveBeenCalled();
  });
});

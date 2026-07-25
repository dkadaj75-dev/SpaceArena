import { describe, expect, it } from "vitest";
import { HUD_CONTROL_ATTR } from "../inputGuards.js";
import { resolveFlightHudLayout } from "./flightHudLayout.js";
import { ThrottleStrip } from "./ThrottleStrip.js";

const LAYOUT = resolveFlightHudLayout(undefined, { width: 400, height: 800 });
/** Default track: 44 × 200 px. Bottom edge is y = 800, top edge y = 600. */
const RECT = { left: 340, top: 600, width: 44, height: 200 };
const TOP = RECT.top;
const BOTTOM = RECT.top + RECT.height;

function pointer(type: string, id: number, clientY: number): Event {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(ev, { pointerId: id, clientX: RECT.left + 20, clientY, pointerType: "touch" });
  return ev;
}

function mount(): { strip: ThrottleStrip; track: HTMLElement; root: HTMLElement } {
  const root = document.createElement("div");
  const strip = new ThrottleStrip(root, LAYOUT);
  const track = root.querySelector<HTMLElement>(".hud-throttle-track")!;
  track.getBoundingClientRect = () => ({ ...RECT, right: RECT.left + RECT.width, bottom: BOTTOM, x: RECT.left, y: RECT.top, toJSON: () => ({}) }) as DOMRect;
  return { strip, track, root };
}

describe("ThrottleStrip (FLIGHT.md §4)", () => {
  it("is tagged as a HUD control so edge palm-rejection never eats it", () => {
    const { track, strip } = mount();
    expect(track.getAttribute(HUD_CONTROL_ATTR)).toBe("throttle");
    strip.dispose();
  });

  it("starts at 0 % — a fresh ship does not fly off on spawn", () => {
    const { strip, root } = mount();
    expect(strip.throttle).toBe(0);
    expect(root.querySelector(".hud-throttle-readout")!.textContent).toBe("0%");
    strip.dispose();
  });

  it("maps the bottom of the track to 0 % and the top to 100 %", () => {
    const { track, strip } = mount();
    track.dispatchEvent(pointer("pointerdown", 1, TOP));
    expect(strip.throttle).toBe(1);
    track.dispatchEvent(pointer("pointermove", 1, BOTTOM));
    expect(strip.throttle).toBe(0);
    track.dispatchEvent(pointer("pointermove", 1, TOP + RECT.height / 2));
    expect(strip.throttle).toBeCloseTo(0.5, 9);
    strip.dispose();
  });

  it("HOLDS its value where the thumb was released — it is a lever, not a spring", () => {
    const { track, strip } = mount();
    track.dispatchEvent(pointer("pointerdown", 1, TOP + 50)); // 75 %
    track.dispatchEvent(pointer("pointerup", 1, TOP + 50));
    expect(strip.throttle).toBeCloseTo(0.75, 9);
    expect(strip.active).toBe(false);
    // …and it stays there across any number of frames.
    expect(strip.throttle).toBeCloseTo(0.75, 9);
    strip.dispose();
  });

  it("clamps a drag past either end instead of losing the grab", () => {
    const { track, strip } = mount();
    track.dispatchEvent(pointer("pointerdown", 1, TOP + 100));
    track.dispatchEvent(pointer("pointermove", 1, TOP - 400));
    expect(strip.throttle).toBe(1);
    track.dispatchEvent(pointer("pointermove", 1, BOTTOM + 400));
    expect(strip.throttle).toBe(0);
    // Still holding: coming back inside the track resumes control.
    track.dispatchEvent(pointer("pointermove", 1, TOP + 100));
    expect(strip.throttle).toBeCloseTo(0.5, 9);
    strip.dispose();
  });

  it("shows a whole-percent readout that follows the lever", () => {
    const { track, strip, root } = mount();
    const readout = root.querySelector(".hud-throttle-readout")!;
    track.dispatchEvent(pointer("pointerdown", 1, TOP + 50));
    expect(readout.textContent).toBe("75%");
    track.dispatchEvent(pointer("pointermove", 1, TOP));
    expect(readout.textContent).toBe("100%");
    strip.dispose();
  });

  it("moves the thumb from the bottom of its travel to the top", () => {
    const { track, strip, root } = mount();
    const thumb = root.querySelector<HTMLElement>(".hud-throttle-thumb")!;
    // Default thumb is 26 px, so travel is 200 - 26 = 174 px.
    expect(thumb.style.top).toBe("174px");
    track.dispatchEvent(pointer("pointerdown", 1, TOP));
    expect(thumb.style.top).toBe("0px");
    strip.dispose();
  });

  it("accepts the desktop key ramp, but not while a thumb is on the lever", () => {
    const { track, strip } = mount();
    strip.setThrottle(0.4);
    expect(strip.throttle).toBeCloseTo(0.4, 9);

    track.dispatchEvent(pointer("pointerdown", 1, TOP)); // grab at 100 %
    strip.setThrottle(0.1); // a held W/S must not fight the thumb
    expect(strip.throttle).toBe(1);

    track.dispatchEvent(pointer("pointerup", 1, TOP));
    strip.setThrottle(0.1);
    expect(strip.throttle).toBeCloseTo(0.1, 9);
    strip.dispose();
  });

  it("clamps anything pushed in from outside", () => {
    const { strip } = mount();
    strip.setThrottle(5);
    expect(strip.throttle).toBe(1);
    strip.setThrottle(-5);
    expect(strip.throttle).toBe(0);
    strip.dispose();
  });

  it("removes its DOM on dispose", () => {
    const { root, strip } = mount();
    strip.dispose();
    expect(root.querySelector(".hud-throttle")).toBeNull();
  });
});

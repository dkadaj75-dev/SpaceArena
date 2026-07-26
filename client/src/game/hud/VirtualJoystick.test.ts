import { describe, expect, it } from "vitest";
import { TURN_SIGN_FOR_SCREEN_RIGHT } from "../chaseCamera.js";
import { HUD_CONTROL_ATTR } from "../inputGuards.js";
import { resolveFlightHudLayout } from "./flightHudLayout.js";
import { VirtualJoystick } from "./VirtualJoystick.js";

const LAYOUT = resolveFlightHudLayout(undefined, { width: 400, height: 800 });
/** Default base radius is 62 px, so the ring the thumb travels in is 124 px wide. */
const RECT = { left: 100, top: 600, width: 124, height: 124 };
const CENTRE = { x: RECT.left + RECT.width / 2, y: RECT.top + RECT.height / 2 };

function pointer(type: string, id: number, clientX: number, clientY: number): Event {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(ev, { pointerId: id, clientX, clientY, pointerType: "touch" });
  return ev;
}

function mount(): { joystick: VirtualJoystick; base: HTMLElement; root: HTMLElement } {
  const root = document.createElement("div");
  const joystick = new VirtualJoystick(root, LAYOUT);
  const base = root.querySelector<HTMLElement>(".hud-joystick-base")!;
  // happy-dom has no layout engine; the widget reads its own live rect, so give
  // it the geometry the theme would have produced.
  base.getBoundingClientRect = () => ({ ...RECT, right: RECT.left + RECT.width, bottom: RECT.top + RECT.height, x: RECT.left, y: RECT.top, toJSON: () => ({}) }) as DOMRect;
  return { joystick, base, root };
}

describe("VirtualJoystick (FLIGHT.md §4)", () => {
  it("is tagged as a HUD control so edge palm-rejection never eats it", () => {
    const { base, joystick } = mount();
    expect(base.getAttribute(HUD_CONTROL_ATTR)).toBe("joystick");
    joystick.dispose();
  });

  it("maps a thumb pushed to the RIGHT of the base onto the screen-right turn sign", () => {
    const { base, joystick } = mount();
    base.dispatchEvent(pointer("pointerdown", 1, CENTRE.x + 62, CENTRE.y));
    expect(joystick.deflectionX).toBeCloseTo(1, 6);
    expect(Math.sign(joystick.turn)).toBe(TURN_SIGN_FOR_SCREEN_RIGHT);
    expect(joystick.turn).toBeCloseTo(TURN_SIGN_FOR_SCREEN_RIGHT, 6);
    joystick.dispose();
  });

  it("maps a thumb pushed LEFT to the opposite turn", () => {
    const { base, joystick } = mount();
    base.dispatchEvent(pointer("pointerdown", 1, CENTRE.x - 62, CENTRE.y));
    expect(joystick.deflectionX).toBeCloseTo(-1, 6);
    expect(Math.sign(joystick.turn)).toBe(-TURN_SIGN_FOR_SCREEN_RIGHT);
    joystick.dispose();
  });

  it("applies the theme's deadzone: a thumb barely off centre is a straight line", () => {
    const { base, joystick } = mount();
    // Default deadzone is 0.12 of the base radius (62 px) ⇒ ~7.4 px.
    base.dispatchEvent(pointer("pointerdown", 1, CENTRE.x + 5, CENTRE.y));
    expect(joystick.deflectionX).toBeGreaterThan(0);
    expect(joystick.turn).toBe(0);
    joystick.dispose();
  });

  it("tracks a drag and springs back to centre on release", () => {
    const { base, joystick } = mount();
    base.dispatchEvent(pointer("pointerdown", 1, CENTRE.x + 31, CENTRE.y));
    expect(joystick.active).toBe(true);
    const half = joystick.turn;
    expect(Math.abs(half)).toBeGreaterThan(0);

    base.dispatchEvent(pointer("pointermove", 1, CENTRE.x + 62, CENTRE.y));
    expect(Math.abs(joystick.turn)).toBeGreaterThan(Math.abs(half));

    base.dispatchEvent(pointer("pointerup", 1, CENTRE.x + 62, CENTRE.y));
    expect(joystick.active).toBe(false);
    expect(joystick.turn).toBe(0);
    joystick.dispose();
  });

  it("maps a thumb pushed UP the screen to a climb, and down to a dive (BUBBLE.md §C)", () => {
    const { base, joystick } = mount();
    base.dispatchEvent(pointer("pointerdown", 1, CENTRE.x, CENTRE.y - 62));
    expect(joystick.deflectionY).toBeCloseTo(-1, 6);
    expect(joystick.pitch).toBeCloseTo(1, 6);

    base.dispatchEvent(pointer("pointermove", 1, CENTRE.x, CENTRE.y + 62));
    expect(joystick.deflectionY).toBeCloseTo(1, 6);
    expect(joystick.pitch).toBeCloseTo(-1, 6);
    joystick.dispose();
  });

  it("flips the pitch axis (and only the pitch axis) when the player inverts it", () => {
    const { base, joystick } = mount();
    joystick.setInvertPitch(true);
    base.dispatchEvent(pointer("pointerdown", 1, CENTRE.x + 62, CENTRE.y - 62));
    const invertedPitch = joystick.pitch;
    const invertedTurn = joystick.turn;
    expect(invertedPitch).toBeLessThan(0); // pushed up ⇒ nose DOWN once inverted

    joystick.setInvertPitch(false);
    expect(joystick.pitch).toBeCloseTo(-invertedPitch, 12);
    expect(joystick.turn).toBe(invertedTurn); // steering is untouched
    joystick.dispose();
  });

  it("applies the theme's deadzone to the pitch axis too", () => {
    const { base, joystick } = mount();
    // Default deadzone is 0.12 of the base radius (62 px) ⇒ ~7.4 px.
    base.dispatchEvent(pointer("pointerdown", 1, CENTRE.x, CENTRE.y - 5));
    expect(joystick.deflectionY).toBeLessThan(0);
    expect(joystick.pitch).toBe(0);
    joystick.dispose();
  });

  it("springs the pitch axis back to centre on release, like the turn axis", () => {
    const { base, joystick } = mount();
    base.dispatchEvent(pointer("pointerdown", 1, CENTRE.x, CENTRE.y - 62));
    expect(joystick.pitch).toBeGreaterThan(0);
    base.dispatchEvent(pointer("pointerup", 1, CENTRE.x, CENTRE.y - 62));
    // "Stop pitching", not "level out" — the sim holds the nose where it is.
    expect(joystick.pitch).toBe(0);
    joystick.dispose();
  });

  it("drives both axes at once from one diagonal push", () => {
    const { base, joystick } = mount();
    base.dispatchEvent(pointer("pointerdown", 1, CENTRE.x + 44, CENTRE.y - 44));
    expect(Math.abs(joystick.turn)).toBeGreaterThan(0);
    expect(joystick.pitch).toBeGreaterThan(0);
    joystick.dispose();
  });

  it("clamps to the unit disc, so a diagonal drag is not a harder turn than a sideways one", () => {
    const { base, joystick } = mount();
    // 200 px out on both axes: way outside the ring, at 45°.
    base.dispatchEvent(pointer("pointerdown", 1, CENTRE.x + 200, CENTRE.y + 200));
    expect(joystick.deflectionX).toBeCloseTo(Math.SQRT1_2, 6);
    expect(Math.abs(joystick.turn)).toBeLessThan(1);
    joystick.dispose();
  });

  it("ignores a second finger while one is already on the stick", () => {
    const { base, joystick } = mount();
    base.dispatchEvent(pointer("pointerdown", 1, CENTRE.x + 62, CENTRE.y));
    const held = joystick.turn;
    base.dispatchEvent(pointer("pointerdown", 2, CENTRE.x - 62, CENTRE.y));
    base.dispatchEvent(pointer("pointermove", 2, CENTRE.x - 62, CENTRE.y));
    expect(joystick.turn).toBe(held);
    joystick.dispose();
  });

  it("releases on pointercancel (a palm/system gesture stealing the touch)", () => {
    const { base, joystick } = mount();
    base.dispatchEvent(pointer("pointerdown", 1, CENTRE.x + 62, CENTRE.y));
    base.dispatchEvent(pointer("pointercancel", 1, CENTRE.x + 62, CENTRE.y));
    expect(joystick.turn).toBe(0);
    expect(joystick.active).toBe(false);
    joystick.dispose();
  });

  it("removes its DOM on dispose", () => {
    const { root, joystick } = mount();
    joystick.dispose();
    expect(root.querySelector(".hud-joystick")).toBeNull();
  });
});

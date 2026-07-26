import { HUD_CONTROL_ATTR } from "../inputGuards.js";
import { anchoredOffset, type FlightHudLayout } from "./flightHudLayout.js";
import { clamp, pitchFromStick, turnFromStick } from "./flightInput.js";

/**
 * Left-thumb flight stick (FLIGHT.md §4, two axes since BUBBLE.md §C). Same
 * shape as {@link import("./ModuleButtons.js").ModuleButtons}: it owns its DOM,
 * is tagged {@link HUD_CONTROL_ATTR} so the 5.4 edge palm-rejection never eats
 * it, takes all geometry from the resolved theme layout, and only writes to the
 * DOM when a value actually changed.
 *
 * The horizontal axis becomes the flight order's `turn` (sign derived in
 * `flightInput.turnFromStick`) and the vertical axis its `pitchStick` — push up
 * to climb, flipped by the player's invert preference
 * ({@link setInvertPitch}). Throttle stays the strip's job: it is held state,
 * and a spring axis cannot hold anything.
 *
 * The stick is a spring: releasing snaps it back to centre (turn 0, pitch 0),
 * which is exactly opposite to the throttle thumb's hold behaviour. Pitch itself
 * is still held state — the SIM keeps the nose where the stick left it
 * (BUBBLE.md), so a centred axis means "stop pitching", not "level out".
 */
export class VirtualJoystick {
  private readonly container: HTMLDivElement;
  private readonly base: HTMLDivElement;
  private readonly thumb: HTMLDivElement;
  private layout: FlightHudLayout;

  /** Active pointer id, or null when the stick is released. */
  private pointerId: number | null = null;
  /** Stick deflection in fractions of the base radius, screen axes (+x = right). */
  private stickX = 0;
  private stickY = 0;
  private lastThumbX = Number.NaN;
  private lastThumbY = Number.NaN;
  private lastActive = false;
  /** Player preference (`sa.controls.invertPitch`), pushed in by the HUD. */
  private invertPitch = false;

  private readonly onPointerDown = (ev: PointerEvent): void => {
    if (this.pointerId !== null) return;
    this.pointerId = ev.pointerId;
    this.base.setPointerCapture?.(ev.pointerId);
    this.trackTo(ev.clientX, ev.clientY);
    ev.preventDefault();
  };

  private readonly onPointerMove = (ev: PointerEvent): void => {
    if (ev.pointerId !== this.pointerId) return;
    this.trackTo(ev.clientX, ev.clientY);
    ev.preventDefault();
  };

  private readonly onPointerUp = (ev: PointerEvent): void => {
    if (ev.pointerId !== this.pointerId) return;
    this.pointerId = null;
    this.base.releasePointerCapture?.(ev.pointerId);
    // Spring return: a released stick is dead centre, never a held turn.
    this.stickX = 0;
    this.stickY = 0;
    this.render();
  };

  constructor(root: HTMLElement, layout: FlightHudLayout) {
    this.layout = layout;

    this.container = document.createElement("div");
    this.container.className = "hud-joystick";

    this.base = document.createElement("div");
    this.base.className = "hud-joystick-base";
    this.base.setAttribute(HUD_CONTROL_ATTR, "joystick");
    this.base.setAttribute("aria-label", "Steering");

    this.thumb = document.createElement("div");
    this.thumb.className = "hud-joystick-thumb";
    this.base.appendChild(this.thumb);
    this.container.appendChild(this.base);
    root.appendChild(this.container);

    this.base.addEventListener("pointerdown", this.onPointerDown);
    this.base.addEventListener("pointermove", this.onPointerMove);
    this.base.addEventListener("pointerup", this.onPointerUp);
    this.base.addEventListener("pointercancel", this.onPointerUp);
    this.base.addEventListener("lostpointercapture", this.onPointerUp);

    this.applyLayout(layout);
  }

  /** Adopt a freshly resolved layout (theme hot-reload, rotation, resize). */
  applyLayout(layout: FlightHudLayout): void {
    this.layout = layout;
    const j = layout.joystick;
    this.container.classList.toggle("disabled", !j.enabled);
    this.container.dataset["anchor"] = j.anchor;
    const { dx, dy } = anchoredOffset(j.anchor, j.offsetXPx, j.offsetYPx, j.baseRadiusPx);
    this.base.style.left = `${dx - j.baseRadiusPx}px`;
    this.base.style.top = `${dy - j.baseRadiusPx}px`;
    this.render();
  }

  /**
   * Sim `turn` for the current deflection (-1..1), deadzone + expo applied.
   * Positive INCREASES heading; see `flightInput.turnFromStick` for why that is
   * the opposite of the screen direction the thumb was pushed.
   */
  get turn(): number {
    return turnFromStick(this.stickX, this.layout.joystick.deadzone, this.layout.joystick.expo);
  }

  /**
   * Sim `pitchStick` for the current deflection (-1..1, positive noses up).
   * Push up = climb unless the player inverted the axis; see
   * `flightInput.pitchFromStick`.
   */
  get pitch(): number {
    return pitchFromStick(
      this.stickY,
      this.layout.joystick.deadzone,
      this.layout.joystick.expo,
      this.invertPitch,
    );
  }

  /**
   * Adopt the player's pitch-invert preference (5.8 settings). A preference, not
   * content: the theme never decides which way a thumb reads.
   */
  setInvertPitch(invert: boolean): void {
    this.invertPitch = invert;
  }

  /** True while a thumb/mouse is on the stick. */
  get active(): boolean {
    return this.pointerId !== null;
  }

  /** Raw horizontal deflection (-1..1, +1 = screen right) — debug/tests. */
  get deflectionX(): number {
    return this.stickX;
  }

  /** Raw vertical deflection (-1..1, +1 = screen DOWN) — debug/tests. */
  get deflectionY(): number {
    return this.stickY;
  }

  /** Screen-space pointer position → clamped stick deflection. */
  private trackTo(clientX: number, clientY: number): void {
    const rect = this.base.getBoundingClientRect();
    const radius = (rect.width || this.layout.joystick.baseRadiusPx * 2) / 2;
    if (radius <= 0) return;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let dx = (clientX - cx) / radius;
    let dy = (clientY - cy) / radius;
    // Clamp to the unit disc, not the square: a diagonal drag must not read as a
    // harder turn than a straight sideways one.
    const mag = Math.hypot(dx, dy);
    if (mag > 1) {
      dx /= mag;
      dy /= mag;
    }
    this.stickX = clamp(dx, -1, 1);
    this.stickY = clamp(dy, -1, 1);
    this.render();
  }

  /** Thumb position + active class, written only on change. */
  private render(): void {
    const travel = Math.max(0, this.layout.joystick.baseRadiusPx - this.layout.joystick.thumbRadiusPx);
    const x = Math.round(this.stickX * travel);
    const y = Math.round(this.stickY * travel);
    if (x !== this.lastThumbX || y !== this.lastThumbY) {
      this.lastThumbX = x;
      this.lastThumbY = y;
      this.thumb.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`;
    }
    const active = this.pointerId !== null;
    if (active !== this.lastActive) {
      this.lastActive = active;
      this.base.classList.toggle("active", active);
    }
  }

  dispose(): void {
    this.base.removeEventListener("pointerdown", this.onPointerDown);
    this.base.removeEventListener("pointermove", this.onPointerMove);
    this.base.removeEventListener("pointerup", this.onPointerUp);
    this.base.removeEventListener("pointercancel", this.onPointerUp);
    this.base.removeEventListener("lostpointercapture", this.onPointerUp);
    this.container.remove();
  }
}

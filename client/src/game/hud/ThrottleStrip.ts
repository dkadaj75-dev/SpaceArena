import { HUD_CONTROL_ATTR } from "../inputGuards.js";
import { anchoredBoxOffset, type FlightHudLayout } from "./flightHudLayout.js";
import { clamp, throttleFromPointer, throttleFromWheel, thumbTopPx } from "./flightInput.js";

/**
 * Right-edge vertical throttle lever (FLIGHT.md §4). Same shape as
 * {@link import("./ModuleButtons.js").ModuleButtons}: owns its DOM, tagged
 * {@link HUD_CONTROL_ATTR} so edge palm-rejection never eats it, geometry
 * entirely from the resolved theme layout, DOM writes only on change.
 *
 * The opposite contract to the joystick: this is a LEVER, not a spring. The
 * thumb stays exactly where it was released, so a player can set cruise and go
 * back to steering with the same hand — which is the whole reason throttle is a
 * separate widget instead of the stick's vertical axis.
 *
 * Drag maps the pointer's y over the full track (see
 * {@link import("./flightInput.js").throttleFromPointer}): the thumb centre
 * follows the finger except within half a thumb of either end, where it clamps
 * — so 0 % and 100 % are always reachable by dragging past the end.
 *
 * A mouse WHEEL over the track nudges the lever by `wheelStepPerNotch`
 * The desktop W/S keys ramp the same held value, and a wheel is
 * the pointer-hand equivalent for a player who never grabs the lever. The drag
 * is unchanged, and a wheel arriving mid-drag is ignored for the same reason the
 * keys are — whatever the player is holding wins.
 */
export class ThrottleStrip {
  private readonly container: HTMLDivElement;
  private readonly track: HTMLDivElement;
  private readonly fill: HTMLDivElement;
  private readonly thumb: HTMLDivElement;
  private readonly readout: HTMLDivElement;
  private layout: FlightHudLayout;

  /** Commanded throttle 0..1 — the value the flight order carries. */
  private value = 0;
  /** Active drag pointer, or null when nobody is holding the lever. */
  private pointerId: number | null = null;
  private lastThumbTop = Number.NaN;
  private lastPercent = Number.NaN;

  private readonly onPointerDown = (ev: PointerEvent): void => {
    if (this.pointerId !== null) return;
    this.pointerId = ev.pointerId;
    this.track.setPointerCapture?.(ev.pointerId);
    this.track.classList.add("active");
    this.trackTo(ev.clientY);
    ev.preventDefault();
  };

  private readonly onPointerMove = (ev: PointerEvent): void => {
    if (ev.pointerId !== this.pointerId) return;
    this.trackTo(ev.clientY);
    ev.preventDefault();
  };

  private readonly onPointerUp = (ev: PointerEvent): void => {
    if (ev.pointerId !== this.pointerId) return;
    this.pointerId = null;
    this.track.releasePointerCapture?.(ev.pointerId);
    this.track.classList.remove("active");
    // Deliberately no reset: the lever holds its last position.
  };

  private readonly onWheel = (ev: WheelEvent): void => {
    if (this.pointerId !== null) return;
    const next = throttleFromWheel(this.value, ev.deltaY, this.layout.throttle.wheelStepPerNotch);
    // Consumed either way: a wheel over a flight control must never scroll the
    // page, even at the ends of the lever's travel.
    ev.preventDefault();
    if (next === this.value) return;
    this.value = next;
    this.render();
  };

  constructor(root: HTMLElement, layout: FlightHudLayout) {
    this.layout = layout;

    this.container = document.createElement("div");
    this.container.className = "hud-throttle";

    this.track = document.createElement("div");
    this.track.className = "hud-throttle-track";
    this.track.setAttribute(HUD_CONTROL_ATTR, "throttle");
    this.track.setAttribute("aria-label", "Throttle");

    this.fill = document.createElement("div");
    this.fill.className = "hud-throttle-fill";
    this.thumb = document.createElement("div");
    this.thumb.className = "hud-throttle-thumb";
    this.readout = document.createElement("div");
    this.readout.className = "hud-throttle-readout";

    this.track.appendChild(this.fill);
    this.track.appendChild(this.thumb);
    this.container.appendChild(this.track);
    this.container.appendChild(this.readout);
    root.appendChild(this.container);

    this.track.addEventListener("pointerdown", this.onPointerDown);
    this.track.addEventListener("pointermove", this.onPointerMove);
    this.track.addEventListener("pointerup", this.onPointerUp);
    this.track.addEventListener("pointercancel", this.onPointerUp);
    this.track.addEventListener("lostpointercapture", this.onPointerUp);
    // Not passive: the handler calls preventDefault() so the page never scrolls
    // under a wheel aimed at the lever.
    this.track.addEventListener("wheel", this.onWheel, { passive: false });

    this.applyLayout(layout);
  }

  /** Adopt a freshly resolved layout (theme hot-reload, rotation, resize). */
  applyLayout(layout: FlightHudLayout): void {
    this.layout = layout;
    const t = layout.throttle;
    this.container.dataset["anchor"] = t.anchor;
    const { dx, dy } = anchoredBoxOffset(t.anchor, t.offsetXPx, t.offsetYPx, t.widthPx / 2, t.heightPx / 2);
    this.track.style.left = `${dx - t.widthPx / 2}px`;
    this.track.style.top = `${dy - t.heightPx / 2}px`;
    // Readout sits just above the track, centred on it.
    this.readout.style.left = `${dx}px`;
    this.readout.style.top = `${dy - t.heightPx / 2}px`;
    // Force a re-render: the thumb's pixel travel changed with the track height.
    this.lastThumbTop = Number.NaN;
    this.render();
  }

  /** Commanded throttle 0..1. */
  get throttle(): number {
    return this.value;
  }

  /** True while a thumb/mouse is dragging the lever (keys must not fight it). */
  get active(): boolean {
    return this.pointerId !== null;
  }

  /**
   * Set the lever from outside the widget — the desktop W/S ramp and the
   * per-match reset. Ignored mid-drag so a stuck key cannot fight the thumb.
   */
  setThrottle(value: number): void {
    if (this.pointerId !== null) return;
    const next = clamp(value, 0, 1);
    if (next === this.value) return;
    this.value = next;
    this.render();
  }

  /** Pointer y → lever value, clamped to the track. */
  private trackTo(clientY: number): void {
    const rect = this.track.getBoundingClientRect();
    const height = rect.height || this.layout.throttle.heightPx;
    if (height <= 0) return;
    const next = throttleFromPointer(clientY, rect.top, height);
    if (next === this.value) return;
    this.value = next;
    this.render();
  }

  /** Thumb offset, fill height and the % readout, each written only on change. */
  private render(): void {
    const t = this.layout.throttle;
    const top = Math.round(thumbTopPx(this.value, t.heightPx, t.thumbHeightPx));
    if (top !== this.lastThumbTop) {
      this.lastThumbTop = top;
      this.thumb.style.top = `${top}px`;
      this.fill.style.height = `${Math.round(this.value * 1000) / 10}%`;
    }
    const percent = Math.round(this.value * 100);
    if (percent !== this.lastPercent) {
      this.lastPercent = percent;
      this.readout.textContent = `${percent}%`;
    }
  }

  dispose(): void {
    this.track.removeEventListener("pointerdown", this.onPointerDown);
    this.track.removeEventListener("pointermove", this.onPointerMove);
    this.track.removeEventListener("pointerup", this.onPointerUp);
    this.track.removeEventListener("pointercancel", this.onPointerUp);
    this.track.removeEventListener("lostpointercapture", this.onPointerUp);
    this.track.removeEventListener("wheel", this.onWheel);
    this.container.remove();
  }
}

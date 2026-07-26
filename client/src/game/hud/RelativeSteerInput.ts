import { HUD_CONTROL_ATTR } from "../inputGuards.js";
import type { FlightHudLayout } from "./flightHudLayout.js";
import { mapRelativeSteer, type RelativeSteerAxes } from "./flightInput.js";

/** Shared producer for desktop RMB deltas and free-area floating touch drags. */
export class RelativeSteerInput {
  private readonly visual: HTMLDivElement;
  private readonly originDot: HTMLDivElement;
  private readonly vector: HTMLDivElement;
  private readonly currentDot: HTMLDivElement;
  private layout: FlightHudLayout;
  private pointerId: number | null = null;
  private pointerType = "";
  private originX = 0;
  private originY = 0;
  private lastX = 0;
  private lastY = 0;
  private dx = 0;
  private dy = 0;
  private enabled = true;
  private invertPitch = false;
  private readonly axesValue: RelativeSteerAxes = { turn: 0, pitchStick: 0 };

  private readonly onPointerDown = (ev: PointerEvent): void => {
    if (!this.enabled || this.pointerId !== null) return;
    if (ev.pointerType === "mouse") {
      if (ev.button !== 2 || ev.currentTarget !== this.surface) return;
    } else if (ev.pointerType === "touch") {
      if (startsOnHudControl(ev.target)) return;
    } else {
      return;
    }
    this.pointerId = ev.pointerId;
    this.pointerType = ev.pointerType;
    this.originX = this.lastX = ev.clientX;
    this.originY = this.lastY = ev.clientY;
    this.dx = 0;
    this.dy = 0;
    (ev.target as Element | null)?.setPointerCapture?.(ev.pointerId);
    this.render();
    ev.preventDefault();
  };

  private readonly onPointerMove = (ev: PointerEvent): void => {
    if (ev.pointerId !== this.pointerId) return;
    if (this.pointerType === "mouse") {
      const movementX = ev.movementX || ev.clientX - this.lastX;
      const movementY = ev.movementY || ev.clientY - this.lastY;
      const radius = this.layout.relativeSteer.maxRadiusPx;
      this.dx += movementX * this.layout.relativeSteer.mouseSensitivity * radius;
      this.dy += movementY * this.layout.relativeSteer.mouseSensitivity * radius;
      const magnitude = Math.hypot(this.dx, this.dy);
      if (magnitude > radius) {
        this.dx = (this.dx / magnitude) * radius;
        this.dy = (this.dy / magnitude) * radius;
      }
    } else {
      this.dx = ev.clientX - this.originX;
      this.dy = ev.clientY - this.originY;
    }
    this.lastX = ev.clientX;
    this.lastY = ev.clientY;
    this.updateAxes();
    this.render();
    ev.preventDefault();
  };

  private readonly onPointerUp = (ev: PointerEvent): void => {
    if (ev.pointerId === this.pointerId) this.release();
  };

  private readonly onBlur = (): void => this.release();

  constructor(
    root: HTMLElement,
    private readonly surface: HTMLElement,
    layout: FlightHudLayout,
  ) {
    this.layout = layout;
    this.visual = document.createElement("div");
    this.visual.className = "hud-relative-steer";
    this.originDot = document.createElement("div");
    this.originDot.className = "hud-relative-steer-origin";
    this.vector = document.createElement("div");
    this.vector.className = "hud-relative-steer-vector";
    this.currentDot = document.createElement("div");
    this.currentDot.className = "hud-relative-steer-current";
    this.visual.append(this.vector, this.originDot, this.currentDot);
    root.appendChild(this.visual);

    surface.addEventListener("pointerdown", this.onPointerDown);
    document.addEventListener("pointerdown", this.onPointerDown);
    document.addEventListener("pointermove", this.onPointerMove);
    document.addEventListener("pointerup", this.onPointerUp);
    document.addEventListener("pointercancel", this.onPointerUp);
    window.addEventListener("blur", this.onBlur);
  }

  applyLayout(layout: FlightHudLayout): void {
    this.layout = layout;
    this.updateAxes();
    this.render();
  }

  setInvertPitch(invert: boolean): void {
    this.invertPitch = invert;
    this.updateAxes();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.release();
  }

  get active(): boolean {
    return this.pointerId !== null;
  }

  get turn(): number {
    return this.axesValue.turn;
  }

  get pitchStick(): number {
    return this.axesValue.pitchStick;
  }

  private updateAxes(): void {
    const s = this.layout.relativeSteer;
    const axes = mapRelativeSteer(this.dx, this.dy, s.deadzonePx, s.maxRadiusPx, s.expo, this.invertPitch);
    this.axesValue.turn = axes.turn;
    this.axesValue.pitchStick = axes.pitchStick;
  }

  private release(): void {
    this.pointerId = null;
    this.pointerType = "";
    this.dx = 0;
    this.dy = 0;
    this.updateAxes();
    this.render();
  }

  private render(): void {
    const touchActive = this.pointerId !== null && this.pointerType === "touch";
    this.visual.classList.toggle("active", touchActive);
    if (!touchActive) return;
    const radius = this.layout.relativeSteer.maxRadiusPx;
    const magnitude = Math.hypot(this.dx, this.dy);
    const scale = magnitude > radius ? radius / magnitude : 1;
    const dx = this.dx * scale;
    const dy = this.dy * scale;
    this.originDot.style.transform = `translate(${this.originX}px, ${this.originY}px)`;
    this.currentDot.style.transform = `translate(${this.originX + dx}px, ${this.originY + dy}px)`;
    this.vector.style.width = `${Math.hypot(dx, dy)}px`;
    this.vector.style.transform = `translate(${this.originX}px, ${this.originY}px) rotate(${Math.atan2(dy, dx)}rad)`;
  }

  dispose(): void {
    this.surface.removeEventListener("pointerdown", this.onPointerDown);
    document.removeEventListener("pointerdown", this.onPointerDown);
    document.removeEventListener("pointermove", this.onPointerMove);
    document.removeEventListener("pointerup", this.onPointerUp);
    document.removeEventListener("pointercancel", this.onPointerUp);
    window.removeEventListener("blur", this.onBlur);
    this.visual.remove();
  }
}

export function startsOnHudControl(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(`[${HUD_CONTROL_ATTR}]`) !== null;
}

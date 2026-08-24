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
  private captureTarget: Element | null = null;
  private pointerLocked = false;
  private originX = 0;
  private originY = 0;
  private lastX = 0;
  private lastY = 0;
  private dx = 0;
  private dy = 0;
  private enabled = true;
  /** rAF handle of the desktop auto-center loop; null while no mouse drag is live. */
  private centerRaf: number | null = null;
  private centerLastTs = 0;
  private invertPitch = false;
  private mouseSensitivityMultiplier = 1;
  private touchSensitivityMultiplier = 1;
  private readonly axesValue: RelativeSteerAxes = { turn: 0, pitchStick: 0 };

  private readonly onPointerDown = (ev: PointerEvent): void => {
    if (!this.enabled || this.pointerId !== null) return;
    if (ev.pointerType === "mouse") {
      if (ev.button !== 2 || ev.currentTarget !== this.surface) return;
    } else if (ev.pointerType === "touch" || ev.pointerType === "pen") {
      if (!startsOnSteerSurface(ev.target, this.visual.parentElement, this.surface)) return;
    } else {
      return;
    }
    this.pointerId = ev.pointerId;
    this.pointerType = ev.pointerType;
    this.originX = this.lastX = ev.clientX;
    this.originY = this.lastY = ev.clientY;
    this.dx = 0;
    this.dy = 0;
    this.captureTarget = ev.target instanceof Element ? ev.target : null;
    this.captureTarget?.setPointerCapture?.(ev.pointerId);
    if (ev.pointerType === "mouse") {
      // Pointer lock removes the screen-edge cap. Browsers that do not expose
      // it (or deny the request) simply retain the existing client-coordinate
      // fallback below.
      try {
        const request = this.surface.requestPointerLock?.();
        void request?.catch?.(() => undefined);
      } catch {
        // Unsupported/denied synchronous implementations use the fallback.
      }
    }
    if (ev.pointerType === "mouse") this.startAutoCenter();
    this.render();
    ev.preventDefault();
  };

  /**
   * Desktop steering parity with touch: lifting a finger resets the stick, but
   * a mouse never lifts — so while a mouse drag is live, the accumulated
   * offset decays exponentially toward center. Moving the mouse out-pushes the
   * decay; a stationary mouse settles to neutral and steering stops.
   */
  private startAutoCenter(): void {
    if (this.centerRaf !== null) return;
    this.centerLastTs = performance.now();
    const tick = (ts: number): void => {
      this.centerRaf = null;
      if (this.pointerId === null || this.pointerType !== "mouse") return;
      const halfLife = this.layout.relativeSteer.mouseCenterHalfLifeMs;
      if (halfLife > 0 && (this.dx !== 0 || this.dy !== 0)) {
        const factor = Math.pow(0.5, (ts - this.centerLastTs) / halfLife);
        this.dx *= factor;
        this.dy *= factor;
        // Snap the sub-pixel tail so axes read exactly zero at rest.
        if (Math.hypot(this.dx, this.dy) < 0.5) { this.dx = 0; this.dy = 0; }
        this.updateAxes();
        this.render();
      }
      this.centerLastTs = ts;
      this.centerRaf = requestAnimationFrame(tick);
    };
    this.centerRaf = requestAnimationFrame(tick);
  }

  private stopAutoCenter(): void {
    if (this.centerRaf !== null) { cancelAnimationFrame(this.centerRaf); this.centerRaf = null; }
  }

  private readonly onPointerMove = (ev: PointerEvent): void => {
    if (ev.pointerId !== this.pointerId) return;
    if (this.pointerType === "mouse") {
      const locked = document.pointerLockElement === this.surface;
      const movementX = locked ? ev.movementX : ev.movementX || ev.clientX - this.lastX;
      const movementY = locked ? ev.movementY : ev.movementY || ev.clientY - this.lastY;
      const radius = this.layout.relativeSteer.maxRadiusPx;
      this.dx +=
        movementX *
        this.layout.relativeSteer.mouseSensitivity *
        this.mouseSensitivityMultiplier *
        radius;
      this.dy +=
        movementY *
        this.layout.relativeSteer.mouseSensitivity *
        this.mouseSensitivityMultiplier *
        radius;
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
    // Only when the UA will actually accept it: a touch-derived move the
    // compositor already owns is uncancelable, and asking anyway logs a console
    // error on every steering frame (playtest finding 13). The canvas carries
    // `touch-action: none`, which is what really stops the page moving.
    if (ev.cancelable) ev.preventDefault();
  };

  private readonly onPointerUp = (ev: PointerEvent): void => {
    if (ev.pointerId !== this.pointerId) return;
    // One physical mouse uses one pointerId for every button. Releasing LMB
    // while RMB remains held is a fire edge, not the end of steering.
    if (this.pointerType === "mouse" && ev.type === "pointerup" && ev.button !== 2) return;
    this.release();
  };

  private readonly onBlur = (): void => this.release();
  private readonly onPointerLockChange = (): void => {
    const lockedToSurface = document.pointerLockElement === this.surface;
    if (lockedToSurface) {
      if (this.pointerId !== null && this.pointerType === "mouse") {
        this.pointerLocked = true;
      } else {
        document.exitPointerLock?.();
      }
      return;
    }
    const lostActiveLock = this.pointerLocked && this.pointerId !== null && this.pointerType === "mouse";
    this.pointerLocked = false;
    if (lostActiveLock) this.release(false);
  };

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
    document.addEventListener("pointerlockchange", this.onPointerLockChange);
    window.addEventListener("blur", this.onBlur);
  }

  applyLayout(layout: FlightHudLayout): void {
    if (this.pointerId !== null && this.pointerType === "mouse") {
      const oldRadius = this.layout.relativeSteer.maxRadiusPx;
      const newRadius = layout.relativeSteer.maxRadiusPx;
      if (oldRadius > 0) {
        this.dx *= newRadius / oldRadius;
        this.dy *= newRadius / oldRadius;
      }
    }
    this.layout = layout;
    this.updateAxes();
    this.render();
  }

  setInvertPitch(invert: boolean): void {
    this.invertPitch = invert;
    this.updateAxes();
  }


  /** Apply player multipliers live, including an already-active drag. */
  setSensitivityMultipliers(mouse: number, touch: number): void {
    if (this.pointerId !== null && this.pointerType === "mouse" && this.mouseSensitivityMultiplier > 0) {
      const ratio = mouse / this.mouseSensitivityMultiplier;
      this.dx *= ratio;
      this.dy *= ratio;
    }
    this.mouseSensitivityMultiplier = mouse;
    this.touchSensitivityMultiplier = touch;
    this.updateAxes();
    this.render();
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
    const multiplier = this.pointerType === "mouse" ? 1 : this.touchSensitivityMultiplier;
    const axes = mapRelativeSteer(
      applySteerSensitivity(this.dx, multiplier),
      applySteerSensitivity(this.dy, multiplier),
      s.deadzonePx,
      s.maxRadiusPx,
      s.expo,
      this.invertPitch,
    );
    this.axesValue.turn = axes.turn;
    this.axesValue.pitchStick = axes.pitchStick;
  }

  private release(exitPointerLock = true): void {
    const pointerId = this.pointerId;
    if (pointerId !== null && this.captureTarget) {
      try {
        if (!this.captureTarget.hasPointerCapture || this.captureTarget.hasPointerCapture(pointerId)) {
          this.captureTarget.releasePointerCapture?.(pointerId);
        }
      } catch {
        // Capture may already have been released by the browser on cancel/blur.
      }
    }
    this.captureTarget = null;
    this.stopAutoCenter();
    if (exitPointerLock && document.pointerLockElement === this.surface) {
      document.exitPointerLock?.();
    }
    this.pointerLocked = false;
    this.pointerId = null;
    this.pointerType = "";
    this.dx = 0;
    this.dy = 0;
    this.updateAxes();
    this.render();
  }

  private render(): void {
    const touchActive = this.pointerId !== null && this.pointerType !== "mouse";
    this.visual.classList.toggle("active", touchActive);
    if (!touchActive) return;
    const radius = this.layout.relativeSteer.maxRadiusPx;
    const effectiveDx = applySteerSensitivity(this.dx, this.touchSensitivityMultiplier);
    const effectiveDy = applySteerSensitivity(this.dy, this.touchSensitivityMultiplier);
    const magnitude = Math.hypot(effectiveDx, effectiveDy);
    const scale = magnitude > radius ? radius / magnitude : 1;
    const dx = effectiveDx * scale;
    const dy = effectiveDy * scale;
    this.originDot.style.transform = `translate(${this.originX}px, ${this.originY}px)`;
    this.currentDot.style.transform = `translate(${this.originX + dx}px, ${this.originY + dy}px)`;
    this.vector.style.width = `${Math.hypot(dx, dy)}px`;
    this.vector.style.transform = `translate(${this.originX}px, ${this.originY}px) rotate(${Math.atan2(dy, dx)}rad)`;
  }

  dispose(): void {
    this.release();
    this.surface.removeEventListener("pointerdown", this.onPointerDown);
    document.removeEventListener("pointerdown", this.onPointerDown);
    document.removeEventListener("pointermove", this.onPointerMove);
    document.removeEventListener("pointerup", this.onPointerUp);
    document.removeEventListener("pointercancel", this.onPointerUp);
    document.removeEventListener("pointerlockchange", this.onPointerLockChange);
    window.removeEventListener("blur", this.onBlur);
    this.visual.remove();
  }
}

/** Pure mapping used by both touch axes and their live visual. */
export function applySteerSensitivity(deltaPx: number, multiplier: number): number {
  return deltaPx * multiplier;
}

export function startsOnHudControl(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(`[${HUD_CONTROL_ATTR}]`) !== null;
}

/** Touch/pen steering is allow-listed to the canvas or free space in this HUD. */
export function startsOnSteerSurface(
  target: EventTarget | null,
  hudRoot: Element | null,
  surface: Element,
): boolean {
  return (
    target instanceof Element &&
    (target === surface || hudRoot?.contains(target) === true) &&
    !startsOnHudControl(target)
  );
}

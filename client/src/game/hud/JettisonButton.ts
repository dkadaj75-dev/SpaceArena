import { HUD_CONTROL_ATTR } from "../inputGuards.js";
import { anchoredOffset, resolveFlightSecondaryControls, type FlightHudLayout } from "./flightHudLayout.js";
import { moduleIconSvg } from "./moduleIcons.js";

export const JETTISON_LABEL = "JETTISON";

export interface JettisonButtonState {
  /** A fitted countermeasure pod has authored a jettison block. */
  fitted: boolean;
  /** Seconds before the sim will accept another jettison. */
  cooldownSec: number;
  /** The authored cooldown, used to draw a truthful sweep. */
  cooldownTotalSec: number;
}

const ABSENT: JettisonButtonState = { fitted: false, cooldownSec: 0, cooldownTotalSec: 0 };

/** Dedicated action for a jettisonable fitted countermeasure pod. */
export class JettisonButton {
  private readonly container: HTMLDivElement;
  private readonly button: HTMLDivElement;
  private readonly ring: HTMLSpanElement;
  private state = ABSENT;
  private lastFitted: boolean | null = null;
  private lastCooldown: boolean | null = null;
  private lastRing = -1;
  private pointerId: number | null = null;

  private readonly onPointerDown = (ev: PointerEvent): void => {
    if (this.pointerId !== null) return;
    this.pointerId = ev.pointerId;
    this.button.setPointerCapture?.(ev.pointerId);
    this.button.classList.add("pressed");
    ev.preventDefault();
    if (this.state.fitted && this.state.cooldownSec <= 0) this.onJettison();
  };
  private readonly onPointerUp = (ev: PointerEvent): void => {
    if (ev.pointerId !== this.pointerId) return;
    this.pointerId = null;
    this.button.releasePointerCapture?.(ev.pointerId);
    this.button.classList.remove("pressed");
  };

  constructor(root: HTMLElement, layout: FlightHudLayout, private readonly onJettison: () => void) {
    this.container = document.createElement("div");
    this.container.className = "hud-jettison";
    this.container.hidden = true;
    this.button = document.createElement("div");
    this.button.className = "hud-jettison-btn";
    this.button.setAttribute(HUD_CONTROL_ATTR, "jettison");
    this.button.setAttribute("role", "button");
    this.button.setAttribute("aria-label", JETTISON_LABEL);
    this.ring = document.createElement("span");
    this.ring.className = "ring";
    this.ring.setAttribute("aria-hidden", "true");
    const icon = document.createElement("span");
    icon.className = "icon";
    icon.innerHTML = moduleIconSvg("countermeasure");
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = JETTISON_LABEL;
    this.button.append(this.ring, icon, label);
    this.container.append(this.button);
    root.appendChild(this.container);
    this.button.addEventListener("pointerdown", this.onPointerDown);
    this.button.addEventListener("pointerup", this.onPointerUp);
    this.button.addEventListener("pointercancel", this.onPointerUp);
    this.button.addEventListener("lostpointercapture", this.onPointerUp);
    this.applyLayout(layout);
  }

  applyLayout(layout: FlightHudLayout): void {
    this.applyArcLayout(layout, 0);
  }

  /** Reposition on the shared rail after the fitted module count is known. */
  applyArcLayout(layout: FlightHudLayout, moduleCount: number, primaryOnFireSlot = false): void {
    // `primaryOnFireSlot` has to be passed through: the pilot's first weapon
    // took the FIRE pedestal (2026-08-21), so one fewer module sits on the arc
    // and BOOST/JETTISON move one slot closer in with it.
    const secondary = resolveFlightSecondaryControls(layout, moduleCount, { primaryOnFireSlot });
    const action = secondary.jettison;
    this.container.dataset["anchor"] = action.anchor;
    const { dx, dy } = anchoredOffset(action.anchor, action.offsetXPx, action.offsetYPx, action.radiusPx);
    this.button.style.left = `${dx - action.radiusPx}px`;
    this.button.style.top = `${dy - action.radiusPx}px`;
    this.button.style.width = `${action.radiusPx * 2}px`;
    this.button.style.height = `${action.radiusPx * 2}px`;
    if (secondary.usesActionArc) {
      this.positionCaption(
        secondary.jettison.captionX,
        secondary.jettison.captionY,
        secondary.jettison.radiusPx,
        secondary.jettison.captionGapPx,
      );
    }
    else this.resetCaption();
  }

  private positionCaption(x: number, y: number, radius: number, gap: number): void {
    const label = this.button.querySelector<HTMLElement>(".label")!;
    label.style.left = `${50 + ((radius + gap) * x * 100) / (radius * 2)}%`;
    label.style.top = `${50 + ((radius + gap) * y * 100) / (radius * 2)}%`;
    label.style.transform = "translate(-50%, -50%)";
  }

  private resetCaption(): void {
    const label = this.button.querySelector<HTMLElement>(".label")!;
    label.style.removeProperty("left"); label.style.removeProperty("top"); label.style.removeProperty("transform");
  }

  update(state: JettisonButtonState): void {
    this.state = state;
    if (state.fitted !== this.lastFitted) {
      this.container.hidden = !state.fitted;
      this.lastFitted = state.fitted;
    }
    if (!state.fitted) return;
    const onCooldown = state.cooldownSec > 0;
    if (onCooldown !== this.lastCooldown) {
      this.button.classList.toggle("disabled", onCooldown);
      if (onCooldown) this.button.setAttribute("aria-disabled", "true");
      else this.button.removeAttribute("aria-disabled");
      this.lastCooldown = onCooldown;
    }
    const ring = onCooldown && state.cooldownTotalSec > 0 ? Math.round((100 * state.cooldownSec) / state.cooldownTotalSec) : 0;
    if (ring !== this.lastRing) {
      this.button.style.setProperty("--ring", String(Math.max(0, Math.min(100, ring))));
      this.lastRing = ring;
    }
  }

  clear(): void { this.pointerId = null; this.button.classList.remove("pressed"); this.update(ABSENT); }
  dispose(): void {
    this.button.removeEventListener("pointerdown", this.onPointerDown);
    this.button.removeEventListener("pointerup", this.onPointerUp);
    this.button.removeEventListener("pointercancel", this.onPointerUp);
    this.button.removeEventListener("lostpointercapture", this.onPointerUp);
    this.container.remove();
  }
}

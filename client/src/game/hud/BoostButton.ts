import { HUD_CONTROL_ATTR } from "../inputGuards.js";
import { anchoredOffset, resolveFlightSecondaryControls, type FlightHudLayout } from "./flightHudLayout.js";
import { moduleIconSvg } from "./moduleIcons.js";

/** Caption under the glyph. Fixed, not the module's `ui.shortName`: this control
 *  answers "where is my afterburner", so it says what it DOES, not what is fitted. */
export const BOOST_LABEL = "BOOST";

/** Tooltip / accessible reason shown while the sim would refuse the boost. */
export const BOOST_BLOCKED_TITLE = "No boost while carrying the flag";

/**
 * Everything the control renders, resolved by {@link import("./FlightControls.js").FlightControls}
 * from one snapshot. A plain value object so the widget itself never touches the
 * snapshot, the configs or the order path.
 */
export interface BoostButtonState {
  /**
   * Hardpoint of the fitted boost module, or null when this fitting has none —
   * in which case the control is not rendered at all.
   */
  hardpointIndex: number | null;
  /** The module's replicated `active` state: the ship is asking for boost. */
  active: boolean;
  /** Replicated module-local energy remaining. */
  energy: number;
  /** Replicated module-local energy capacity; zero means no ring. */
  energyCapacity: number;
  /**
   * True when the sim would refuse the boost no matter what the module says —
   * today that is exactly "this ship carries a CTF flag" (see
   * `resolveBoostMult` in shared/src/sim/systems/NavigationSystem.ts). Shown
   * DISABLED rather than hidden: a control that vanishes teaches nothing, and
   * the flag is picked up mid-flight.
   */
  blocked: boolean;
}

const ABSENT: BoostButtonState = {
  hardpointIndex: null,
  active: false,
  energy: 0,
  energyCapacity: 0,
  blocked: false,
};

/**
 * The flight HUD's dedicated BOOST control (FLIGHT.md §4).
 *
 * Boost is a fitted module, so before this widget existed it surfaced as one
 * more anonymous hex in the bottom-right module cluster: same silhouette as a
 * laser, captioned with whatever `ui.shortName` the content authored, and with
 * no hint that the ship it is bolted to cannot use it while carrying a flag. On
 * touch that made the afterburner effectively invisible — on desktop the Shift
 * key was the only discoverable path. The cluster no longer builds a button for
 * the boost family (see `ModuleButtons.isButtonable`); this is its control.
 *
 * It is a TOGGLE, not a momentary hold like {@link import("./FireButton.js").FireButton}:
 * one tap emits the same `moduleToggle` order the Shift key sends, and the
 * module's replicated state — not the pointer — decides what the button looks
 * like. That keeps the touch control and the keyboard shortcut honestly in sync
 * even when the sim shuts the module down on its own after energy depletion.
 *
 * Geometry comes entirely from `layout.boost`, derived from the FIRE control in
 * `flightHudLayout.ts`; nothing about its position lives in CSS. Every DOM write
 * is guarded by a cached last-rendered value, because `update` runs each frame.
 */
export class BoostButton {
  private readonly container: HTMLDivElement;
  private readonly button: HTMLDivElement;
  private readonly ring: HTMLSpanElement;

  private state: BoostButtonState = ABSENT;
  // Last-rendered values, so a frame that changes nothing writes nothing.
  private lastFitted: boolean | null = null;
  private lastActive: boolean | null = null;
  private lastBlocked: boolean | null = null;
  private lastEnergyPct = -1;
  private lastHasEnergyRing: boolean | null = null;
  private pointerId: number | null = null;

  private readonly onPointerDown = (ev: PointerEvent): void => {
    if (this.pointerId !== null) return;
    this.pointerId = ev.pointerId;
    this.button.setPointerCapture?.(ev.pointerId);
    // Pressed feedback is honest even when the tap is refused: the player
    // touched the control, and the greyed skin says why nothing happened.
    this.button.classList.add("pressed");
    ev.preventDefault();
    const hardpointIndex = this.state.hardpointIndex;
    if (hardpointIndex === null || this.state.blocked) return;
    this.onToggle(hardpointIndex);
  };

  private readonly onPointerUp = (ev: PointerEvent): void => {
    if (ev.pointerId !== this.pointerId) return;
    this.pointerId = null;
    this.button.releasePointerCapture?.(ev.pointerId);
    this.button.classList.remove("pressed");
  };

  /**
   * @param onToggle emits the `moduleToggle` order for the given hardpoint —
   *   the one order path the Shift shortcut already uses. The widget never
   *   reaches the session itself.
   */
  constructor(
    root: HTMLElement,
    layout: FlightHudLayout,
    private readonly onToggle: (hardpointIndex: number) => void,
  ) {
    this.container = document.createElement("div");
    this.container.className = "hud-boost";
    this.container.hidden = true;

    this.button = document.createElement("div");
    this.button.className = "hud-boost-btn hex-action";
    this.button.setAttribute(HUD_CONTROL_ATTR, "boost");
    this.button.setAttribute("role", "button");
    this.button.setAttribute("aria-label", BOOST_LABEL);
    this.button.setAttribute("aria-pressed", "false");

    this.ring = document.createElement("span");
    this.ring.className = "ring";
    this.ring.hidden = true;
    this.ring.setAttribute("aria-hidden", "true");

    const icon = document.createElement("span");
    icon.className = "icon";
    icon.innerHTML = moduleIconSvg("boost");
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = BOOST_LABEL;

    this.button.append(this.ring, icon, label);
    this.container.append(this.button);
    root.appendChild(this.container);

    this.button.addEventListener("pointerdown", this.onPointerDown);
    this.button.addEventListener("pointerup", this.onPointerUp);
    this.button.addEventListener("pointercancel", this.onPointerUp);
    this.button.addEventListener("lostpointercapture", this.onPointerUp);
    this.applyLayout(layout);
  }

  /** Adopt a freshly resolved layout (theme hot-reload, rotation, resize). */
  applyLayout(layout: FlightHudLayout): void {
    this.applyArcLayout(layout, 0);
  }

  /** Reposition on the shared rail after the fitted module count is known. */
  applyArcLayout(layout: FlightHudLayout, moduleCount: number): void {
    const secondary = resolveFlightSecondaryControls(layout, moduleCount);
    const boost = secondary.boost;
    this.container.dataset["anchor"] = boost.anchor;
    const { dx, dy } = anchoredOffset(boost.anchor, boost.offsetXPx, boost.offsetYPx, boost.radiusPx);
    this.button.style.left = `${dx - boost.radiusPx}px`;
    this.button.style.top = `${dy - boost.radiusPx}px`;
    this.button.style.width = `${boost.radiusPx * 2}px`;
    this.button.style.height = `${boost.radiusPx * 2}px`;
    if (secondary.usesActionArc) {
      this.positionCaption(
        secondary.boost.captionX,
        secondary.boost.captionY,
        secondary.boost.radiusPx,
        secondary.boost.captionGapPx,
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

  /** One frame of replicated state. Cheap when nothing moved. */
  update(state: BoostButtonState): void {
    this.state = state;
    const fitted = state.hardpointIndex !== null;
    if (fitted !== this.lastFitted) {
      this.container.hidden = !fitted;
      this.lastFitted = fitted;
      // Losing the fitting also drops the SKIN. A hidden control that keeps its
      // last classes comes back lit on the next spawn, which is
      // how a HUD ends up lying about a module the player has just refitted.
      if (!fitted) this.resetSkin();
    }
    if (!fitted) return;

    if (state.active !== this.lastActive) {
      this.button.classList.toggle("active", state.active);
      this.button.setAttribute("aria-pressed", state.active ? "true" : "false");
      this.lastActive = state.active;
    }
    if (state.blocked !== this.lastBlocked) {
      this.button.classList.toggle("disabled", state.blocked);
      if (state.blocked) {
        this.button.setAttribute("aria-disabled", "true");
        this.button.setAttribute("title", BOOST_BLOCKED_TITLE);
      } else {
        this.button.removeAttribute("aria-disabled");
        this.button.removeAttribute("title");
      }
      this.lastBlocked = state.blocked;
    }
    const hasEnergyRing = state.energyCapacity > 0;
    if (hasEnergyRing !== this.lastHasEnergyRing) {
      this.ring.hidden = !hasEnergyRing;
      this.button.classList.toggle("ring-energy", hasEnergyRing);
      this.lastHasEnergyRing = hasEnergyRing;
    }
    // Rounded before the comparison: energy drifts continuously, and a raw float
    // would rewrite the custom property on every single frame.
    const energyPct = hasEnergyRing
      ? Math.max(0, Math.min(100, Math.round((100 * state.energy) / state.energyCapacity)))
      : 0;
    if (energyPct !== this.lastEnergyPct) {
      this.button.style.setProperty("--ring", String(energyPct));
      this.lastEnergyPct = energyPct;
    }
  }

  /** Forget the fitting (death, match end) so the control cannot be tapped. */
  clear(): void {
    this.pointerId = null;
    this.button.classList.remove("pressed");
    this.update(ABSENT);
  }

  /** Drop every state class and its cached flag, back to "fitted but idle". */
  private resetSkin(): void {
    this.button.classList.remove("active", "disabled", "pressed", "ring-energy");
    this.ring.hidden = true;
    this.button.setAttribute("aria-pressed", "false");
    this.button.removeAttribute("aria-disabled");
    this.button.removeAttribute("title");
    this.lastActive = false;
    this.lastBlocked = false;
    this.lastEnergyPct = 0;
    this.lastHasEnergyRing = false;
  }

  dispose(): void {
    this.button.removeEventListener("pointerdown", this.onPointerDown);
    this.button.removeEventListener("pointerup", this.onPointerUp);
    this.button.removeEventListener("pointercancel", this.onPointerUp);
    this.button.removeEventListener("lostpointercapture", this.onPointerUp);
    this.container.remove();
  }
}

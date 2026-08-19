import type { ShipSnapshot } from "@space-arena/shared";
import { anchoredBoxOffset, type FlightHudLayout } from "./flightHudLayout.js";

const UPDATE_INTERVAL_MS = 100;

/** Clamp and round a world-space distance for compact HUD presentation. */
export function roundedHudMeters(distanceM: number): number {
  return Number.isFinite(distanceM) ? Math.max(0, Math.round(distanceM)) : 0;
}

/** Shared distance label format for arrows and the target bracket. */
export function formatHudDistance(distanceM: number): string {
  return `${roundedHudMeters(distanceM)}m`;
}

/**
 * Authoritative 3D speed of one ship, in world units per second.
 *
 * Reads the snapshot's REPLICATED velocity — the sim's own value, not an
 * estimate. `0` for a ship whose sample carries none (a pre-velocity server, a
 * genuinely stationary hull), which is the same number the differencing this
 * replaced produced for a hull that was not moving.
 */
export function snapshotSpeedMps(ship: ShipSnapshot): number {
  const v = ship.velocity;
  if (!v) return 0;
  const speed = Math.hypot(v.x, v.y, v.z);
  return Number.isFinite(speed) ? speed : 0;
}

/**
 * Small actual-speed instrument associated with the themed throttle strip.
 *
 * ## Why this reads velocity instead of measuring displacement
 *
 * It used to DIFFERENTIATE the own ship's rendered position over a 100 ms
 * window, dividing by the snapshot playback clock's `elapsed`. Two different
 * clocks: online, the numerator is the PREDICTED hull (client-side, advancing in
 * fixed 30 Hz steps, and pulled around every frame by the prediction-correction
 * offset) while the denominator is the interpolated server match clock. The
 * window averaging hid the fixed-step quantization, but nothing could hide the
 * correction term — every reconciliation nudge added or removed real distance
 * from the numerator, so the readout visibly wandered whenever the pilot was
 * steering, which is the bug that was reported. Worse, the two clocks disagree
 * by construction: the corrections exist precisely because the predicted path
 * and the authoritative path are not the same path.
 *
 * The ship's velocity is now on the wire, so there is nothing left to measure.
 * `|v|` off the authoritative snapshot is exact, needs no window, cannot be
 * perturbed by prediction, and is the same number the server would print. The
 * 10 Hz display cadence stays — it is a legibility choice (a digit changing 60
 * times a second is unreadable), not a measurement one.
 */
export class SpeedReadout {
  private readonly container: HTMLDivElement;
  private readonly value: HTMLSpanElement;
  private lastUpdateMs = Number.NEGATIVE_INFINITY;
  private lastSpeedMps = Number.NaN;
  /** Display-only unit→metre factor (theme.hud.metersPerUnit). */
  private metersPerUnit = 1;

  constructor(root: HTMLElement, layout: FlightHudLayout) {
    this.container = document.createElement("div");
    this.container.className = "hud-speed";
    const style = document.createElement("style");
    style.textContent = `
      .hud-speed {
        position: absolute;
        width: 0;
        height: 0;
        pointer-events: none;
      }
      .hud-speed[data-anchor="bottom-right"] { right: var(--hud-inset-right); bottom: var(--hud-inset-bottom); }
      .hud-speed[data-anchor="bottom-left"] { left: var(--hud-inset-left); bottom: var(--hud-inset-bottom); }
      .hud-speed[data-anchor="top-right"] { right: var(--hud-inset-right); top: var(--hud-inset-top); }
      .hud-speed[data-anchor="top-left"] { left: var(--hud-inset-left); top: var(--hud-inset-top); }
      .hud-speed-value {
        position: absolute;
        transform: translate(-50%, -50%);
        padding: 2px 7px;
        color: var(--hud-primary, var(--sa-blue-500));
        background: color-mix(in srgb, var(--hud-bg, var(--sa-n-900)) 66%, transparent);
        clip-path: polygon(5px 0%, 100% 0%, 100% calc(100% - 5px), calc(100% - 5px) 100%, 0% 100%, 0% 5px);
        font-size: 0.625em;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
        letter-spacing: 0.08em;
        white-space: nowrap;
      }
    `;
    this.value = document.createElement("span");
    this.value.className = "hud-speed-value";
    this.value.textContent = "0 m/s";
    this.container.append(style, this.value);
    root.appendChild(this.container);
    this.applyLayout(layout);
  }

  /** Follow the throttle's resolved anchor and geometry in either orientation. */
  applyLayout(layout: FlightHudLayout): void {
    this.metersPerUnit = layout.metersPerUnit;
    const t = layout.throttle;
    this.container.dataset["anchor"] = t.anchor;
    const { dx, dy } = anchoredBoxOffset(
      t.anchor,
      t.offsetXPx,
      t.offsetYPx,
      t.widthPx / 2,
      t.heightPx / 2,
    );
    const towardAnchor = t.anchor.startsWith("bottom") ? 1 : -1;
    this.value.style.left = `${dx}px`;
    this.value.style.top = `${dy + towardAnchor * (t.heightPx / 2 + 10 * layout.scale)}px`;
  }

  /**
   * Show the own ship's authoritative speed, rewritten at most at 10 Hz.
   *
   * `nowMs` is the render-loop clock and paces the DISPLAY only. There is no
   * measurement window any more and therefore no second clock to disagree with:
   * every call reads the current snapshot's own velocity, and the 10 Hz gate
   * decides whether that reading is worth repainting. A starved buffer replays
   * the last snapshot, so the readout holds its value through it for free —
   * where the old windowed measure had to special-case a zero-length window to
   * avoid printing 0.
   *
   * `elapsedSec` is retained in the signature (unused) so the HUD call site and
   * every test keep working across this change; the whole point is that the
   * match clock is no longer part of the measurement.
   */
  update(cur: ShipSnapshot, _elapsedSec: number, nowMs: number): void {
    if (nowMs - this.lastUpdateMs < UPDATE_INTERVAL_MS) return;
    this.lastUpdateMs = nowMs;
    const speedMps = Math.max(0, Math.round(snapshotSpeedMps(cur) * this.metersPerUnit));
    if (speedMps === this.lastSpeedMps) return;
    this.lastSpeedMps = speedMps;
    this.value.textContent = `${speedMps} m/s`;
  }

  dispose(): void {
    this.container.remove();
  }
}

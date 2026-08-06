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

/** Authoritative 3D speed implied by two simulation snapshots. */
export function snapshotSpeedMps(
  cur: ShipSnapshot,
  prev: ShipSnapshot,
  elapsedDeltaSec: number,
): number {
  if (!(elapsedDeltaSec > 0) || !Number.isFinite(elapsedDeltaSec)) return 0;
  return (
    Math.hypot(cur.pos.x - prev.pos.x, cur.pos.y - prev.pos.y, cur.pos.z - prev.pos.z) /
    elapsedDeltaSec
  );
}

/**
 * Small actual-speed instrument associated with the themed throttle strip.
 * Snapshot position deltas are used because ShipSnapshot intentionally carries
 * no velocity. Text is sampled at 10 Hz and only written when the integer moves.
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
   * Sample actual speed at 10 Hz. `nowMs` is the render-loop clock; elapsed
   * values are simulation seconds and therefore independent of render FPS.
   */
  update(cur: ShipSnapshot, prev: ShipSnapshot, elapsedDeltaSec: number, nowMs: number): void {
    if (nowMs - this.lastUpdateMs < UPDATE_INTERVAL_MS) return;
    this.lastUpdateMs = nowMs;
    const speedMps = Math.max(0, Math.round(snapshotSpeedMps(cur, prev, elapsedDeltaSec) * this.metersPerUnit));
    if (speedMps === this.lastSpeedMps) return;
    this.lastSpeedMps = speedMps;
    this.value.textContent = `${speedMps} m/s`;
  }

  dispose(): void {
    this.container.remove();
  }
}

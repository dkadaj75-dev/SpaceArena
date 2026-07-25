import type { FlightHudLayout } from "./flightHudLayout.js";

/**
 * Lock visualization (FLIGHT.md §4). Two separate things share this component
 * because they describe one mechanic:
 *
 *  - the **zone circle**, fixed at screen centre, whose radius is the honest
 *    projection of the sim's heading-relative lock cone under the live chase
 *    camera (computed by
 *    {@link import("./flightHudLayout.js").reticleRadiusPx} and pushed in via
 *    {@link setZone}) — an enemy drawn inside it is an enemy the sim considers
 *    inside `sensors.coneDeg`;
 *  - the **target bracket**, projected onto the ship the sim actually picked as
 *    the candidate, carrying `snapshot.lockProgress` as a ring and flipping to a
 *    distinct locked state when weapons come live.
 *
 * Purely presentational: it never decides what is locked. The sim owns that and
 * the snapshot reports it, so the HUD can never disagree with what will fire.
 */
export class LockReticle {
  private readonly container: HTMLDivElement;
  private readonly zone: HTMLDivElement;
  private readonly bracket: HTMLDivElement;

  private lastRadius = Number.NaN;
  private lastClamped: boolean | null = null;
  private lastX = Number.NaN;
  private lastY = Number.NaN;
  private lastRing = Number.NaN;
  private lastLocked: boolean | null = null;
  private lastVisible: boolean | null = null;

  constructor(root: HTMLElement, layout: FlightHudLayout) {
    this.container = document.createElement("div");
    this.container.className = "hud-reticle";

    this.zone = document.createElement("div");
    this.zone.className = "hud-reticle-zone";

    this.bracket = document.createElement("div");
    this.bracket.className = "hud-reticle-bracket";
    this.bracket.style.setProperty("--ring", "0");

    this.container.appendChild(this.zone);
    this.container.appendChild(this.bracket);
    root.appendChild(this.container);

    this.applyLayout(layout);
  }

  /** Adopt a freshly resolved layout (theme hot-reload, rotation, resize). */
  applyLayout(layout: FlightHudLayout): void {
    const px = `${layout.reticle.bracketSizePx}px`;
    this.bracket.style.width = px;
    this.bracket.style.height = px;
  }

  /**
   * Push the projected cone radius (CSS px). `clamped` means the cone is wider
   * than the camera can show, so the circle is a floor on the real zone rather
   * than its edge — marked in the DOM so the ring is never read as "the zone
   * ends here".
   */
  setZone(radiusPx: number, clamped: boolean): void {
    const rounded = Math.round(radiusPx);
    if (rounded !== this.lastRadius) {
      this.lastRadius = rounded;
      this.zone.style.width = `${rounded * 2}px`;
      this.zone.style.height = `${rounded * 2}px`;
    }
    if (clamped !== this.lastClamped) {
      this.lastClamped = clamped;
      this.zone.classList.toggle("clamped", clamped);
    }
  }

  /**
   * Place the bracket for this frame. `x`/`y` are CSS px inside the HUD root;
   * pass `visible: false` when there is no candidate or it did not project (off
   * screen / behind the camera). `progress` is `snapshot.lockProgress` (0..1).
   */
  update(visible: boolean, x: number, y: number, progress: number, locked: boolean): void {
    if (visible !== this.lastVisible) {
      this.lastVisible = visible;
      this.bracket.classList.toggle("visible", visible);
    }
    if (!visible) return;

    const px = Math.round(x);
    const py = Math.round(y);
    if (px !== this.lastX || py !== this.lastY) {
      this.lastX = px;
      this.lastY = py;
      this.bracket.style.transform = `translate(${px}px, ${py}px) translate(-50%, -50%)`;
    }
    // Whole percent: the ring is a 100-step conic gradient, so finer values are
    // invisible and would only cost a style write per frame.
    const ring = Math.max(0, Math.min(100, Math.round(progress * 100)));
    if (ring !== this.lastRing) {
      this.lastRing = ring;
      this.bracket.style.setProperty("--ring", String(ring));
    }
    if (locked !== this.lastLocked) {
      this.lastLocked = locked;
      this.bracket.classList.toggle("locked", locked);
    }
  }

  dispose(): void {
    this.container.remove();
  }
}

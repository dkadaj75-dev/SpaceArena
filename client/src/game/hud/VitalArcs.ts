import type { ConfigService, EntityId, ModuleConfig, ShipSnapshot, Snapshot } from "@space-arena/shared";
import type { HudLayout } from "./hudLayout.js";

const SVG_NS = "http://www.w3.org/2000/svg";

interface ArcParts {
  /** Dark backing stroke drawn UNDER the track — see {@link VitalArcs.buildArc}. */
  halo: SVGPathElement;
  track: SVGPathElement;
  fill: SVGPathElement;
  value: HTMLSpanElement;
  lastPct: number;
}

/**
 * Subtle hull/shield arcs flanking the ship without obscuring combat.
 *
 * They began as facing semicircles. Since 2026-08-22 they are two SHORT arcs
 * (`vitalArcs.arcDeg`, ~a quarter circle each) held apart by `vitalArcs.gapPx`,
 * because a near-closed ring around the ship competed with the lock reticle
 * inside it and with the enemy arrows parked on their interior ring. Both
 * numbers are theme-authorable per orientation; nothing here is hardcoded.
 */
export class VitalArcs {
  private readonly container: HTMLDivElement;
  private readonly svg: SVGSVGElement;
  private readonly hull: ArcParts;
  private readonly shield: ArcParts;

  constructor(
    root: HTMLElement,
    private readonly configs: ConfigService,
    private readonly playerId: EntityId,
  ) {
    this.container = document.createElement("div");
    this.container.className = "hud-vital-arcs";
    this.container.setAttribute("aria-label", "Hull and shield status");

    this.svg = document.createElementNS(SVG_NS, "svg");
    this.svg.setAttribute("aria-hidden", "true");
    this.hull = this.buildArc("hull", "HULL");
    this.shield = this.buildArc("shield", "SHIELD");

    this.container.prepend(this.svg);
    root.appendChild(this.container);
  }

  private buildArc(kind: "hull" | "shield", labelText: string): ArcParts {
    // A dark backing stroke, slightly wider than the arc and drawn beneath it
    // (2026-08-21). The arcs sit over the arena, and over a lit nebula or a
    // muzzle flash a thin translucent line simply vanished — the owner's report
    // was that hull and shield were unreadable in a fight. The halo gives every
    // arc its own ground without making the arc itself louder, which is why it
    // is preferred here to cranking the stroke or the opacity.
    const halo = document.createElementNS(SVG_NS, "path");
    halo.classList.add("hud-vital-arc", "halo", kind);
    const track = document.createElementNS(SVG_NS, "path");
    track.classList.add("hud-vital-arc", "track", kind);
    const fill = document.createElementNS(SVG_NS, "path");
    fill.classList.add("hud-vital-arc", "fill", kind);
    fill.setAttribute("pathLength", "100");
    fill.style.strokeDasharray = "100 100";
    this.svg.append(halo, track, fill);

    const label = document.createElement("div");
    label.className = `hud-vital-label ${kind}`;
    const name = document.createElement("span");
    name.textContent = labelText;
    const value = document.createElement("span");
    value.className = "value";
    label.append(name, value);
    this.container.appendChild(label);

    return { halo, track, fill, value, lastPct: -1 };
  }

  applyLayout(layout: HudLayout): void {
    const arcs = layout.vitalArcs;
    this.container.hidden = !arcs.enabled;
    if (!arcs.enabled) return;

    const pad = Math.max(8, arcs.strokePx * 2);
    const height = (arcs.radiusPx + pad) * 2;
    // The box is WIDER than it is tall by exactly the gap: each arc is drawn on
    // its own centre, half a gap to either side of the box's middle, so the
    // left arc's outermost point still lands one `pad` inside the left edge (and
    // the right arc's inside the right edge) however far apart the two are
    // pushed. Height is untouched — the gap is a horizontal move only.
    const width = height + arcs.gapPx;
    const midX = width / 2;
    const midY = height / 2;
    this.container.style.width = `${width}px`;
    this.container.style.height = `${height}px`;
    this.container.style.marginTop = `${arcs.offsetYPx}px`;
    this.container.style.opacity = String(arcs.opacity);
    this.container.style.setProperty("--hud-vital-stroke", `${arcs.strokePx}px`);
    this.container.style.setProperty("--hud-vital-track-opacity", String(arcs.trackOpacity));
    this.svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

    // Both arcs are still centred on the horizontal axis and still drain the
    // same way (the fill starts at the arc's own start point and grows along the
    // path); only the sweep and the two centres changed.
    const halfArc = arcs.arcDeg / 2;
    const halfGap = arcs.gapPx / 2;
    const left = arcPath(midX - halfGap, midY, arcs.radiusPx, 180 - halfArc, 180 + halfArc, true);
    const right = arcPath(midX + halfGap, midY, arcs.radiusPx, halfArc, -halfArc, false);
    this.hull.halo.setAttribute("d", left);
    this.hull.track.setAttribute("d", left);
    this.hull.fill.setAttribute("d", left);
    this.shield.halo.setAttribute("d", right);
    this.shield.track.setAttribute("d", right);
    this.shield.fill.setAttribute("d", right);
  }

  update(cur: Snapshot): void {
    if (this.container.hidden) return;
    const ship = findShip(cur, this.playerId);
    if (!ship) return;

    const hull = ship.hullMax > 0 ? ship.hull / ship.hullMax : 0;
    this.set(this.hull, hull);
    this.container.classList.toggle("hull-critical", hull <= 0.3);

    let pool = 0;
    let capacity = 0;
    for (const fitted of ship.modules) {
      const cfg = this.configs.get<ModuleConfig>("module", fitted.moduleId);
      // A shield's reserve IS its energy tank since the 2026-08-07 overhaul, so
      // the arc reads the replicated per-module store rather than an authored
      // absorb rate.
      if (!cfg?.mitigation || fitted.energyCapacity <= 0) continue;
      pool += fitted.shieldPool;
      capacity += fitted.energyCapacity;
    }
    this.set(this.shield, capacity > 0 ? pool / capacity : 0);
  }

  private set(arc: ArcParts, fraction: number): void {
    const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
    if (pct === arc.lastPct) return;
    arc.lastPct = pct;
    arc.fill.style.strokeDasharray = `${pct} 100`;
    arc.value.textContent = `${pct}%`;
  }

  dispose(): void {
    this.container.remove();
  }
}

function polar(cx: number, cy: number, radius: number, degrees: number): { x: number; y: number } {
  const angle = (degrees * Math.PI) / 180;
  return { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius };
}

function arcPath(
  cx: number,
  cy: number,
  radius: number,
  startDeg: number,
  endDeg: number,
  clockwise: boolean,
): string {
  const start = polar(cx, cy, radius, startDeg);
  const end = polar(cx, cy, radius, endDeg);
  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 0 ${clockwise ? 1 : 0} ${end.x} ${end.y}`;
}

function findShip(snapshot: Snapshot, id: EntityId): ShipSnapshot | undefined {
  for (let i = 0; i < snapshot.ships.length; i++) {
    if (snapshot.ships[i]!.id === id) return snapshot.ships[i];
  }
  return undefined;
}

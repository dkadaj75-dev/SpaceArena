import type { ConfigService, EntityId, ModuleConfig, ShipSnapshot, Snapshot } from "@space-arena/shared";
import type { HudLayout } from "./hudLayout.js";

const SVG_NS = "http://www.w3.org/2000/svg";

interface ArcParts {
  track: SVGPathElement;
  fill: SVGPathElement;
  value: HTMLSpanElement;
  lastPct: number;
}

/** Subtle hull/shield semicircles flanking the ship without obscuring combat. */
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
    const track = document.createElementNS(SVG_NS, "path");
    track.classList.add("hud-vital-arc", "track", kind);
    const fill = document.createElementNS(SVG_NS, "path");
    fill.classList.add("hud-vital-arc", "fill", kind);
    fill.setAttribute("pathLength", "100");
    fill.style.strokeDasharray = "100 100";
    this.svg.append(track, fill);

    const label = document.createElement("div");
    label.className = `hud-vital-label ${kind}`;
    const name = document.createElement("span");
    name.textContent = labelText;
    const value = document.createElement("span");
    value.className = "value";
    label.append(name, value);
    this.container.appendChild(label);

    return { track, fill, value, lastPct: -1 };
  }

  applyLayout(layout: HudLayout): void {
    const arcs = layout.vitalArcs;
    this.container.hidden = !arcs.enabled;
    if (!arcs.enabled) return;

    const pad = Math.max(8, arcs.strokePx * 2);
    const size = (arcs.radiusPx + pad) * 2;
    const centre = size / 2;
    this.container.style.width = `${size}px`;
    this.container.style.height = `${size}px`;
    this.container.style.marginTop = `${arcs.offsetYPx}px`;
    this.container.style.opacity = String(arcs.opacity);
    this.container.style.setProperty("--hud-vital-stroke", `${arcs.strokePx}px`);
    this.container.style.setProperty("--hud-vital-track-opacity", String(arcs.trackOpacity));
    this.svg.setAttribute("viewBox", `0 0 ${size} ${size}`);

    const halfArc = arcs.arcDeg / 2;
    const left = arcPath(centre, centre, arcs.radiusPx, 180 - halfArc, 180 + halfArc, true);
    const right = arcPath(centre, centre, arcs.radiusPx, halfArc, -halfArc, false);
    this.hull.track.setAttribute("d", left);
    this.hull.fill.setAttribute("d", left);
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

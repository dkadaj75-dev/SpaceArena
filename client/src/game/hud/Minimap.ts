import type {
  ArenaConfig,
  ConfigEvents,
  ConfigService,
  EntityId,
  EventBus,
  ShipSnapshot,
  Snapshot,
  ThemeConfig,
} from "@space-arena/shared";
import { createLogger } from "@space-arena/shared";
import type { GameSession } from "../GameSession.js";
import type { HudLayout } from "./hudLayout.js";
import {
  projectRadarPoint,
  radarLocalPoint,
  type RadarLocalPoint,
  type RadarProjectedPoint,
  type RadarProjectionGeometry,
} from "./radarProjection.js";

const log = createLogger("HudRadar");
const REDRAW_INTERVAL_MS = 50; // 20 Hz: smooth stems, still independent of render FPS.

const localScratch: RadarLocalPoint = { right: 0, up: 0, forward: 0 };
const projectedScratch: RadarProjectedPoint = { x: 0, baseY: 0, tipY: 0, outOfRange: false };

function boundsRadius(arena: ArenaConfig | undefined): number | undefined {
  if (!arena) return undefined;
  const b = arena.bounds;
  return b.shape === "sphere" ? b.radius : Math.hypot(b.width, b.height) / 2;
}

/**
 * Player-centred 3D tactical radar. The tilted disc carries right/forward;
 * lollipop stems carry ship-relative elevation, including through full loops.
 */
export class Minimap {
  private readonly container: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly scaleEl: HTMLDivElement;
  private readonly ctx: CanvasRenderingContext2D;
  private palette = { friendly: "#39bfff", hostile: "#ff405c", neutral: "#7f9dc4" };
  private readonly arenaId: string;
  private arena: ArenaConfig | undefined;
  private authoredRangeUnits: number | undefined;
  private sizePx = 128;
  private rangeUnits = 100;
  private contactSizePx = 3.5;
  private gridOpacity = 0.22;
  private geometry: RadarProjectionGeometry = {
    centreX: 64,
    centreY: 68,
    radiusX: 54,
    radiusY: 27,
    rangeUnits: 100,
    elevationRad: Math.PI / 6,
    altitudeScale: 0.65,
    altitudeStemMaxPx: 20,
  };
  private accMs = REDRAW_INTERVAL_MS;

  constructor(
    root: HTMLElement,
    private readonly configs: ConfigService,
    private readonly bus: EventBus<ConfigEvents>,
    private readonly session: GameSession,
  ) {
    this.container = document.createElement("div");
    this.container.className = "hud-minimap hud-radar";
    root.appendChild(this.container);

    this.canvas = document.createElement("canvas");
    this.container.appendChild(this.canvas);
    this.scaleEl = document.createElement("div");
    this.scaleEl.className = "hud-minimap-scale";
    this.container.appendChild(this.scaleEl);

    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("Radar: 2D canvas context unavailable");
    this.ctx = ctx;

    this.arenaId = session.arenaId;
    this.arena = configs.get<ArenaConfig>("arena", this.arenaId);
    if (!this.arena) log.warn(`arena config not found: ${this.arenaId}`);
    this.readPalette(configs.get<ThemeConfig>("theme", "theme.default"));
    this.updateRange();
    this.resizeCanvas();

    this.bus.on("config:changed", (evt) => {
      if (evt.type === "theme") {
        this.readPalette(this.configs.get<ThemeConfig>("theme", "theme.default"));
      } else if (evt.type === "arena" && evt.id === this.arenaId) {
        this.arena = this.configs.get<ArenaConfig>("arena", this.arenaId);
        this.updateRange();
      }
    });
  }

  /** Adopt the orientation-aware, scaled theme layout. */
  applyLayout(layout: HudLayout): void {
    const radar = layout.radar;
    this.sizePx = radar.sizePx;
    this.authoredRangeUnits = radar.rangeUnits;
    this.contactSizePx = radar.contactSizePx;
    this.gridOpacity = radar.gridOpacity;
    const radiusX = this.sizePx * 0.43;
    this.geometry = {
      centreX: this.sizePx / 2,
      centreY: this.sizePx * 0.54,
      radiusX,
      radiusY: radiusX * Math.sin((radar.elevationDeg * Math.PI) / 180),
      rangeUnits: this.rangeUnits,
      elevationRad: (radar.elevationDeg * Math.PI) / 180,
      altitudeScale: radar.altitudeScale,
      altitudeStemMaxPx: radar.altitudeStemMaxPx,
    };
    this.updateRange();
    this.resizeCanvas();
    this.accMs = REDRAW_INTERVAL_MS;
  }

  private updateRange(): void {
    this.rangeUnits = this.authoredRangeUnits ?? boundsRadius(this.arena) ?? 100;
    this.geometry.rangeUnits = this.rangeUnits;
    this.scaleEl.textContent = `R ${Math.round(this.rangeUnits)}`;
  }

  private readPalette(theme: ThemeConfig | undefined): void {
    const colors = theme?.colors ?? {};
    const computed =
      typeof window !== "undefined" && typeof window.getComputedStyle === "function"
        ? window.getComputedStyle(this.container)
        : undefined;
    const pick = (prop: string, fallback: string): string => {
      const authored = colors[prop]?.trim();
      if (authored) return authored;
      const resolved = computed?.getPropertyValue(prop).trim();
      return resolved || fallback;
    };
    this.palette = {
      friendly: pick("--hud-primary", "#39bfff"),
      hostile: pick("--hud-danger", "#ff405c"),
      neutral: pick("--hud-neutral", "#7f9dc4"),
    };
  }

  private resizeCanvas(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(this.sizePx * dpr);
    this.canvas.height = Math.round(this.sizePx * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  update(cur: Snapshot, dtMs: number): void {
    this.accMs += dtMs;
    if (this.accMs < REDRAW_INTERVAL_MS) return;
    this.accMs = 0;
    this.draw(cur);
  }

  private draw(cur: Snapshot): void {
    const ctx = this.ctx;
    const g = this.geometry;
    ctx.clearRect(0, 0, this.sizePx, this.sizePx);
    this.drawDisc();

    const player = findShip(cur, this.session.playerId);
    if (!player) return;

    // Nearby asteroids stay quiet and never pin to the rim: the disc is a
    // tactical aid, not a second starfield.
    ctx.fillStyle = withAlpha(this.palette.neutral, 0.42);
    for (let i = 0; i < cur.asteroids.length; i++) {
      const asteroid = cur.asteroids[i]!;
      if (asteroid.state === "destroyed") continue;
      this.project(asteroid.pos.x, asteroid.pos.y, asteroid.pos.z, player);
      if (projectedScratch.outOfRange) continue;
      ctx.beginPath();
      ctx.arc(projectedScratch.x, projectedScratch.tipY, Math.max(0.8, Math.min(2.4, asteroid.radius * 0.08)), 0, Math.PI * 2);
      ctx.fill();
    }

    for (let i = 0; i < cur.ships.length; i++) {
      const ship = cur.ships[i]!;
      if (ship.id === player.id) continue;
      this.project(ship.pos.x, ship.pos.y, ship.pos.z, player);
      const color = ship.team === this.session.playerTeam ? this.palette.friendly : this.palette.hostile;
      const alpha = projectedScratch.outOfRange ? 0.34 : 0.82;

      // Lollipop: foot on the tilted plane, stem to true ship-relative height.
      ctx.strokeStyle = withAlpha(color, alpha * 0.55);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(projectedScratch.x, projectedScratch.baseY);
      ctx.lineTo(projectedScratch.x, projectedScratch.tipY);
      ctx.stroke();
      ctx.fillStyle = withAlpha(color, alpha * 0.45);
      ctx.beginPath();
      ctx.arc(projectedScratch.x, projectedScratch.baseY, 1.2, 0, Math.PI * 2);
      ctx.fill();

      const r = this.contactSizePx * (projectedScratch.outOfRange ? 0.75 : 1);
      ctx.fillStyle = withAlpha(color, alpha);
      ctx.beginPath();
      ctx.moveTo(projectedScratch.x, projectedScratch.tipY - r);
      ctx.lineTo(projectedScratch.x + r, projectedScratch.tipY);
      ctx.lineTo(projectedScratch.x, projectedScratch.tipY + r);
      ctx.lineTo(projectedScratch.x - r, projectedScratch.tipY);
      ctx.closePath();
      ctx.fill();

      if (ship.id === player.targetId) {
        ctx.strokeStyle = withAlpha(color, 0.9);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(projectedScratch.x, projectedScratch.tipY, r + 3, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // Own-ship chevron at the radar origin, always pointing toward disc-forward.
    ctx.strokeStyle = this.palette.friendly;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(g.centreX - 4, g.centreY + 3);
    ctx.lineTo(g.centreX, g.centreY - 4);
    ctx.lineTo(g.centreX + 4, g.centreY + 3);
    ctx.stroke();
  }

  private project(x: number, y: number, z: number, player: ShipSnapshot): void {
    radarLocalPoint(
      x - player.pos.x,
      y - player.pos.y,
      z - player.pos.z,
      player.heading,
      player.pitch,
      localScratch,
    );
    projectRadarPoint(localScratch, this.geometry, projectedScratch);
  }

  private drawDisc(): void {
    const ctx = this.ctx;
    const g = this.geometry;
    ctx.fillStyle = withAlpha(this.palette.friendly, 0.025);
    ctx.beginPath();
    ctx.ellipse(g.centreX, g.centreY, g.radiusX, g.radiusY, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = withAlpha(this.palette.friendly, this.gridOpacity);
    ctx.lineWidth = 1;
    ctx.stroke();
    for (const scale of [0.66, 0.33]) {
      ctx.beginPath();
      ctx.ellipse(g.centreX, g.centreY, g.radiusX * scale, g.radiusY * scale, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.strokeStyle = withAlpha(this.palette.friendly, this.gridOpacity * 0.7);
    ctx.beginPath();
    ctx.moveTo(g.centreX - g.radiusX, g.centreY);
    ctx.lineTo(g.centreX + g.radiusX, g.centreY);
    ctx.moveTo(g.centreX, g.centreY - g.radiusY);
    ctx.lineTo(g.centreX, g.centreY + g.radiusY);
    ctx.stroke();
  }

  dispose(): void {
    this.container.remove();
  }
}

function withAlpha(color: string, alpha: number): string {
  const hex = color.trim();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(hex);
  const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!short && !long) return hex;
  const parts = short
    ? [short[1]!, short[2]!, short[3]!].map((c) => parseInt(c + c, 16))
    : [long![1]!, long![2]!, long![3]!].map((c) => parseInt(c, 16));
  return `rgba(${parts[0]},${parts[1]},${parts[2]},${alpha})`;
}

function findShip(snapshot: Snapshot, id: EntityId): ShipSnapshot | undefined {
  for (let i = 0; i < snapshot.ships.length; i++) {
    if (snapshot.ships[i]!.id === id) return snapshot.ships[i];
  }
  return undefined;
}

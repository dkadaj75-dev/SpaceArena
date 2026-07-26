import type {
  ArenaConfig,
  ConfigService,
  EntityId,
  EventBus,
  ConfigEvents,
  Snapshot,
  ThemeConfig,
} from "@space-arena/shared";
import { createLogger } from "@space-arena/shared";
import type { GameSession } from "../GameSession.js";
import { altitudeTickPx, DEFAULT_ALTITUDE_TICK_PX } from "./minimapAltitude.js";

const log = createLogger("HudMinimap");

const REDRAW_INTERVAL_MS = 100; // ~10 Hz, per spec

/**
 * The bubble's radius, or a `rect` arena approximated by its half-diagonal, so the
 * minimap scale still fits it. The minimap keeps its top-down (x,z) projection;
 * the third axis arrives as a per-blip altitude tick (BUBBLE.md §C, see
 * {@link altitudeTickPx}).
 */
function boundsRadius(arena: ArenaConfig | undefined): number | undefined {
  if (!arena) return undefined;
  const b = arena.bounds;
  return b.shape === "sphere" ? b.radius : Math.hypot(b.width, b.height) / 2;
}

/**
 * 2D canvas minimap (top-left, §2.3/§6 1.8): a top-down bubble silhouette,
 * asteroid dots, ships as team-colored blips, player heading tick. Cheap: redrawn at
 * ~10 Hz regardless of render frame rate, fixed device-pixel canvas size.
 */
export class Minimap {
  private readonly container: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly scaleEl: HTMLDivElement;
  private readonly ctx: CanvasRenderingContext2D;
  /**
   * Blip colors read out of the live theme (the `--hud-*` custom properties the
   * Hud writes onto `#hud`). Resolved once per theme change, never per draw:
   * `getComputedStyle` is a layout-flushing read and this runs at ~10 Hz.
   */
  private palette = { friendly: "#39bfff", hostile: "#ff405c", neutral: "#7f9dc4" };
  /** The arena the *sim* resolved — never a hardcoded id (FLIGHT.md §6). */
  private readonly arenaId: string;
  private arena: ArenaConfig | undefined;
  private rangeUnits = 100;
  private sizePx = 128;
  /** Saturation length of the relative-altitude ticks (0 hides them). */
  private altitudeTickMaxPx = DEFAULT_ALTITUDE_TICK_PX;
  private accMs = REDRAW_INTERVAL_MS; // draw immediately on first frame

  constructor(
    root: HTMLElement,
    private readonly configs: ConfigService,
    private readonly bus: EventBus<ConfigEvents>,
    private readonly session: GameSession,
  ) {
    this.container = document.createElement("div");
    // Shares the chamfered rim + translucent fill treatment with the gauge
    // cluster (hudStyle.ts `.hud-frame`).
    this.container.className = "hud-minimap hud-frame";
    root.appendChild(this.container);

    this.canvas = document.createElement("canvas");
    this.container.appendChild(this.canvas);

    // Range readout tucked into the frame — the map is now bevelled rather than
    // circular, so the scale it is drawn at should be legible rather than implied.
    this.scaleEl = document.createElement("div");
    this.scaleEl.className = "hud-minimap-scale";
    this.container.appendChild(this.scaleEl);

    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("Minimap: 2D canvas context unavailable");
    this.ctx = ctx;

    this.arenaId = session.arenaId;
    this.arena = configs.get<ArenaConfig>("arena", this.arenaId);
    if (!this.arena) log.warn(`arena config not found: ${this.arenaId}`);

    this.applySize();
    this.resizeCanvas();

    this.bus.on("config:changed", (evt) => {
      if (evt.type === "theme") {
        this.applySize();
        this.resizeCanvas();
      } else if (evt.id === this.arenaId) {
        this.arena = configs.get<ArenaConfig>("arena", this.arenaId);
      }
    });
  }

  private applySize(): void {
    const theme = this.configs.get<ThemeConfig>("theme", "theme.default");
    this.sizePx = theme?.hud?.minimapSizePx ?? 128;
    this.rangeUnits = theme?.hud?.minimapRangeUnits ?? boundsRadius(this.arena) ?? 100;
    this.altitudeTickMaxPx = theme?.hud?.minimapAltitudeTickPx ?? DEFAULT_ALTITUDE_TICK_PX;
    this.scaleEl.textContent = `${Math.round(this.rangeUnits)} U`;
    this.readPalette(theme);
  }

  /**
   * Canvas has no access to CSS custom properties, so the blip colors are
   * lifted out of the theme config directly (with the resolved computed value
   * as the fallback, which is what a pack that overrides `--hud-primary`
   * through some other route would want). Blips are the ONLY place the HUD
   * paints pixels rather than DOM, so this is the one place a color has to be
   * copied instead of inherited.
   */
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
      return resolved ? resolved : fallback;
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
    const size = this.sizePx;
    const half = size / 2;
    const scale = half / this.rangeUnits;

    ctx.clearRect(0, 0, size, size);

    // Instrument crosshair + top-down bubble silhouette. The cross is the map's
    // own frame of reference (the player is always at the centre), drawn faint
    // enough that a blip on top of it still reads.
    ctx.strokeStyle = withAlpha(this.palette.friendly, 0.18);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(half, 3);
    ctx.lineTo(half, size - 3);
    ctx.moveTo(3, half);
    ctx.lineTo(size - 3, half);
    ctx.stroke();

    const radius = boundsRadius(this.arena);
    if (radius !== undefined) {
      ctx.strokeStyle = withAlpha(this.palette.friendly, 0.34);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(half, half, Math.min(half - 1, radius * scale), 0, Math.PI * 2);
      ctx.stroke();
    }

    // Asteroids: dim neutral dots.
    ctx.fillStyle = withAlpha(this.palette.neutral, 0.75);
    for (let i = 0; i < cur.asteroids.length; i++) {
      const a = cur.asteroids[i]!;
      if (a.state === "destroyed") continue;
      const px = half + a.pos.x * scale;
      const py = half + a.pos.z * scale;
      ctx.beginPath();
      ctx.arc(px, py, Math.max(1, a.radius * scale), 0, Math.PI * 2);
      ctx.fill();
    }

    // Ships: team-colored triangles; player gets a heading wedge, everyone else
    // an altitude tick relative to the player (BUBBLE.md §C).
    const player = findShipPos(cur, this.session.playerId);
    for (let i = 0; i < cur.ships.length; i++) {
      const s = cur.ships[i]!;
      const px = half + s.pos.x * scale;
      const py = half + s.pos.z * scale;
      const isPlayer = s.id === this.session.playerId;
      const color = isPlayer || s.team === this.session.playerTeam ? this.palette.friendly : this.palette.hostile;
      const r = isPlayer ? 5 : 4;

      ctx.save();
      ctx.translate(px, py);
      // Sim heading is math-convention (0 = +X). The triangle points up
      // (canvas −y = world −z) at rotation 0, so rotate by π/2 + heading.
      ctx.rotate(Math.PI / 2 + s.heading);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(0, -r);
      ctx.lineTo(r * 0.7, r * 0.8);
      ctx.lineTo(-r * 0.7, r * 0.8);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      // Drawn OUTSIDE the rotated frame: the tick is a screen-space up/down cue,
      // not part of the blip's facing. Nothing to draw for the player (its own
      // altitude is the reference) or for a contact on the same level.
      if (isPlayer || !player) continue;
      const tick = altitudeTickPx(s.pos.y - player.y, scale, this.altitudeTickMaxPx);
      if (tick === 0) continue;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px + r, py);
      ctx.lineTo(px + r, py + tick);
      ctx.stroke();
    }
  }

  dispose(): void {
    this.container.remove();
  }
}

/**
 * A themed color at a given alpha, for the canvas's structural lines. Handles
 * the `#rgb`/`#rrggbb` a theme actually authors; anything else (a named color,
 * an `rgb()` string a browser resolved) is returned unchanged with
 * `globalAlpha` left to the caller — the lines are decoration, and a slightly
 * too-bright grid is a better failure than a thrown exception mid-draw.
 */
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

/** Indexed scan (no per-draw closure) for a ship's position by id. */
function findShipPos(snap: Snapshot, id: EntityId): { x: number; y: number; z: number } | undefined {
  for (let i = 0; i < snap.ships.length; i++) if (snap.ships[i]!.id === id) return snap.ships[i]!.pos;
  return undefined;
}

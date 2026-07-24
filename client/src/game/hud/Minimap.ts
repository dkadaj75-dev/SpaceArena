import type { ArenaConfig, ConfigService, EventBus, ConfigEvents, Snapshot, ThemeConfig } from "@space-arena/shared";
import { createLogger } from "@space-arena/shared";
import type { GameSession } from "../GameSession.js";

const log = createLogger("HudMinimap");

const ARENA_ID = "arena.ring-nebula";
const REDRAW_INTERVAL_MS = 100; // ~10 Hz, per spec

/** Approximates a `rect` arena as its half-diagonal so the minimap scale still fits it. */
function boundsRadius(arena: ArenaConfig | undefined): number | undefined {
  if (!arena) return undefined;
  const b = arena.bounds;
  return b.shape === "circle" ? b.radius : Math.hypot(b.width, b.height) / 2;
}

/**
 * 2D canvas minimap (top-left, §2.3/§6 1.8): arena bounds circle, asteroid
 * dots, ships as team-colored blips, player heading tick. Cheap: redrawn at
 * ~10 Hz regardless of render frame rate, fixed device-pixel canvas size.
 */
export class Minimap {
  private readonly container: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private arena: ArenaConfig | undefined;
  private rangeUnits = 100;
  private sizePx = 128;
  private accMs = REDRAW_INTERVAL_MS; // draw immediately on first frame

  constructor(
    root: HTMLElement,
    private readonly configs: ConfigService,
    private readonly bus: EventBus<ConfigEvents>,
    private readonly session: GameSession,
  ) {
    this.container = document.createElement("div");
    this.container.className = "hud-minimap";
    root.appendChild(this.container);

    this.canvas = document.createElement("canvas");
    this.container.appendChild(this.canvas);

    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("Minimap: 2D canvas context unavailable");
    this.ctx = ctx;

    this.arena = configs.get<ArenaConfig>("arena", ARENA_ID);
    if (!this.arena) log.warn(`arena config not found: ${ARENA_ID}`);

    this.applySize();
    this.resizeCanvas();

    this.bus.on("config:changed", (evt) => {
      if (evt.type === "theme") {
        this.applySize();
        this.resizeCanvas();
      } else if (evt.id === ARENA_ID) {
        this.arena = configs.get<ArenaConfig>("arena", ARENA_ID);
      }
    });
  }

  private applySize(): void {
    const theme = this.configs.get<ThemeConfig>("theme", "theme.default");
    this.sizePx = theme?.hud?.minimapSizePx ?? 128;
    this.rangeUnits = theme?.hud?.minimapRangeUnits ?? boundsRadius(this.arena) ?? 100;
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

    // Bounds circle (subtle, matches the arena's overall radius fraction).
    const radius = boundsRadius(this.arena);
    if (radius !== undefined) {
      ctx.strokeStyle = "rgba(255,255,255,0.25)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(half, half, Math.min(half - 1, radius * scale), 0, Math.PI * 2);
      ctx.stroke();
    }

    // Asteroids: dim gray dots.
    ctx.fillStyle = "rgba(180,170,160,0.8)";
    for (let i = 0; i < cur.asteroids.length; i++) {
      const a = cur.asteroids[i]!;
      if (a.state === "destroyed") continue;
      const px = half + a.pos.x * scale;
      const py = half + a.pos.z * scale;
      ctx.beginPath();
      ctx.arc(px, py, Math.max(1, a.radius * scale), 0, Math.PI * 2);
      ctx.fill();
    }

    // Ships: team-colored triangles; player gets a heading wedge.
    for (let i = 0; i < cur.ships.length; i++) {
      const s = cur.ships[i]!;
      const px = half + s.pos.x * scale;
      const py = half + s.pos.z * scale;
      const isPlayer = s.id === this.session.playerId;
      ctx.save();
      ctx.translate(px, py);
      // Sim heading is math-convention (0 = +X). The triangle points up
      // (canvas −y = world −z) at rotation 0, so rotate by π/2 + heading.
      ctx.rotate(Math.PI / 2 + s.heading);
      ctx.fillStyle = isPlayer
        ? "#57d8ff"
        : s.team === this.session.playerTeam
          ? "#57d8ff"
          : "#ff4d5e";
      const r = isPlayer ? 5 : 4;
      ctx.beginPath();
      ctx.moveTo(0, -r);
      ctx.lineTo(r * 0.7, r * 0.8);
      ctx.lineTo(-r * 0.7, r * 0.8);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  dispose(): void {
    this.container.remove();
  }
}

import {
  createLogger,
  resolveShipStats,
  type ConfigService,
  type EntityId,
  type ShipConfig,
  type ShipSnapshot,
  type Snapshot,
  type TuningConfig,
} from "@space-arena/shared";
import type { GameSession } from "../GameSession.js";
import { VirtualJoystick } from "./VirtualJoystick.js";
import { ThrottleStrip } from "./ThrottleStrip.js";
import { BoostButton } from "./BoostButton.js";
import { LockReticle } from "./LockReticle.js";
import {
  orderMinIntervalMs,
  reticleRadiusPx,
  type CameraView,
  type FlightHudLayout,
} from "./flightHudLayout.js";
import { flightKeyOf, keyAxesFrom, rampThrottle, turnFromStick, type FlightInputState } from "./flightInput.js";
import { FlightOrderSender } from "./flightOrders.js";

const log = createLogger("FlightControls");

/**
 * What the flight HUD needs from the 3D layer, injected by `main.ts` so the HUD
 * never imports Babylon (and so every widget below stays testable in jsdom).
 */
export interface FlightHudBinding {
  /**
   * World position → CSS px inside the HUD root, written into `out`. Returns
   * false when the point is behind the camera or otherwise unprojectable, which
   * is the caller's cue to hide whatever it was placing.
   */
  project(x: number, y: number, z: number, out: { x: number; y: number }): boolean;
  /** Fill `out` with the live chase-camera geometry. Called once per frame — must not allocate. */
  cameraView(out: CameraView): void;
}

/**
 * The flight HUD (FLIGHT.md §4): joystick + throttle lever + boost button + lock
 * reticle, the desktop key bindings, and the order sender that turns all of it
 * into `flight` orders.
 *
 * It owns the *aggregation*, not the feel: every threshold, dimension and curve
 * arrives through the resolved {@link FlightHudLayout}, and the pure mapping
 * math lives in `flightInput.ts` / `flightHudLayout.ts` so the sign conventions
 * and the debounce are unit-testable without a DOM.
 *
 * Input precedence is "whatever the player is touching wins": a held stick beats
 * the keys, and a dragged throttle lever ignores the W/S ramp. Nothing here
 * decides what is locked or how fast the ship turns — the sim owns that.
 */
export class FlightControls {
  private readonly container: HTMLDivElement;
  private readonly joystick: VirtualJoystick;
  private readonly throttleStrip: ThrottleStrip;
  private readonly boostButton: BoostButton;
  private readonly reticle: LockReticle;
  private readonly sender: FlightOrderSender;

  private layout: FlightHudLayout;
  private enabled = true;
  /** Keys currently held, normalized by {@link flightKeyOf}. */
  private readonly heldKeys = new Set<string>();

  // Per-frame scratch — this runs every render frame, so nothing here allocates.
  private readonly input: FlightInputState = { throttle: 0, turn: 0, boost: false };
  private readonly view: CameraView = { fovRad: 0.8, betaRad: Math.PI / 2 };
  private readonly projected = { x: 0, y: 0 };

  // Reticle geometry is recomputed only when one of its inputs moves (see
  // `updateZone`). Compared field by field rather than through a composite key:
  // this runs every frame, and a template string would allocate on all of them.
  private zoneCone = Number.NaN;
  private zoneFov = Number.NaN;
  private zoneBeta = Number.NaN;
  private zoneWidth = Number.NaN;
  private zoneHeight = Number.NaN;
  /** Resolved `sensors.coneDeg`, cached against the fit that produced it. */
  private coneDeg = 0;
  private coneShipId: string | null = null;
  private coneModuleCount = -1;

  private readonly onKeyDown = (ev: KeyboardEvent): void => {
    if (!this.enabled || ev.repeat || isTextEntry(ev.target)) return;
    const key = flightKeyOf(ev.key);
    if (!key) return;
    this.heldKeys.add(key);
    // Arrows scroll the page (and W/S can trigger browser quick-find); a flight
    // control that also scrolls the document is not a flight control.
    ev.preventDefault();
  };

  private readonly onKeyUp = (ev: KeyboardEvent): void => {
    const key = flightKeyOf(ev.key);
    if (key) this.heldKeys.delete(key);
  };

  /**
   * Alt-tab, a focus steal or the settings overlay opening must not leave a key
   * stuck down — a jammed "D" would fly the ship in a circle while the player is
   * looking at another window.
   */
  private readonly onBlur = (): void => {
    this.heldKeys.clear();
  };

  constructor(
    root: HTMLElement,
    private readonly configs: ConfigService,
    private readonly session: GameSession,
    private readonly playerId: EntityId,
    private readonly binding: FlightHudBinding,
    layout: FlightHudLayout,
  ) {
    this.layout = layout;

    this.container = document.createElement("div");
    this.container.className = "hud-flight";
    root.appendChild(this.container);

    this.joystick = new VirtualJoystick(this.container, layout);
    this.throttleStrip = new ThrottleStrip(this.container, layout);
    this.boostButton = new BoostButton(this.container, layout);
    this.reticle = new LockReticle(this.container, layout);

    this.sender = new FlightOrderSender(
      (order) => this.session.order(order),
      { ...layout.orders, minIntervalMs: this.resolvedMinInterval(layout) },
    );

    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
  }

  /** Adopt a freshly resolved layout (theme hot-reload, rotation, resize). */
  applyLayout(layout: FlightHudLayout): void {
    this.layout = layout;
    this.joystick.applyLayout(layout);
    this.throttleStrip.applyLayout(layout);
    this.boostButton.applyLayout(layout);
    this.reticle.applyLayout(layout);
    this.sender.setPolicy({ ...layout.orders, minIntervalMs: this.resolvedMinInterval(layout) });
    // Viewport/scale feed the reticle size — force a recompute on the next frame.
    this.zoneCone = Number.NaN;
  }

  /**
   * Drop the cached stat resolution (ship/module config hot-reload). Cheap: the
   * next frame re-resolves and the reticle re-sizes itself.
   */
  refresh(): void {
    this.coneShipId = null;
    this.coneModuleCount = -1;
    this.zoneCone = Number.NaN;
  }

  /**
   * Show/hide and arm/disarm the controls. Off while the match is over, so a
   * player poking at the results screen cannot keep flying a dead ship.
   */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.container.classList.toggle("hidden", !enabled);
    if (!enabled) this.heldKeys.clear();
  }

  /** Orders emitted so far this match — debug overlays and the rate-limit test. */
  get ordersSent(): number {
    return this.sender.sentCount;
  }

  /** The state last handed to the sim (debug / tests). */
  get lastSent(): Readonly<FlightInputState> {
    return this.sender.lastSent;
  }

  /**
   * One render frame. `alpha` is the render-loop interpolation factor, used for
   * the target bracket so it tracks the same interpolated ship the 3D view draws
   * rather than juddering at the sim rate.
   */
  update(cur: Snapshot, prev: Snapshot, alpha: number, dtMs: number, nowMs: number): void {
    const ship = findShip(cur, this.playerId);
    // A dead player (or a finished match) keeps no controls: hide, and stop
    // sending — the level-triggered FlightState the sim already holds is moot.
    this.setEnabled(ship !== undefined && cur.phase === "live");
    if (!this.enabled || !ship) return;

    const keys = keyAxesFrom(this.heldKeys);

    // Throttle: the lever is authoritative; the keys ramp it while held and the
    // value persists when they are released (same contract as the thumb).
    if (keys.throttleRamp !== 0) {
      this.throttleStrip.setThrottle(
        rampThrottle(this.throttleStrip.throttle, keys.throttleRamp, this.layout.throttle.keyRampPerSec, dtMs),
      );
    }

    // Turn: a held stick wins; otherwise the keys act as a full deflection. Both
    // go through `turnFromStick`, so there is exactly ONE place that knows which
    // sign reads as a screen-right turn under the chase cam.
    const turn = this.joystick.active
      ? this.joystick.turn
      : turnFromStick(keys.turnScreenX, 0, 1);

    const boost = this.boostButton.held || keys.boost;
    this.boostButton.setKeyActive(keys.boost);

    this.input.throttle = this.throttleStrip.throttle;
    this.input.turn = turn;
    this.input.boost = boost;
    this.sender.update(this.input, nowMs);

    this.updateReticle(cur, prev, alpha, ship);
  }

  /** Zone circle + target bracket for this frame. */
  private updateReticle(cur: Snapshot, prev: Snapshot, alpha: number, ship: ShipSnapshot): void {
    this.binding.cameraView(this.view);
    this.updateZone(ship);

    const targetId = ship.targetId;
    if (targetId === null) {
      this.reticle.update(false, 0, 0, 0, false);
      return;
    }
    const curTarget = findShip(cur, targetId);
    if (!curTarget) {
      this.reticle.update(false, 0, 0, 0, false);
      return;
    }
    const prevTarget = findShip(prev, targetId) ?? curTarget;
    const x = prevTarget.pos.x + (curTarget.pos.x - prevTarget.pos.x) * alpha;
    const z = prevTarget.pos.z + (curTarget.pos.z - prevTarget.pos.z) * alpha;
    // The ships' view nodes sit on the arena plane; bracket the hull centre.
    const onScreen = this.binding.project(x, 0, z, this.projected);
    this.reticle.update(onScreen, this.projected.x, this.projected.y, ship.lockProgress, ship.locked);
  }

  /**
   * Re-derive the zone circle when (and only when) something it depends on
   * moved: the resolved cone, the camera's fov/tilt, or the viewport. The
   * projection is a handful of trig calls, but it also allocates a result
   * object — and none of its inputs change on a typical frame.
   */
  private updateZone(ship: ShipSnapshot): void {
    const cone = this.resolveConeDeg(ship);
    const viewport = this.layout.viewport;
    if (
      cone === this.zoneCone &&
      this.view.fovRad === this.zoneFov &&
      this.view.betaRad === this.zoneBeta &&
      viewport.width === this.zoneWidth &&
      viewport.height === this.zoneHeight
    ) {
      return;
    }
    this.zoneCone = cone;
    this.zoneFov = this.view.fovRad;
    this.zoneBeta = this.view.betaRad;
    this.zoneWidth = viewport.width;
    this.zoneHeight = viewport.height;
    const size = reticleRadiusPx(cone, this.view, viewport, this.layout.reticle);
    this.reticle.setZone(size.radiusPx, size.clamped);
  }

  /**
   * The player's resolved `sensors.coneDeg` — ship class through the same
   * {@link resolveShipStats} stack the sim uses, so a module that widens the
   * sensor cone widens the drawn zone with no HUD change at all.
   *
   * Cached against ship id + module count: a fitting is fixed for a match, and
   * the count is what changes on a respawn into a different hull. DB upgrade
   * levels are deliberately not applied here — the client does not know them
   * offline, and the reticle is a zone hint, not a firing solution.
   */
  private resolveConeDeg(ship: ShipSnapshot): number {
    const shipId = this.session.shipConfigIdFor(this.playerId);
    if (!shipId) return this.coneDeg;
    if (shipId === this.coneShipId && ship.modules.length === this.coneModuleCount) return this.coneDeg;
    this.coneShipId = shipId;
    this.coneModuleCount = ship.modules.length;
    const cfg = this.configs.get<ShipConfig>("ship", shipId);
    if (!cfg) {
      log.warn(`unknown ship config ${shipId} — reticle keeps its last cone`);
      return this.coneDeg;
    }
    const fittedModuleIds: string[] = [];
    for (let i = 0; i < ship.modules.length; i++) fittedModuleIds.push(ship.modules[i]!.moduleId);
    this.coneDeg = resolveShipStats(cfg, this.configs, { fittedModuleIds }).sensors.coneDeg;
    return this.coneDeg;
  }

  /**
   * The theme's order floor, raised if it would spend more than the flight
   * sender's share of the server's `tuning.maxOrdersPerSec` (FLIGHT.md §4 —
   * flight input must stay comfortably inside the rate limit).
   */
  private resolvedMinInterval(layout: FlightHudLayout): number {
    const tuning = this.configs.getAll<TuningConfig>("tuning")[0];
    return orderMinIntervalMs(layout, tuning?.maxOrdersPerSec);
  }

  dispose(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    this.joystick.dispose();
    this.throttleStrip.dispose();
    this.boostButton.dispose();
    this.reticle.dispose();
    this.container.remove();
  }
}

/** Indexed scan (no per-frame closure allocation) for a ship by id. */
function findShip(snap: Snapshot, id: EntityId): ShipSnapshot | undefined {
  for (let i = 0; i < snap.ships.length; i++) if (snap.ships[i]!.id === id) return snap.ships[i];
  return undefined;
}

/**
 * True when a keystroke belongs to a text field — the settings overlay and the
 * dev editor both sit over the HUD, and typing "was" in one of them must not
 * throttle up.
 */
function isTextEntry(target: unknown): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean } | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

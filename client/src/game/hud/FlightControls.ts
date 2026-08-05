import {
  createLogger,
  resolveShipStats,
  type ConfigService,
  type EntityId,
  type ModuleConfig,
  type ModuleSnapshot,
  type ShipConfig,
  type ShipSnapshot,
  type Snapshot,
  type TuningConfig,
} from "@space-arena/shared";
import type { GameSession } from "../GameSession.js";
import { VirtualJoystick } from "./VirtualJoystick.js";
import { ThrottleStrip } from "./ThrottleStrip.js";
import { FireButton } from "./FireButton.js";
import { BoostButton, type BoostButtonState } from "./BoostButton.js";
import { JettisonButton, type JettisonButtonState } from "./JettisonButton.js";
import { CanvasFireInput } from "./CanvasFireInput.js";
import { LockReticle } from "./LockReticle.js";
import { EnemyArrows } from "./EnemyArrows.js";
import { SpeedReadout } from "./SpeedReadout.js";
import { RelativeSteerInput } from "./RelativeSteerInput.js";
import {
  FLIGHT_ORDER_BUDGET_SHARE,
  orderMinIntervalMs,
  reticleRadiusPx,
  type CameraView,
  type FlightHudLayout,
  type ProjectedPoint,
} from "./flightHudLayout.js";
import {
  flightKeyOf,
  keyAxesFrom,
  rampThrottle,
  type FlightInputState,
} from "./flightInput.js";
import { FlightOrderSender, type FlightOrderPolicy } from "./flightOrders.js";

const log = createLogger("FlightControls");
const DEFAULT_MAX_ORDERS_PER_SEC = 20;

/** Pushed at the BOOST control by a fitting that has no boost module. */
const NO_BOOST_FITTED: BoostButtonState = {
  hardpointIndex: null,
  active: false,
  overheated: false,
  heatPct: 0,
  blocked: false,
};
const NO_JETTISON_FITTED: JettisonButtonState = { fitted: false, cooldownSec: 0, cooldownTotalSec: 0 };

/** Array index of the first fitted boost module, or -1 when this fitting has none. */
export function firstBoostModuleIndex(
  configs: Pick<ConfigService, "get">,
  modules: readonly ModuleSnapshot[],
): number {
  for (let i = 0; i < modules.length; i++) {
    if (configs.get<ModuleConfig>("module", modules[i]!.moduleId)?.boost) return i;
  }
  return -1;
}

/**
 * Whether `id` is currently carrying a CTF flag. A carrier gets NO afterburner —
 * the sim refuses the speed multiplier outright (`resolveBoostMult` in
 * shared/src/sim/systems/NavigationSystem.ts), which is what turns a flag run
 * into a fight rather than a sprint. The HUD reads the same fact off the
 * snapshot so the BOOST control can say so instead of silently doing nothing.
 */
export function carriesFlag(snapshot: Pick<Snapshot, "flags">, id: EntityId): boolean {
  for (let i = 0; i < snapshot.flags.length; i++) {
    if (snapshot.flags[i]!.carrierId === id) return true;
  }
  return false;
}

/**
 * What the flight HUD needs from the 3D layer, injected by `main.ts` so the HUD
 * never imports Babylon (and so every widget below stays testable in jsdom).
 */
export interface FlightHudBinding {
  /** Live game canvas; desktop RMB steering must begin on it. */
  inputSurface: HTMLElement;
  /**
   * World position → CSS px inside the HUD root, written into `out`. Returns
   * false only when the point is genuinely UNPROJECTABLE (no canvas yet, or the
   * point sitting on the camera plane where the projection blows up).
   *
   * A point behind the camera still projects — mirrored through the screen
   * centre — and comes back with `out.behind = true` (BUBBLE.md §C). Consumers
   * that want a marker ON the thing hide it; the off-screen arrows need the
   * mirrored direction, which is why the flag replaced the old "behind ⇒ false".
   */
  project(x: number, y: number, z: number, out: ProjectedPoint): boolean;
  /** Fill `out` with the live chase-camera geometry. Called once per frame — must not allocate. */
  cameraView(out: CameraView): void;
}

/**
 * The flight HUD: relative steering + reusable joystick, throttle, FIRE,
 * reticle, enemy arrows, desktop keys, and the `flight` order sender.
 * orders.
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
  private readonly relativeSteer: RelativeSteerInput;
  private readonly throttleStrip: ThrottleStrip;
  private readonly fireButton: FireButton;
  private readonly boostButton: BoostButton;
  private readonly jettisonButton: JettisonButton;
  private readonly canvasFire: CanvasFireInput;
  private readonly reticle: LockReticle;
  private readonly enemyArrows: EnemyArrows;
  private readonly speedReadout: SpeedReadout;
  private readonly sender: FlightOrderSender;

  private layout: FlightHudLayout;
  private enabled = true;
  /** Keys currently held, normalized by {@link flightKeyOf}. */
  private readonly heldKeys = new Set<string>();
  /**
   * Player pitch-invert preference (`sa.controls.invertPitch`, 5.8).
   */

  // Per-frame scratch — this runs every render frame, so nothing here allocates.
  private readonly input: FlightInputState = {
    throttle: 0,
    turn: 0,
    pitchStick: 0,
    boost: false,
    fire: false,
  };
  private fireWasHeld = false;
  /** First fitted boost-family module, used by the Shift convenience toggle. */
  private boostHardpointIndex: number | null = null;
  /** Replicated active state of that fitted boost module. */
  private boostActive = false;
  private readonly view: CameraView = { fovRad: 0.8, betaRad: Math.PI / 2 };
  private readonly projected: ProjectedPoint = { x: 0, y: 0, behind: false };

  // Reticle geometry is recomputed only when one of its inputs moves (see
  // `updateZone`). Compared field by field rather than through a composite key:
  // this runs every frame, and a template string would allocate on all of them.
  private zoneCone = Number.NaN;
  private zoneFov = Number.NaN;
  private zoneBeta = Number.NaN;
  private zonePitch = Number.NaN;
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
    if (key === "shift" && this.boostHardpointIndex !== null) {
      this.toggleBoost(this.boostHardpointIndex);
    }
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
    private readonly onBlockedFire: (() => void) | null = null,
  ) {
    this.layout = layout;

    this.container = document.createElement("div");
    this.container.className = "hud-flight";
    root.appendChild(this.container);

    this.joystick = new VirtualJoystick(this.container, layout);
    this.relativeSteer = new RelativeSteerInput(this.container, binding.inputSurface, layout);
    this.throttleStrip = new ThrottleStrip(this.container, layout);
    this.fireButton = new FireButton(this.container, layout);
    // Same order path as the Shift shortcut below — one way to ask for boost.
    this.boostButton = new BoostButton(this.container, layout, (hardpointIndex) =>
      this.toggleBoost(hardpointIndex),
    );
    this.jettisonButton = new JettisonButton(this.container, layout, () => this.jettisonHeatsink());
    this.canvasFire = new CanvasFireInput(binding.inputSurface);
    this.reticle = new LockReticle(this.container, layout);
    this.enemyArrows = new EnemyArrows(this.container, layout);
    this.speedReadout = new SpeedReadout(this.container, layout);

    this.sender = new FlightOrderSender(
      (order) => this.session.order(order),
      this.orderPolicy(layout),
    );

    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
  }

  /** Adopt a freshly resolved layout (theme hot-reload, rotation, resize). */
  applyLayout(layout: FlightHudLayout): void {
    this.layout = layout;
    this.joystick.applyLayout(layout);
    this.relativeSteer.applyLayout(layout);
    this.throttleStrip.applyLayout(layout);
    this.fireButton.applyLayout(layout);
    this.boostButton.applyLayout(layout);
    this.jettisonButton.applyLayout(layout);
    this.reticle.applyLayout(layout);
    this.enemyArrows.applyLayout(layout);
    this.speedReadout.applyLayout(layout);
    this.sender.setPolicy(this.orderPolicy(layout));
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
    if (!enabled) {
      this.heldKeys.clear();
      this.fireWasHeld = false;
      this.boostHardpointIndex = null;
      this.boostActive = false;
      this.boostButton.clear();
      this.jettisonButton.clear();
      // The container is hidden anyway, but a disarmed HUD must not come back
      // with last frame's arrows parked around a screen that has moved on.
      this.enemyArrows.clear();
    }
    this.relativeSteer.setEnabled(enabled);
    this.canvasFire.setEnabled(enabled);
    this.fireButton.setEnabled(enabled);
  }

  /**
   * Adopt the player's pitch-invert preference (5.8 settings, BUBBLE.md §C).
   * Applies to the thumb and the W/S + ↑/↓ keys alike.
   */
  setInvertPitch(invert: boolean): void {
    this.joystick.setInvertPitch(invert);
    this.relativeSteer.setInvertPitch(invert);
  }

  setSteerSensitivity(mouseMultiplier: number, touchMultiplier: number): void {
    this.relativeSteer.setSensitivityMultipliers(mouseMultiplier, touchMultiplier);
  }

  /** Orders emitted so far this match — debug overlays and the rate-limit test. */
  get ordersSent(): number {
    return this.sender.sentCount;
  }

  /** The state last handed to the sim (debug / tests). */
  get lastSent(): Readonly<FlightInputState> {
    return this.sender.lastSent;
  }

  /** Off-screen enemy arrows drawn this frame — debug overlays and tests. */
  get enemyArrowCount(): number {
    return this.enemyArrows.visibleCount;
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

    // The reusable fixed stick wins when enabled/held; otherwise relative input
    // supplies both axes.
    const turn = this.joystick.active ? this.joystick.turn : this.relativeSteer.turn;

    const pitchStick = this.joystick.active ? this.joystick.pitch : this.relativeSteer.pitchStick;

    this.refreshBoostState(cur, ship);
    this.refreshJettisonState(ship);
    const fire = this.fireButton.held || this.canvasFire.held || keys.fire;
    this.fireButton.setKeyActive(this.canvasFire.held || keys.fire);
    // "NO LOCK" feedback only when the pull genuinely does nothing — i.e. every
    // fitted weapon is a homing one that still hard-requires a lock. Straight-
    // fire weapons (laser/kinetic/beam) now shoot down the nose without a lock.
    if (fire && !this.fireWasHeld && !ship.locked && !this.hasStraightFireWeapon(ship)) {
      this.reticle.flashNoLock();
      this.onBlockedFire?.();
    }
    this.fireWasHeld = fire;

    this.input.throttle = this.throttleStrip.throttle;
    this.input.turn = turn;
    this.input.pitchStick = pitchStick;
    this.input.boost = this.boostActive;
    this.input.fire = fire;
    this.sender.update(this.input, nowMs);

    this.reticle.updateFeedback(dtMs);
    this.updateReticle(cur, prev, alpha, ship);
    this.updateEnemyArrows(cur, prev, alpha, ship);
    const prevShip = findShip(prev, this.playerId) ?? ship;
    this.speedReadout.update(ship, prevShip, cur.elapsed - prev.elapsed, nowMs);
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
    const y = prevTarget.pos.y + (curTarget.pos.y - prevTarget.pos.y) * alpha;
    const z = prevTarget.pos.z + (curTarget.pos.z - prevTarget.pos.z) * alpha;
    // Bracket the hull centre — which in the bubble is at the ship's own
    // altitude, not on a plane (BUBBLE.md §C). A candidate behind the camera
    // projects mirrored, so the bracket hides and the arrow takes over.
    const projected = this.binding.project(x, y, z, this.projected);
    const onScreen = projected && !this.projected.behind;
    const distance = Math.hypot(x - ship.pos.x, y - ship.pos.y, z - ship.pos.z);
    this.reticle.update(
      onScreen,
      this.projected.x,
      this.projected.y,
      ship.lockProgress,
      ship.locked,
      distance,
      this.session.displayNameFor(curTarget.id),
    );
  }

  /**
   * Off-screen enemy arrows (BUBBLE.md §C). One pass over the snapshot's ships:
   * enemies of the player's team get offered to the pool, which decides for each
   * whether it is far enough outside the safe rect (or behind the camera) to
   * deserve an arrow. Allied ships and the player never get one — the feature
   * answers "where is the thing shooting at me", not "where is everyone".
   */
  private updateEnemyArrows(cur: Snapshot, prev: Snapshot, alpha: number, ship: ShipSnapshot): void {
    this.enemyArrows.begin();
    if (this.layout.enemyArrows.enabled) {
      const px = ship.pos.x;
      const py = ship.pos.y;
      const pz = ship.pos.z;
      for (let i = 0; i < cur.ships.length; i++) {
        const enemy = cur.ships[i]!;
        if (enemy.team === ship.team) continue;
        const p = findShip(prev, enemy.id) ?? enemy;
        const x = p.pos.x + (enemy.pos.x - p.pos.x) * alpha;
        const y = p.pos.y + (enemy.pos.y - p.pos.y) * alpha;
        const z = p.pos.z + (enemy.pos.z - p.pos.z) * alpha;
        if (!this.binding.project(x, y, z, this.projected)) continue;
        // True 3D distance: the fade is about how far away the contact is, and in
        // a bubble a planar distance would call an enemy 200 units overhead close.
        const distance = Math.hypot(x - px, y - py, z - pz);
        this.enemyArrows.place(this.projected, distance, enemy.id === ship.targetId);
      }
      // CTF flags and delivery bases get separate reserved pools. Unlike ships,
      // objectives are never lock candidates; their projected markers remain
      // visible in the central play area as well as on the directional track.
      if (cur.flags.length > 0) {
        for (let i = 0; i < cur.flags.length; i++) {
          const flag = cur.flags[i]!;
          if (!this.binding.project(flag.pos.x, flag.pos.y, flag.pos.z, this.projected)) continue;
          const distance = Math.hypot(flag.pos.x - px, flag.pos.y - py, flag.pos.z - pz);
          this.enemyArrows.placeFlag(this.projected, distance, flag.team === ship.team);
        }
        for (let i = 0; i < cur.flags.length; i++) {
          const flag = cur.flags[i]!;
          // At home, the flag and its base occupy the same point. The pennant
          // owns that HUD cue so the two symbols never stack into an illegible
          // blob; once it moves, its delivery location is independently shown.
          if (flag.state === "home") continue;
          if (!this.binding.project(flag.home.x, flag.home.y, flag.home.z, this.projected)) continue;
          const distance = Math.hypot(flag.home.x - px, flag.home.y - py, flag.home.z - pz);
          this.enemyArrows.placeBase(this.projected, distance, flag.team === ship.team);
        }
      }
    }
    this.enemyArrows.finish();
  }

  /**
   * Re-derive the zone circle when (and only when) something it depends on
   * moved: the resolved cone, the camera's fov/tilt, the SHIP's pitch (the cone
   * is facing-relative, so the tilt that matters is the camera's relative to the
   * nose — see {@link reticleRadiusPx}), or the viewport. The projection is a
   * handful of trig calls, but it also allocates a result object.
   *
   * The pitch does move on most frames of a climb, unlike the other inputs — but
   * the camera's own beta moves with it, so this check was never going to elide
   * those frames anyway.
   */
  private updateZone(ship: ShipSnapshot): void {
    const cone = this.resolveConeDeg(ship);
    const viewport = this.layout.viewport;
    // ZERO, deliberately. `reticleRadiusPx` sizes the lock cone from the angle
    // between the camera axis and the nose, which it computes as
    // `view.betaRad - shipPitchRad`. The chase rig rolls with the ship
    // (BUBBLE.md §A), so its orbit beta is now expressed in the SHIP's frame,
    // where the nose is level by construction — the ship's pitch is already
    // accounted for by the frame itself and subtracting it again would
    // double-count. That makes the effective tilt constant, which is exactly the
    // behaviour `reticleRadiusPx` documents for a rig that looks down the nose:
    // the ring no longer breathes at all through a climb or a loop.
    const pitch = 0;
    if (
      cone === this.zoneCone &&
      this.view.fovRad === this.zoneFov &&
      this.view.betaRad === this.zoneBeta &&
      pitch === this.zonePitch &&
      viewport.width === this.zoneWidth &&
      viewport.height === this.zoneHeight
    ) {
      return;
    }
    this.zoneCone = cone;
    this.zoneFov = this.view.fovRad;
    this.zoneBeta = this.view.betaRad;
    this.zonePitch = pitch;
    this.zoneWidth = viewport.width;
    this.zoneHeight = viewport.height;
    const size = reticleRadiusPx(cone, this.view, viewport, this.layout.reticle, pitch);
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
   * Human boost intent is the boost module's replicated toggle state. This is
   * deliberately separate from the sim's energy/heat eligibility check: an
   * active module keeps requesting boost, and the sim continues to decide
   * whether that request can work on each tick.
   */
  private refreshBoostState(cur: Snapshot, ship: ShipSnapshot): void {
    this.boostHardpointIndex = null;
    this.boostActive = false;
    const index = firstBoostModuleIndex(this.configs, ship.modules);
    if (index < 0) {
      // No boost fitted: the control is not rendered at all (rather than shown
      // dead), because there is nothing about this ship it could explain.
      this.boostButton.update(NO_BOOST_FITTED);
      return;
    }
    const module = ship.modules[index]!;
    this.boostHardpointIndex = module.hardpointIndex;
    this.boostActive = module.state === "active";
    // Heat against the module's OWN overheat threshold, not the ship's capacity:
    // the threshold is what actually shuts the afterburner off.
    const threshold = this.configs.get<ModuleConfig>("module", module.moduleId)?.heat.overheatThreshold ?? 0;
    this.boostButton.update({
      hardpointIndex: module.hardpointIndex,
      active: this.boostActive,
      overheated: module.state === "overheated",
      heatPct: threshold > 0 ? (100 * module.heat) / threshold : 0,
      blocked: carriesFlag(cur, ship.id),
    });
  }

  /** The single boost order path: the touch control and Shift both come here. */
  private toggleBoost(hardpointIndex: number): void {
    this.session.order({ kind: "moduleToggle", hardpointIndex });
  }

  /** The wire order is shared by offline GameSession and NetGameSession. */
  private jettisonHeatsink(): void {
    this.session.order({ kind: "jettisonHeatsink" });
  }

  private refreshJettisonState(ship: ShipSnapshot): void {
    for (const module of ship.modules) {
      const jettison = this.configs.get<ModuleConfig>("module", module.moduleId)?.jettison;
      if (!jettison) continue;
      this.jettisonButton.update({
        fitted: true,
        cooldownSec: module.cycleTimer,
        cooldownTotalSec: jettison.cooldownSec,
      });
      return;
    }
    this.jettisonButton.update(NO_JETTISON_FITTED);
  }

  /** Whether any fitted weapon can fire without a lock (non-homing `fire`). */
  private hasStraightFireWeapon(ship: ShipSnapshot): boolean {
    for (const m of ship.modules) {
      const fire = this.configs.get<ModuleConfig>("module", m.moduleId)?.fire;
      if (fire && fire.projectile?.turnRate === undefined) return true;
    }
    return false;
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

  private orderPolicy(layout: FlightHudLayout): FlightOrderPolicy {
    const tuning = this.configs.getAll<TuningConfig>("tuning")[0];
    return {
      ...layout.orders,
      minIntervalMs: this.resolvedMinInterval(layout),
      maxOrdersPerSec: tuning?.maxOrdersPerSec ?? DEFAULT_MAX_ORDERS_PER_SEC,
      budgetShare: FLIGHT_ORDER_BUDGET_SHARE,
    };
  }

  dispose(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    this.joystick.dispose();
    this.relativeSteer.dispose();
    this.throttleStrip.dispose();
    this.fireButton.dispose();
    this.boostButton.dispose();
    this.jettisonButton.dispose();
    this.canvasFire.dispose();
    this.reticle.dispose();
    this.enemyArrows.dispose();
    this.speedReadout.dispose();
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
export function isTextEntry(target: unknown): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean } | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

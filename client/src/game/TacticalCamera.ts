import {
  ArcRotateCamera,
  PointerEventTypes,
  Vector3,
  type Observer,
  type PointerInfo,
  type Scene,
  type TransformNode,
} from "@babylonjs/core";
import {
  createLogger,
  type CameraConfig,
  type ConfigService,
  type EventBus,
  type ConfigEvents,
} from "@space-arena/shared";
import {
  approachHeading,
  approachPitch,
  chaseAlphaFor,
  chaseBetaFor,
  chaseSettingsOf,
  CHASE_BETA_POLE_MARGIN,
  DEFAULT_CHASE_SETTINGS,
  type ChaseSettings,
} from "./chaseCamera.js";

const log = createLogger("TacticalCamera");

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

const CAMERA_CONFIG_ID = "camera.default";

const RIGHT_AXIS = new Vector3(1, 0, 0);
const FORWARD_AXIS = new Vector3(0, 0, 1);

/** Radians of orbit per pixel dragged in editor mode. */
const EDITOR_ORBIT_SPEED = 0.008;
/**
 * Pixels a pointer must travel before an editor drag counts as an orbit/pan.
 * Below this a press-release stays a clean tap, so `POINTERPICK` consumers
 * (the Ship Manager's socket markers, the Map editor's asteroids) still work.
 */
const EDITOR_DRAG_SLOP_PX = 4;
/** Sanity bound on how far the editor camera target can be panned (world units). */
const EDITOR_TARGET_LIMIT = 300;

/**
 * `ArcRotateCamera` rig with three modes, all fed by `camera.json` and
 * re-applied live on hot-reload:
 *
 *  - **chase** — the in-match view (FLIGHT.md §3): yaw driven by the ship's
 *    heading, beta/radius pinned to the `chase` block, no player look-around.
 *  - **editor** — the dev stage's free orbit/pan (F10).
 *  - **hangar** — a tight free orbit around a staged ship.
 *
 * Outside those it is a plain smoothed follow rig on a target `TransformNode`,
 * which is all the menu/lobby backdrop needs. The in-match free orbit + pan it
 * used to offer retired with move orders (FLIGHT.md §7): the ship owns the view
 * now, so there is no pan offset, no arena-bounds pan clamp and no look-ahead
 * bias left to maintain. `pan.sensitivity` survives because the EDITOR pans.
 */
export class TacticalCamera {
  readonly camera: ArcRotateCamera;
  private followTarget: TransformNode | null = null;
  private followLag = 0.15;
  private unsubscribe: (() => void) | null = null;

  // Scratch vectors reused every update() call — no per-frame allocations.
  private readonly scratchTargetPos = new Vector3();
  /** False until the first update() seeds the smoothed follow point. */
  private seeded = false;
  private editorMode = false;
  private hangarMode = false;
  /**
   * Chase mode (FLIGHT.md §3) — the in-match rig for the flight model. Its yaw
   * is driven by the ship instead of the player, so every look-around gesture is
   * gated off while it is active (see {@link onPointer}).
   */
  private chaseMode = false;
  private chase: ChaseSettings = DEFAULT_CHASE_SETTINGS;
  /** Latest sim heading pushed in by the render loop (radians, sim convention). */
  private chaseHeading = 0;
  /** Smoothed heading the orbit alpha is derived from; null until the first frame seeds it. */
  private chaseSmoothHeading: number | null = null;
  /** Latest sim pitch pushed in by the render loop (radians, positive climbing). */
  private chasePitch = 0;
  /** Smoothed pitch the orbit beta is derived from; null until the first frame seeds it. */
  private chaseSmoothPitch: number | null = null;
  /** Engine default FOV, captured at construction so leaving chase mode restores it. */
  private readonly defaultFov: number;
  private pointersInput: { buttons: number[] } | undefined;

  private readonly followPoint = new Vector3();
  /** Editor pan speed (`camera.pan.sensitivity`); the in-match pan is retired. */
  private panSensitivity = 1;
  /**
   * Player-level multiplier on the configured pan sensitivity (5.8 settings,
   * `sa.camera.panSens`). The config value stays the baseline — this is a
   * per-player feel adjustment layered on top of it, never a write to content.
   */
  private panSensitivityScale = 1;
  private readonly activeTouches = new Map<number, { x: number; y: number }>();
  // Editor-mode drag state: `ox/oy` is the press origin (for the tap slop test),
  // `x/y` the last processed position.
  private editorDrag: { id: number; ox: number; oy: number; x: number; y: number; button: number; moved: boolean } | null = null;
  /**
   * Camera micro-shake offset (§10 5.7), written by
   * {@link import("./juice/ScreenShake.js").ScreenShake}. Purely ADDITIVE: it is
   * applied as the last step of {@link update} and never feeds back into the
   * follow point, so a shake can't permanently displace the view.
   */
  private readonly shakeOffset = new Vector3();
  private gesturesSuspended = false;
  private pointerObserver: Observer<PointerInfo> | null = null;
  private readonly onContextMenu = (e: Event): void => e.preventDefault();
  private readonly scratchRight = new Vector3();
  private readonly scratchGroundFwd = new Vector3();

  constructor(
    private readonly scene: Scene,
    private readonly canvas: HTMLCanvasElement,
    private readonly configService: ConfigService,
    private readonly bus: EventBus<ConfigEvents>,
  ) {
    const config = configService.get<CameraConfig>("camera", CAMERA_CONFIG_ID);
    if (!config) {
      log.error(`camera config not found: ${CAMERA_CONFIG_ID}, using hardcoded fallback limits`);
    }

    this.camera = new ArcRotateCamera(
      "tacticalCamera",
      config?.alpha.default ?? -Math.PI / 2,
      config?.beta.default ?? 0.9,
      config?.radius.default ?? 55,
      Vector3.Zero(),
      scene,
    );

    this.defaultFov = this.camera.fov;
    this.chase = chaseSettingsOf(config);
    this.applyLimits(config);

    // Attach control for wheel zoom. The built-in pointers input only serves
    // the editor/hangar orbit modes (buttons set there); the editor's own
    // orbit/pan gestures are handled by this class.
    this.camera.attachControl(canvas, true);
    this.pointersInput = this.camera.inputs.attached.pointers as unknown as
      | { buttons: number[] }
      | undefined;
    if (this.pointersInput) this.pointersInput.buttons = [];

    canvas.style.touchAction = "none";
    canvas.addEventListener("contextmenu", this.onContextMenu);
    this.pointerObserver = scene.onPointerObservable.add((pi) => this.onPointer(pi));

    this.camera.wheelDeltaPercentage = 0.01;
    this.camera.pinchDeltaPercentage = 0.01;
    this.camera.inertia = 0.85;
    this.camera.panningInertia = 0.85;
    this.camera.angularSensibilityX = 800;
    this.camera.angularSensibilityY = 800;

    this.unsubscribe = this.bus.on("config:changed", (evt) => {
      if (evt.id === CAMERA_CONFIG_ID) {
        log.info("camera config hot-reloaded, re-applying limits");
        const fresh = this.configService.get<CameraConfig>("camera", CAMERA_CONFIG_ID);
        this.chase = chaseSettingsOf(fresh);
        this.applyLimits(fresh);
      }
    });
  }

  private applyLimits(config: CameraConfig | undefined): void {
    // Mode-independent feel knobs land in every mode; the orbit clamps below are
    // the tactical rig's, and the editor/hangar/chase modes each own their own.
    this.followLag = config?.followLag ?? this.followLag;
    this.panSensitivity = config?.pan?.sensitivity ?? this.panSensitivity;
    if (this.editorMode || this.hangarMode) return;
    // Chase mode owns beta/radius outright (they come from the `chase` block),
    // so the orbit limits must not be re-widened underneath it — including on
    // the way out of a mode that widened them (editor) or on hot-reload.
    if (this.chaseMode) {
      this.applyChaseLimits();
      return;
    }
    this.camera.fov = this.defaultFov;
    this.camera.lowerBetaLimit = config?.beta.min ?? 0.6;
    this.camera.upperBetaLimit = config?.beta.max ?? 1.15;
    this.camera.lowerRadiusLimit = config?.radius.min ?? 25;
    this.camera.upperRadiusLimit = config?.radius.max ?? 100;
  }

  /** Player pan-sensitivity multiplier (5.8 settings), used by the editor pan. Clamped to a sane band. */
  setPanSensitivityScale(scale: number): void {
    this.panSensitivityScale = Number.isFinite(scale) ? clamp(scale, 0.1, 5) : 1;
  }

  /** Config sensitivity × the player's local multiplier. */
  private get effectivePanSensitivity(): number {
    return this.panSensitivity * this.panSensitivityScale;
  }

  /** Follow a transform node (the player ship) with smoothed lag. */
  follow(target: TransformNode): void {
    this.followTarget = target;
    this.seeded = false;
  }

  /**
   * Set this frame's additive shake offset (world units on the arena plane).
   * Called by the shake consumer each frame; (0, 0) means "no shake".
   */
  setShakeOffset(x: number, z: number): void {
    this.shakeOffset.x = x;
    this.shakeOffset.z = z;
  }

  /** Temporarily turn the tactical rig into an unrestricted editor orbit camera. */
  setEditorMode(enabled: boolean): void {
    this.editorMode = enabled;
    this.editorDrag = null;
    this.activeTouches.clear();
    if (enabled) {
      this.followTarget = null;
      // The editor stage is not a cockpit: drop the chase block's FOV so what a
      // dev frames there matches the tactical rig. Leaving editor mode re-runs
      // applyLimits, which hands the chase FOV back if the match is still live.
      this.camera.fov = this.defaultFov;
      // Editor gestures are fully custom (see onEditorPointer): left-drag
      // orbits, right-drag pans, one finger orbits, two fingers pan + pinch.
      // The built-in pointers input stays off so it can't double-apply them;
      // only its wheel sibling (zoom) remains live.
      if (this.pointersInput) this.pointersInput.buttons = [];
      this.camera.lowerBetaLimit = 0.05;
      this.camera.upperBetaLimit = Math.PI / 2 - 0.02;
      this.camera.lowerRadiusLimit = 5;
      this.camera.upperRadiusLimit = 300;
      return;
    }
    if (this.pointersInput) this.pointersInput.buttons = [];
    this.applyLimits(this.configService.get<CameraConfig>("camera", CAMERA_CONFIG_ID));
  }

  /**
   * Hangar preview mode (ROADMAP §9 4.5): a tight free-orbit around a staged
   * ship at the origin, reusing this rig instead of a second scene/camera.
   * Enabling drops any follow target and widens orbit control to left-drag
   * (no tap-to-move to conflict with in the Hangar); disabling restores the
   * normal tactical limits and right-drag-only orbit. Does not itself re-attach
   * a follow target — callers call {@link follow} again when returning to a match.
   */
  setHangarMode(enabled: boolean): void {
    this.hangarMode = enabled;
    if (enabled) {
      this.followTarget = null;
      this.camera.lowerBetaLimit = 0.25;
      this.camera.upperBetaLimit = Math.PI / 2 - 0.05;
      this.camera.lowerRadiusLimit = 4;
      this.camera.upperRadiusLimit = 24;
      if (this.pointersInput) this.pointersInput.buttons = [0, 2];
      return;
    }
    if (this.pointersInput) this.pointersInput.buttons = [];
    this.applyLimits(this.configService.get<CameraConfig>("camera", CAMERA_CONFIG_ID));
  }

  /**
   * Chase mode (FLIGHT.md §3) — the in-match rig for the continuous-flight
   * model. It replaces the player's orbit control rather than extending it:
   *
   *  - `alpha` is derived every frame from the SHIP's heading
   *    ({@link chaseCamera.chaseAlphaFor}) after `chase.yawLag` smoothing;
   *  - `beta` is derived from the ship's PITCH ({@link chaseCamera.chaseBetaFor})
   *    after `chase.pitchLag` smoothing — the bubble's vertical half of the same
   *    idea (BUBBLE.md §C); `radius` is pinned to the `chase` block and the
   *    radius limits are collapsed onto it so wheel/pinch zoom cannot fight it;
   *  - the follow point is lifted by `chase.height` so the rig looks over the
   *    ship's shoulder instead of through it.
   *
   * Menu/editor/hangar modes are untouched.
   */
  setChaseMode(enabled: boolean): void {
    if (this.chaseMode === enabled) return;
    this.chaseMode = enabled;
    this.activeTouches.clear();
    this.chaseSmoothHeading = null;
    this.chaseSmoothPitch = null;
    if (enabled) {
      this.applyChaseLimits();
      return;
    }
    this.camera.fov = this.defaultFov;
    this.applyLimits(this.configService.get<CameraConfig>("camera", CAMERA_CONFIG_ID));
  }

  /** True while the in-match chase rig is driving the camera. */
  get isChaseMode(): boolean {
    return this.chaseMode;
  }

  /**
   * Push this frame's ship heading (radians, SIM convention: 0 = +X, growing
   * counter-clockwise). Called once per render frame from the snapshot; the
   * `yawLag` smoothing in {@link update} is what turns it into orbit alpha, so
   * the raw per-tick value is fine here.
   */
  setChaseHeading(heading: number): void {
    this.chaseHeading = heading;
  }

  /**
   * Push this frame's ship pitch (radians, sim convention: positive = climbing).
   * Called once per render frame alongside {@link setChaseHeading}; the
   * `pitchLag` smoothing in {@link update} turns it into orbit beta.
   */
  setChasePitch(pitch: number): void {
    this.chasePitch = pitch;
  }

  /**
   * Collapse the orbit clamps for chase mode. Babylon clamps `radius`/`beta`
   * inside its own per-frame `_checkLimits()`, so equal lower/upper limits is
   * what makes wheel zoom and pinch inert without detaching the inputs (the
   * wheel input is shared with the editor/hangar modes).
   *
   * Radius is pinned outright. Beta is NOT: since the bubble it follows the
   * ship's pitch (BUBBLE.md §C), so the limits open onto the full legal band and
   * {@link chaseCamera.chaseBetaFor}'s own pole margin is what bounds it. Pinning
   * beta here would have Babylon clamp every climb straight back to the base
   * tilt. Nothing is given back to the player by widening it — chase mode has no
   * beta input at all (`onPointer` returns early, and the wheel only zooms).
   *
   * `chase.fov` is optional and an ABSENT value means "keep the engine default",
   * so a null restores the captured `defaultFov` instead of leaving whatever a
   * previous config set — that is what makes deleting the key on a hot-reload
   * actually take effect.
   */
  private applyChaseLimits(): void {
    this.camera.lowerBetaLimit = CHASE_BETA_POLE_MARGIN;
    this.camera.upperBetaLimit = Math.PI - CHASE_BETA_POLE_MARGIN;
    this.camera.lowerRadiusLimit = this.chase.radius;
    this.camera.upperRadiusLimit = this.chase.radius;
    this.camera.beta = chaseBetaFor(this.chase.beta, this.chasePitch, this.chase.pitchFollow);
    this.camera.radius = this.chase.radius;
    this.camera.fov = this.chase.fov ?? this.defaultFov;
  }

  /** Snap the camera to look at `target` at the given radius/beta — used to stage the Hangar preview. */
  stageAt(target: Vector3, radius: number, alpha: number, beta: number): void {
    this.camera.target.copyFrom(target);
    this.camera.radius = radius;
    this.camera.alpha = alpha;
    this.camera.beta = beta;
  }

  /**
   * Suspend every custom camera gesture. The dev editor turns this on while a
   * transform gizmo is being dragged so the drag moves only the gizmo's mesh
   * and never the camera; any in-flight drag is dropped immediately.
   */
  setGesturesSuspended(suspended: boolean): void {
    this.gesturesSuspended = suspended;
    if (suspended) {
      this.editorDrag = null;
      this.activeTouches.clear();
    }
  }

  private onPointer(pi: PointerInfo): void {
    if (this.gesturesSuspended) return;
    // Hangar mode uses the built-in orbit input instead of these gestures.
    if (this.hangarMode) return;
    // Everything else: no look-around at all. In a match the ship owns the view
    // (chase mode, FLIGHT.md §3) and outside one there is nothing to look at, so
    // the dev editor is the only pointer-driven camera left.
    if (!this.editorMode) return;
    const ev = pi.event as PointerEvent;
    this.onEditorPointer(pi, ev, ev.pointerType === "touch");
  }

  /**
   * Editor-mode gestures. Unlike tactical mode there is no ship to follow, so
   * panning writes straight to `camera.target` rather than to an offset.
   *
   *  - mouse left-drag / one-finger drag → orbit
   *  - mouse right-drag / two-finger drag → pan (two fingers also pinch-zoom)
   *  - wheel zoom is handled by the built-in mouse-wheel input
   */
  private onEditorPointer(pi: PointerInfo, ev: PointerEvent, isTouch: boolean): void {
    if (pi.type === PointerEventTypes.POINTERDOWN) {
      if (isTouch) {
        this.activeTouches.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
        // A second finger turns the gesture into pan+pinch — drop the orbit.
        this.editorDrag =
          this.activeTouches.size === 1
            ? { id: ev.pointerId, ox: ev.clientX, oy: ev.clientY, x: ev.clientX, y: ev.clientY, button: 0, moved: false }
            : null;
        return;
      }
      this.editorDrag = { id: ev.pointerId, ox: ev.clientX, oy: ev.clientY, x: ev.clientX, y: ev.clientY, button: ev.button, moved: false };
      return;
    }

    if (pi.type === PointerEventTypes.POINTERUP) {
      this.activeTouches.delete(ev.pointerId);
      if (this.editorDrag?.id === ev.pointerId) this.editorDrag = null;
      return;
    }

    if (pi.type !== PointerEventTypes.POINTERMOVE) return;

    if (isTouch) {
      const touch = this.activeTouches.get(ev.pointerId);
      if (!touch) return;
      const [a, b] = [...this.activeTouches.values()];
      if (this.activeTouches.size === 2 && a && b) {
        // Two-finger gesture: centroid delta pans, distance ratio pinch-zooms.
        const prevCx = (a.x + b.x) / 2;
        const prevCy = (a.y + b.y) / 2;
        const prevDist = Math.hypot(a.x - b.x, a.y - b.y);
        touch.x = ev.clientX;
        touch.y = ev.clientY;
        this.panTarget((a.x + b.x) / 2 - prevCx, (a.y + b.y) / 2 - prevCy);
        const curDist = Math.hypot(a.x - b.x, a.y - b.y);
        if (prevDist > 1 && curDist > 1) this.zoomBy(prevDist / curDist);
        return;
      }
      touch.x = ev.clientX;
      touch.y = ev.clientY;
    }

    const drag = this.editorDrag;
    if (!drag || drag.id !== ev.pointerId) return;
    if (!drag.moved) {
      // Stay a tap until the pointer has clearly moved, so picking still works.
      if (Math.hypot(ev.clientX - drag.ox, ev.clientY - drag.oy) < EDITOR_DRAG_SLOP_PX) return;
      drag.moved = true;
      drag.x = ev.clientX;
      drag.y = ev.clientY;
      return;
    }
    const dx = ev.clientX - drag.x;
    const dy = ev.clientY - drag.y;
    drag.x = ev.clientX;
    drag.y = ev.clientY;
    if (drag.button === 2) this.panTarget(dx, dy);
    else this.orbitBy(dx, dy);
  }

  /** Screen-pixel drag → orbit angles, clamped to the active beta limits. */
  private orbitBy(dx: number, dy: number): void {
    this.camera.alpha -= dx * EDITOR_ORBIT_SPEED;
    this.camera.beta -= dy * EDITOR_ORBIT_SPEED;
    const lo = this.camera.lowerBetaLimit;
    const hi = this.camera.upperBetaLimit;
    if (lo !== null && this.camera.beta < lo) this.camera.beta = lo;
    if (hi !== null && this.camera.beta > hi) this.camera.beta = hi;
  }

  /**
   * Editor pan: the same screen→world mapping as {@link pan}, but applied
   * directly to the orbit target (there is no follow point to offset from) and
   * clamped to a plain sanity box instead of the arena bounds.
   */
  private panTarget(dx: number, dy: number): void {
    if (dx === 0 && dy === 0) return;
    const viewportH = this.canvas.clientHeight || 1;
    const worldPerPx =
      ((2 * this.camera.radius * Math.tan(this.camera.fov / 2)) / viewportH) * this.effectivePanSensitivity;

    this.camera.getDirectionToRef(RIGHT_AXIS, this.scratchRight);
    this.scratchRight.y = 0;
    this.scratchRight.normalize();
    this.camera.getDirectionToRef(FORWARD_AXIS, this.scratchGroundFwd);
    this.scratchGroundFwd.y = 0;
    this.scratchGroundFwd.normalize();

    // Mutated in place: `setTarget()` would recompute alpha/beta/radius and
    // fight the orbit angles we just set.
    const target = this.camera.target;
    target.x = clamp(target.x + (-this.scratchRight.x * dx + this.scratchGroundFwd.x * dy) * worldPerPx, -EDITOR_TARGET_LIMIT, EDITOR_TARGET_LIMIT);
    target.z = clamp(target.z + (-this.scratchRight.z * dx + this.scratchGroundFwd.z * dy) * worldPerPx, -EDITOR_TARGET_LIMIT, EDITOR_TARGET_LIMIT);
  }

  /** Multiply the orbit radius (pinch), clamped to the configured zoom limits. */
  private zoomBy(factor: number): void {
    const r = this.camera.radius * factor;
    const lo = this.camera.lowerRadiusLimit ?? r;
    const hi = this.camera.upperRadiusLimit ?? r;
    this.camera.radius = Math.min(hi, Math.max(lo, r));
  }

  /** Call once per render frame. `dt` in seconds. No allocations. */
  update(dt: number): void {
    if (!this.followTarget) return;

    this.scratchTargetPos.copyFrom(this.followTarget.position);
    if (!this.seeded) {
      this.seeded = true;
      this.followPoint.copyFrom(this.scratchTargetPos);
    }

    // Exponential smoothing toward the followed ship, frame-rate independent.
    const t = 1 - Math.pow(1 - this.followLag, dt * 60);
    Vector3.LerpToRef(this.followPoint, this.scratchTargetPos, t, this.followPoint);

    if (this.chaseMode) {
      // Orbit angle from the SHIP, smoothed with `yawLag` (mutated in place; no
      // allocation and no setTarget(), which would recompute alpha/beta/radius
      // from the position and undo exactly what we just set).
      this.chaseSmoothHeading =
        this.chaseSmoothHeading === null
          ? this.chaseHeading
          : approachHeading(this.chaseSmoothHeading, this.chaseHeading, this.chase.yawLag, dt);
      this.camera.alpha = chaseAlphaFor(this.chaseSmoothHeading);
      // Tilt follows the ship's pitch the same way (BUBBLE.md §C), on its own lag
      // and WITHOUT the shortest-way-round step — pitch does not wrap.
      this.chaseSmoothPitch =
        this.chaseSmoothPitch === null
          ? this.chasePitch
          : approachPitch(this.chaseSmoothPitch, this.chasePitch, this.chase.pitchLag, dt);
      // Re-asserted every frame so a hot-reloaded chase block applies live.
      this.camera.beta = chaseBetaFor(this.chase.beta, this.chaseSmoothPitch, this.chase.pitchFollow);
      this.camera.radius = this.chase.radius;
      this.camera.target.copyFrom(this.followPoint);
      this.camera.target.y += this.chase.height;
      // No arena-bounds clamp: the target IS the ship, so it is inside the
      // bounds by construction.
    } else {
      this.camera.target.copyFrom(this.followPoint);
    }

    // Shake rides LAST and outside the clamp bookkeeping above: it is a
    // per-frame decoration on the final target, never part of the pan state.
    if (this.shakeOffset.x !== 0 || this.shakeOffset.z !== 0) {
      this.camera.target.x += this.shakeOffset.x;
      this.camera.target.z += this.shakeOffset.z;
    }
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.pointerObserver) this.scene.onPointerObservable.remove(this.pointerObserver);
    this.pointerObserver = null;
    this.canvas.removeEventListener("contextmenu", this.onContextMenu);
    this.camera.dispose();
  }
}

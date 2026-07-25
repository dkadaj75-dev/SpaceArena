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
  type TuningConfig,
} from "@space-arena/shared";
import { shouldRejectContact } from "./inputGuards.js";
import {
  approachHeading,
  chaseAlphaFor,
  chaseSettingsOf,
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
 * `ArcRotateCamera` rig for the 3/4 tactical view (§2.1). Limits/speeds come
 * from `camera.json`; the rig smoothly follows a target `TransformNode`
 * (the player ship) with a look-ahead bias, and re-applies live on hot-reload.
 */
export class TacticalCamera {
  readonly camera: ArcRotateCamera;
  private followTarget: TransformNode | null = null;
  private followLag = 0.15;
  private lookAhead = 6;
  private unsubscribe: (() => void) | null = null;

  // Scratch vectors reused every update() call — no per-frame allocations.
  private readonly scratchTargetPos = new Vector3();
  private readonly scratchForward = new Vector3();
  private previousTargetPos: Vector3 | null = null;
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
  /** Engine default FOV, captured at construction so leaving chase mode restores it. */
  private readonly defaultFov: number;
  private pointersInput: { buttons: number[] } | undefined;

  // Tactical-mode pan/pinch gesture state (right-drag on desktop, two-finger
  // on touch). The pan is an offset ON TOP of the follow point, so the camera
  // keeps tracking the ship while the player looks around the arena.
  private readonly panOffset = new Vector3();
  private readonly followPoint = new Vector3();
  private panSensitivity = 1;
  /**
   * Player-level multiplier on the configured pan sensitivity (5.8 settings,
   * `sa.camera.panSens`). The config value stays the baseline — this is a
   * per-player feel adjustment layered on top of it, never a write to content.
   */
  private panSensitivityScale = 1;
  private panBoundsMargin = 10;
  private panBoundsRadius = 90;
  private readonly activeTouches = new Map<number, { x: number; y: number }>();
  private rightDrag: { x: number; y: number } | null = null;
  // Editor-mode drag state: `ox/oy` is the press origin (for the tap slop test),
  // `x/y` the last processed position.
  private editorDrag: { id: number; ox: number; oy: number; x: number; y: number; button: number; moved: boolean } | null = null;
  /**
   * Camera micro-shake offset (§10 5.7), written by
   * {@link import("./juice/ScreenShake.js").ScreenShake}. Purely ADDITIVE: it is
   * applied as the last step of {@link update} and never feeds back into
   * `panOffset` or the follow point, so a shake can't fight (or permanently
   * displace) the player's pan.
   */
  private readonly shakeOffset = new Vector3();
  private gesturesSuspended = false;
  /** Palm-rejection margin (`tuning.edgeRejectMarginPx`), shared with OrderInput. */
  private edgeRejectMarginPx = 0;
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
    // the editor/hangar orbit modes (buttons set there); in tactical mode all
    // pointer gestures are handled by this class: right-drag pans, two-finger
    // drag pans + pinches, and left click/tap stays 100% free for gameplay.
    this.camera.attachControl(canvas, true);
    this.pointersInput = this.camera.inputs.attached.pointers as unknown as
      | { buttons: number[] }
      | undefined;
    if (this.pointersInput) this.pointersInput.buttons = [];

    this.edgeRejectMarginPx = configService.getAll<TuningConfig>("tuning")[0]?.edgeRejectMarginPx ?? 0;

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
    this.lookAhead = config?.lookAhead ?? this.lookAhead;
    this.panSensitivity = config?.pan?.sensitivity ?? this.panSensitivity;
    this.panBoundsMargin = config?.pan?.boundsMargin ?? this.panBoundsMargin;
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

  /** Player pan-sensitivity multiplier (5.8 settings). Clamped to a sane band. */
  setPanSensitivityScale(scale: number): void {
    this.panSensitivityScale = Number.isFinite(scale) ? clamp(scale, 0.1, 5) : 1;
  }

  /** Config sensitivity × the player's local multiplier. */
  private get effectivePanSensitivity(): number {
    return this.panSensitivity * this.panSensitivityScale;
  }

  /** Arena bounds radius clamping how far the view target can pan (world units). */
  setPanBounds(radius: number): void {
    this.panBoundsRadius = radius;
  }

  /** Follow a transform node (the player ship) with smoothed lag + look-ahead. */
  follow(target: TransformNode): void {
    this.followTarget = target;
    this.previousTargetPos = null;
    this.panOffset.setAll(0);
  }

  /** Recenter the view on the followed ship (clears any user pan). */
  recenter(): void {
    this.panOffset.setAll(0);
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
    this.rightDrag = null;
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
   *  - `beta`/`radius` are pinned to the `chase` block, and the orbit limits are
   *    collapsed onto those values so wheel/pinch zoom cannot fight them;
   *  - the follow point is lifted by `chase.height` so the rig looks over the
   *    ship's shoulder instead of through it;
   *  - every look-around gesture (right-drag / two-finger pan + pinch) is gated
   *    off in {@link onPointer}, and any pan already accumulated is dropped.
   *
   * Menu/editor/hangar modes are untouched — this is purely the third in-match
   * alternative to the (now retiring) free tactical orbit.
   */
  setChaseMode(enabled: boolean): void {
    if (this.chaseMode === enabled) return;
    this.chaseMode = enabled;
    this.activeTouches.clear();
    this.rightDrag = null;
    this.panOffset.setAll(0);
    this.chaseSmoothHeading = null;
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
   * Collapse the orbit clamps onto the chase block's beta/radius. Babylon clamps
   * `radius`/`beta` inside its own input handling, so equal lower/upper limits
   * is what makes wheel zoom and pinch inert without detaching the inputs (the
   * wheel input is shared with the editor/hangar modes).
   */
  private applyChaseLimits(): void {
    this.camera.lowerBetaLimit = this.chase.beta;
    this.camera.upperBetaLimit = this.chase.beta;
    this.camera.lowerRadiusLimit = this.chase.radius;
    this.camera.upperRadiusLimit = this.chase.radius;
    this.camera.beta = this.chase.beta;
    this.camera.radius = this.chase.radius;
    if (this.chase.fov !== null) this.camera.fov = this.chase.fov;
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
      this.rightDrag = null;
      this.activeTouches.clear();
    }
  }

  private onPointer(pi: PointerInfo): void {
    if (this.gesturesSuspended) return;
    // Hangar mode uses the built-in orbit input instead of these gestures.
    if (this.hangarMode) return;
    const ev = pi.event as PointerEvent;
    const isTouch = ev.pointerType === "touch";
    // Editor mode is checked BEFORE the chase gate: F10 can open the editor over
    // a live (paused) match, and its stage still needs orbit/pan gestures.
    if (this.editorMode) {
      this.onEditorPointer(pi, ev, isTouch);
      return;
    }
    // Chase mode (FLIGHT.md §3): the ship owns the view. Pan/pinch would either
    // fight the heading-driven yaw or slide the ship out of frame, so the whole
    // gesture path is gated off — the code stays for the menu/editor rigs.
    if (this.chaseMode) return;

    if (pi.type === PointerEventTypes.POINTERDOWN) {
      if (isTouch) {
        // Palm rejection (5.4): a bezel contact must not become half of a
        // two-finger pan/pinch either, or a resting palm would make every
        // one-finger gameplay touch drag the camera.
        if (this.isPalm(ev)) return;
        this.activeTouches.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      } else if (ev.button === 2) {
        this.rightDrag = { x: ev.clientX, y: ev.clientY };
      }
    } else if (pi.type === PointerEventTypes.POINTERMOVE) {
      if (!isTouch && this.rightDrag) {
        this.pan(ev.clientX - this.rightDrag.x, ev.clientY - this.rightDrag.y);
        this.rightDrag.x = ev.clientX;
        this.rightDrag.y = ev.clientY;
        return;
      }
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
        this.pan((a.x + b.x) / 2 - prevCx, (a.y + b.y) / 2 - prevCy);
        const curDist = Math.hypot(a.x - b.x, a.y - b.y);
        if (prevDist > 1 && curDist > 1) this.zoomBy(prevDist / curDist);
      } else {
        touch.x = ev.clientX;
        touch.y = ev.clientY;
      }
    } else if (pi.type === PointerEventTypes.POINTERUP) {
      this.activeTouches.delete(ev.pointerId);
      if (!isTouch && ev.button === 2) this.rightDrag = null;
    }
  }

  /**
   * Edge palm rejection for tactical-mode touch gestures. Editor mode is
   * deliberately exempt: it is a dev tool whose own gizmo/marker handles live
   * right against the panel edges.
   */
  private isPalm(ev: PointerEvent): boolean {
    if (this.edgeRejectMarginPx <= 0) return false;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    return shouldRejectContact(
      ev.clientX,
      ev.clientY,
      ev.target,
      { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      this.edgeRejectMarginPx,
    );
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

  /** Screen-pixel drag → world-space pan offset ("grab the world": content follows the pointer). */
  private pan(dx: number, dy: number): void {
    if (dx === 0 && dy === 0) return;
    const viewportH = this.canvas.clientHeight || 1;
    const worldPerPx =
      ((2 * this.camera.radius * Math.tan(this.camera.fov / 2)) / viewportH) * this.effectivePanSensitivity;

    // Camera axes flattened onto the arena plane: screen-x maps to `right`,
    // screen-y to the view direction with tilt removed.
    this.camera.getDirectionToRef(RIGHT_AXIS, this.scratchRight);
    this.scratchRight.y = 0;
    this.scratchRight.normalize();
    this.camera.getDirectionToRef(FORWARD_AXIS, this.scratchGroundFwd);
    this.scratchGroundFwd.y = 0;
    this.scratchGroundFwd.normalize();

    this.panOffset.x += (-this.scratchRight.x * dx + this.scratchGroundFwd.x * dy) * worldPerPx;
    this.panOffset.z += (-this.scratchRight.z * dx + this.scratchGroundFwd.z * dy) * worldPerPx;
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

    // Look-ahead: bias the followed point along the ship's recent travel
    // direction. Skipped while chasing — the rig already looks down the ship's
    // heading, so biasing the target along the same vector would only shove the
    // ship down the frame (`chase.height` is the knob for framing there).
    if (this.previousTargetPos && !this.chaseMode) {
      this.scratchForward
        .copyFrom(this.scratchTargetPos)
        .subtractInPlace(this.previousTargetPos);
      const speed = this.scratchForward.length();
      if (speed > 1e-4) {
        this.scratchForward.normalize().scaleInPlace(this.lookAhead);
        this.scratchTargetPos.addInPlace(this.scratchForward);
      }
    }

    if (!this.previousTargetPos) {
      this.previousTargetPos = new Vector3();
      this.followPoint.copyFrom(this.scratchTargetPos);
    }
    this.previousTargetPos.copyFrom(this.followTarget.position);

    // Exponential smoothing toward the look-ahead-biased target, frame-rate independent.
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
      // Re-asserted every frame so a hot-reloaded chase block applies live.
      this.camera.beta = this.chase.beta;
      this.camera.radius = this.chase.radius;
      this.camera.target.copyFrom(this.followPoint);
      this.camera.target.y += this.chase.height;
      // No pan offset and no arena-bounds clamp here: the target IS the ship, so
      // it is inside the bounds by construction, and clamping it would push the
      // camera off the ship near the arena edge.
    } else {
      // User pan rides on top of the follow point, clamped to the arena bounds.
      this.camera.target.copyFrom(this.followPoint).addInPlace(this.panOffset);
      const maxR = this.panBoundsRadius + this.panBoundsMargin;
      const len = Math.hypot(this.camera.target.x, this.camera.target.z);
      if (len > maxR) {
        const s = maxR / len;
        this.camera.target.x *= s;
        this.camera.target.z *= s;
        // Re-derive the offset from the clamped target so panning back in
        // responds immediately instead of unwinding invisible overshoot.
        this.panOffset.copyFrom(this.camera.target).subtractInPlace(this.followPoint);
      }
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

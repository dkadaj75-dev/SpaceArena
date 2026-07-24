import {
  ArcRotateCamera,
  PointerEventTypes,
  Vector3,
  type Observer,
  type PointerInfo,
  type Scene,
  type TransformNode,
} from "@babylonjs/core";
import { createLogger, type CameraConfig, type ConfigService, type EventBus, type ConfigEvents } from "@space-arena/shared";

const log = createLogger("TacticalCamera");

const CAMERA_CONFIG_ID = "camera.default";

const RIGHT_AXIS = new Vector3(1, 0, 0);
const FORWARD_AXIS = new Vector3(0, 0, 1);

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
  private pointersInput: { buttons: number[] } | undefined;

  // Tactical-mode pan/pinch gesture state (right-drag on desktop, two-finger
  // on touch). The pan is an offset ON TOP of the follow point, so the camera
  // keeps tracking the ship while the player looks around the arena.
  private readonly panOffset = new Vector3();
  private readonly followPoint = new Vector3();
  private panSensitivity = 1;
  private panBoundsMargin = 10;
  private panBoundsRadius = 90;
  private readonly activeTouches = new Map<number, { x: number; y: number }>();
  private rightDrag: { x: number; y: number } | null = null;
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
        this.applyLimits(fresh);
      }
    });
  }

  private applyLimits(config: CameraConfig | undefined): void {
    if (this.editorMode || this.hangarMode) return;
    this.camera.lowerBetaLimit = config?.beta.min ?? 0.6;
    this.camera.upperBetaLimit = config?.beta.max ?? 1.15;
    this.camera.lowerRadiusLimit = config?.radius.min ?? 25;
    this.camera.upperRadiusLimit = config?.radius.max ?? 100;
    this.followLag = config?.followLag ?? this.followLag;
    this.lookAhead = config?.lookAhead ?? this.lookAhead;
    this.panSensitivity = config?.pan?.sensitivity ?? 1;
    this.panBoundsMargin = config?.pan?.boundsMargin ?? 10;
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

  /** Temporarily turn the tactical rig into an unrestricted editor orbit camera. */
  setEditorMode(enabled: boolean): void {
    this.editorMode = enabled;
    if (enabled) {
      this.followTarget = null;
      if (this.pointersInput) this.pointersInput.buttons = [2];
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

  /** Snap the camera to look at `target` at the given radius/beta — used to stage the Hangar preview. */
  stageAt(target: Vector3, radius: number, alpha: number, beta: number): void {
    this.camera.target.copyFrom(target);
    this.camera.radius = radius;
    this.camera.alpha = alpha;
    this.camera.beta = beta;
  }

  private onPointer(pi: PointerInfo): void {
    // Editor/hangar modes use the built-in orbit input instead of these gestures.
    if (this.editorMode || this.hangarMode) return;
    const ev = pi.event as PointerEvent;
    const isTouch = ev.pointerType === "touch";

    if (pi.type === PointerEventTypes.POINTERDOWN) {
      if (isTouch) {
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

  /** Screen-pixel drag → world-space pan offset ("grab the world": content follows the pointer). */
  private pan(dx: number, dy: number): void {
    if (dx === 0 && dy === 0) return;
    const viewportH = this.canvas.clientHeight || 1;
    const worldPerPx =
      ((2 * this.camera.radius * Math.tan(this.camera.fov / 2)) / viewportH) * this.panSensitivity;

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

    // Look-ahead: bias the followed point along the ship's recent travel direction.
    if (this.previousTargetPos) {
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

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.pointerObserver) this.scene.onPointerObservable.remove(this.pointerObserver);
    this.pointerObserver = null;
    this.canvas.removeEventListener("contextmenu", this.onContextMenu);
    this.camera.dispose();
  }
}
